// ==UserScript==
// @name         OpenTableBot
// @match        https://www.opentable.com/*
// @match        https://cdn.otstatic.com/maintenance/busy/index.html
// @version      0.1
// @description  get your reservation when others cancel
// @author       Nohren
// @grant        window.close
// @grant        GM.setValue
// @grant        GM.getValue
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  const ENABLE_EMAIL = false;
  const AUTO_BOOK = true;
  const TARGET_WINDOW_START = "6:00 PM";
  const TARGET_WINDOW_END = "8:00 PM";
  const minCheckTime = 45000;
  const maxCheckTime = 60000 * 2;
  const BUSY_BASE_WAIT_MS = 1000 * 60 * 5;
  const BUSY_BACKOFF_MULTIPLIER = 2;
  const BUSY_MAX_WAIT_MS = 1000 * 60 * 30;
  const COMPLETE_RETRY_INTERVAL_MS = 500;
  const COMPLETE_RETRY_TIMEOUT_MS = 15000;
  const SEATING_OPTIONS_PATH = "/booking/seating-options";
  const TIME_SLOT_CONTAINER_SELECTORS = [
    "[data-test='time-slots']",
    "[data-testid='time-slots']",
    "ul[aria-label*='Available time slots']",
    "[data-test*='time-slots']",
    "[data-testid*='time-slots']",
  ];
  const TIME_SLOT_BUTTON_SELECTORS = [
    "li[data-test^='time-slot'] > a[role='button'][aria-label^='Reserve table at']",
    "li[data-testid^='time-slot'] > a[role='button'][aria-label^='Reserve table at']",
    "[data-test='time-slots'] a[role='button'][aria-label^='Reserve table at']",
    "[data-testid='time-slots'] a[role='button'][aria-label^='Reserve table at']",
    "a[role='button'][aria-label^='Reserve table at']",
    "a[aria-label^='Reserve table at']",
  ];
  const COMPLETE_RESERVATION_BUTTON_SELECTORS = [
    "#complete-reservation",
    "button#complete-reservation[type='submit']",
    "button[data-test='complete-reservation-button'][type='submit']",
    "[data-test='complete-reservation-button']",
    "[data-testid='complete-reservation-button']",
    "button[data-test*='complete-reservation']",
    "button[data-testid*='complete-reservation']",
    "button[data-test*='book']",
    "button[data-testid*='book']",
    "button[data-test*='reserve']",
    "button[data-testid*='reserve']",
    "button[type='submit'][aria-label*='complete' i]",
    "button[type='submit'][data-test*='complete']",
    "button[type='submit']",
  ];
  const SEATING_OPTION_SELECTORS = [
    "[data-test*='seating-option'] [role='button']",
    "[data-testid*='seating-option'] [role='button']",
    "[data-test*='seating-option'] button",
    "[data-testid*='seating-option'] button",
    "[data-test*='seating-option'] a[role='button']",
    "[data-testid*='seating-option'] a[role='button']",
    "button[aria-label*='seating' i]",
    "a[role='button'][aria-label*='seating' i]",
  ];
  const SEATING_CONTINUE_BUTTON_SELECTORS = [
    "button[data-test*='continue']",
    "button[data-testid*='continue']",
    "button[data-test*='next']",
    "button[data-testid*='next']",
    "button[data-test*='reserve']",
    "button[data-testid*='reserve']",
    "button[data-test*='book']",
    "button[data-testid*='book']",
    "button[type='submit']",
    "button",
    "a[role='button']",
  ];
  const RESTAURANT_PAGE_MARKER_SELECTORS = [
    "[data-testid='restaurant-banner-content-container']",
    "[data-testid='restaurant-name']",
    "[data-test='restaurant-name']",
    "[data-test='time-slots']",
    "[data-testid='time-slots']",
  ];

  function queryFirst(selectors, root = document) {
    for (const selector of selectors) {
      const match = root.querySelector(selector);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function queryAllFromFirstMatch(selectors, root = document) {
    for (const selector of selectors) {
      const matches = root.querySelectorAll(selector);
      if (matches.length > 0) {
        return Array.from(matches);
      }
    }
    return [];
  }

  function parseTimeToMinutes(timeText) {
    const match = String(timeText || "")
      .trim()
      .match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (!match) {
      return null;
    }

    let hours = Number(match[1]);
    const minutes = Number(match[2] || 0);
    const meridiem = match[3].toUpperCase();

    if (meridiem === "PM" && hours !== 12) {
      hours += 12;
    }
    if (meridiem === "AM" && hours === 12) {
      hours = 0;
    }

    return hours * 60 + minutes;
  }

  function getElementSearchText(element) {
    if (!element) {
      return "";
    }

    return [
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-test"),
      element.getAttribute("data-testid"),
      element.className,
      element.id,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  function isElementVisible(element) {
    if (!element) {
      return false;
    }
    return !!(
      element.offsetWidth ||
      element.offsetHeight ||
      element.getClientRects().length
    );
  }

  function isElementDisabled(element) {
    if (!element) {
      return true;
    }
    return (
      element.disabled ||
      String(element.getAttribute("aria-disabled")).toLowerCase() === "true"
    );
  }

  function isCookieOrConsentElement(element) {
    const searchText = getElementSearchText(element).toLowerCase();
    return (
      searchText.includes("onetrust") ||
      searchText.includes("cookie") ||
      searchText.includes("consent") ||
      searchText.includes("privacy") ||
      searchText.includes("confirm my choices")
    );
  }

  function findFirstMatchingElement(selectors, predicate, root = document) {
    for (const selector of selectors) {
      const matches = Array.from(root.querySelectorAll(selector));
      const validMatch = matches.find((candidate) => predicate(candidate));
      if (validMatch) {
        return validMatch;
      }
    }
    return null;
  }

  function isLikelySeatingChoiceElement(element) {
    if (
      !element ||
      isElementDisabled(element) ||
      !isElementVisible(element) ||
      isCookieOrConsentElement(element)
    ) {
      return false;
    }

    const searchText = getElementSearchText(element).toLowerCase();
    return (
      searchText.includes("seating-option") ||
      /\b(standard|counter|bar|patio|outdoor|indoor|dining|high top|low top|table)\b/i.test(
        searchText
      )
    );
  }

  function isLikelyContinueButton(element) {
    if (
      !element ||
      isElementDisabled(element) ||
      !isElementVisible(element) ||
      isCookieOrConsentElement(element)
    ) {
      return false;
    }

    const searchText = getElementSearchText(element).toLowerCase();
    return /\b(continue|next|reserve|book|confirm|checkout|review)\b/i.test(
      searchText
    );
  }

  function isLikelyCompleteReservationButton(element) {
    if (
      !element ||
      isElementDisabled(element) ||
      !isElementVisible(element) ||
      isCookieOrConsentElement(element)
    ) {
      return false;
    }

    const searchText = getElementSearchText(element).toLowerCase();
    if (
      element.id === "complete-reservation" ||
      element.getAttribute("data-test") === "complete-reservation-button"
    ) {
      return true;
    }

    return /\b(complete reservation|complete|reserve|book|confirm reservation|place booking|checkout)\b/i.test(
      searchText
    );
  }

  function isSeatingOptionsPage() {
    return window.location.pathname === SEATING_OPTIONS_PATH;
  }

  function isReservationSlotElement(element) {
    const label = element?.ariaLabel?.trim();
    if (!label) {
      return false;
    }

    return /^Reserve table at /i.test(label) && /for a party of/i.test(label);
  }

  function isWithinTargetWindow(slotTimeText) {
    const slotMinutes = parseTimeToMinutes(slotTimeText);
    const windowStart = parseTimeToMinutes(TARGET_WINDOW_START);
    const windowEnd = parseTimeToMinutes(TARGET_WINDOW_END);

    if (
      slotMinutes === null ||
      windowStart === null ||
      windowEnd === null
    ) {
      return false;
    }

    // Supports same-day windows (e.g. 6 PM to 8 PM) and overnight windows.
    if (windowStart <= windowEnd) {
      return slotMinutes >= windowStart && slotMinutes <= windowEnd;
    }
    return slotMinutes >= windowStart || slotMinutes <= windowEnd;
  }

  function findSlotButton(slotContainer) {
    const explicit = queryFirst(TIME_SLOT_BUTTON_SELECTORS, slotContainer);
    if (isReservationSlotElement(explicit)) {
      return explicit;
    }

    const firstElement = slotContainer?.firstElementChild;
    if (isReservationSlotElement(firstElement)) {
      return firstElement;
    }

    return null;
  }

  function getSlotButtons() {
    const slotContainer = queryFirst(TIME_SLOT_CONTAINER_SELECTORS);

    if (slotContainer) {
      const buttonsFromContainer = [];
      for (const child of slotContainer.children ?? []) {
        const slotButton = findSlotButton(child);
        if (isReservationSlotElement(slotButton)) {
          buttonsFromContainer.push(slotButton);
        }
      }
      if (buttonsFromContainer.length > 0) {
        return buttonsFromContainer;
      }
    }

    // Fallback scan if OpenTable changes slot container structure.
    return queryAllFromFirstMatch(TIME_SLOT_BUTTON_SELECTORS).filter(
      (candidate) => isReservationSlotElement(candidate)
    );
  }

  function isRestaurantPage() {
    return (
      /\/r\/[a-zA-Z0-9-]+/.test(window.location.pathname) ||
      !!queryFirst(RESTAURANT_PAGE_MARKER_SELECTORS)
    );
  }

  async function resetBusyBackoff() {
    await GM.setValue("busyWaitMs", BUSY_BASE_WAIT_MS);
  }

  async function getCurrentAndIncrementBusyBackoff() {
    const current = await GM.getValue("busyWaitMs", BUSY_BASE_WAIT_MS);
    const next = Math.min(current * BUSY_BACKOFF_MULTIPLIER, BUSY_MAX_WAIT_MS);
    await GM.setValue("busyWaitMs", next);
    return current;
  }

  async function sendEmail(message, href) {
    if (!ENABLE_EMAIL) {
      return;
    }

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, href }),
    };
    try {
      const response = await fetch(
        "http://localhost:8080/reservation",
        options
      );
      !response.ok
        ? console.log("Email send failed")
        : console.log("Email send success!");
      const data = await response.json();
      console.log(data);
    } catch (e) {
      console.log("Failed to send data to server", e);
    }
  }

   function minAndSec(ms) {
     const val = ms / 1000 / 60
     const min = Math.floor(val)
     const sec = Math.round((val - min) * 60)
     return `${min} min and ${sec} seconds`
  }

  function startCheckingAgain() {
    const randomInterval = randomIntervalFunc();
    console.log(
      `checking again in ${minAndSec(randomInterval)}`
    );
    setTimeout(() => window.location.reload(), randomInterval);
  }

  function randomIntervalFunc() {
    const lower = Math.min(minCheckTime, maxCheckTime);
    const upper = Math.max(minCheckTime, maxCheckTime);
    return Math.floor(lower + Math.random() * (upper - lower));
  }

  //results are within 2.5 hrs of reservation
  async function checkForTimeSlots() {
    console.log("checking for time slots");
    let result;
    //wait for XHR to load
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const slotButtons = getSlotButtons();
    let earliestMatch = null;

    if (!slotButtons.length) {
      console.log("no time slot buttons found with current selectors");
    }

    for (const slotButton of slotButtons) {
      const slotTimeText = slotButton?.innerText?.trim() || "";
      const slotMinutes = parseTimeToMinutes(slotTimeText);

      if (slotButton?.ariaLabel && isWithinTargetWindow(slotTimeText)) {
        if (
          !earliestMatch ||
          (slotMinutes !== null && slotMinutes < earliestMatch.slotMinutes)
        ) {
          earliestMatch = {
            slotButton,
            slotMinutes: slotMinutes ?? Number.POSITIVE_INFINITY,
          };
        }
      } else if (slotButton?.ariaLabel) {
        console.log(
          `skipping ${slotTimeText} - outside target window ${TARGET_WINDOW_START} to ${TARGET_WINDOW_END}`
        );
      }
    }

    if (earliestMatch) {
      result = `Reservation found! - ${new Date()}`;
      const message = `Reservation available at ${earliestMatch.slotButton.innerText}: ${earliestMatch.slotButton.ariaLabel}`;
      sendEmail(message, earliestMatch.slotButton.href);
      if (AUTO_BOOK) {
        console.log(`attempting earliest matching slot: ${earliestMatch.slotButton.innerText}`);
        earliestMatch.slotButton.click();
      } else {
        console.log(`AUTO_BOOK disabled. Matching slot found: ${earliestMatch.slotButton.innerText}`);
      }
    }

    console.log(result ?? `no reservation found - ${new Date()}`);

    // check again in next interval if no result
    if (!result || !AUTO_BOOK) {
       try {
        startCheckingAgain();
       } catch (error) {
        console.error("Error while restarting the check:", error);
       }
    }
  }

  async function findCompleteReservationButton() {
    const start = Date.now();
    while (Date.now() - start < COMPLETE_RETRY_TIMEOUT_MS) {
      const completeReservationButton = findFirstMatchingElement(
        COMPLETE_RESERVATION_BUTTON_SELECTORS,
        isLikelyCompleteReservationButton,
        document.querySelector("main") || document
      );
      if (completeReservationButton) {
        return completeReservationButton;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COMPLETE_RETRY_INTERVAL_MS)
      );
    }
    return null;
  }

  async function completeReservation() {
    console.log("booking page");
    const completeReservationButton = await findCompleteReservationButton();
    if (!completeReservationButton) {
      console.log("complete reservation button not found in retry window");
      return;
    }

    if (AUTO_BOOK) {
      console.log("clicking complete reservation button");
      completeReservationButton.click();
    } else {
      console.log("AUTO_BOOK disabled. Not clicking complete reservation button.");
    }
  }

  async function selectAnySeatingOptionAndContinue() {
    console.log("seating options page");
    const root = document.querySelector("main") || document;
    const start = Date.now();

    while (Date.now() - start < COMPLETE_RETRY_TIMEOUT_MS) {
      const continueButton = findFirstMatchingElement(
        SEATING_CONTINUE_BUTTON_SELECTORS,
        isLikelyContinueButton,
        root
      );
      if (continueButton) {
        if (AUTO_BOOK) {
          console.log("continuing from seating options page");
          continueButton.click();
        } else {
          console.log("AUTO_BOOK disabled. Continue button found on seating options page.");
        }
        return;
      }

      const seatingChoice = findFirstMatchingElement(
        SEATING_OPTION_SELECTORS,
        isLikelySeatingChoiceElement,
        root
      );
      if (seatingChoice) {
        if (AUTO_BOOK) {
          const choiceText =
            seatingChoice.innerText?.trim() ||
            seatingChoice.getAttribute("aria-label") ||
            "unknown option";
          console.log(`selecting seating option: ${choiceText}`);
          seatingChoice.click();
        } else {
          console.log("AUTO_BOOK disabled. Seating option found.");
        }
      }

      await new Promise((resolve) =>
        setTimeout(resolve, COMPLETE_RETRY_INTERVAL_MS)
      );
    }

    console.log("seating options were not actionable in retry window");
  }

 async function kickedOut(wait) {
    const url = await GM.getValue("url", null);
    const retryWait = wait ?? (await getCurrentAndIncrementBusyBackoff());
    if (!url) {
        console.log(`no url to back to ${url}`);
        sendEmail('Got kicked out, no url to go back to!', window.location.href)
        return
    }
    console.log(`got kicked out. Will try again in ${minAndSec(retryWait)}`)
    console.log(url)
    setTimeout(() => {
      window.location.assign(url)
    }, retryWait)
 }

 function execute(func) {
     //somtimes user script is injected after the page is loaded, and sometimes before.
     if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", func);
     } else {
          func();
     }
 }

  const el = document.createElement("div");
  el.style.position = "relative";
  el.style.textAlign = "center";
  el.style.fontWeight = "bold";
  el.style.fontSize = "xx-large";
  el.innerText = "🤖 Agent Running";
  el.style.backgroundColor = "lime";

  switch (true) {
      case isRestaurantPage():
          resetBusyBackoff();
          GM.setValue("url", window.location.href);
          console.log(`set url as ${window.location.href}`)
          execute(checkForTimeSlots)
          break
      case window.location.pathname === "/maintenance/busy/index.html":
          console.log('kicked out');
          execute(kickedOut)
          break
      case isSeatingOptionsPage():
          resetBusyBackoff();
          execute(selectAnySeatingOptionAndContinue)
          break
      case window.location.pathname === "/booking/details": 
          resetBusyBackoff();
          execute(completeReservation)
          break
      default:
        console.log('default case');
        el.innerText = "🤖 Armed";
        el.style.backgroundColor = "yellow";
  }

  document.body.prepend(el);
})();
