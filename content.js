/* global MapsExtractorUtils */

// Guard against double-injection: the manifest's content_scripts auto-loads
// this file on Maps pages, and popup.js may also re-inject it via
// chrome.scripting.executeScript when the message port is closed.
// Without this guard, `const extractorState` below throws
// "Identifier 'extractorState' has already been declared".
if (window.__mapsExtractorContentLoaded__) {
  // Already loaded once on this page; do nothing.
} else {
  window.__mapsExtractorContentLoaded__ = true;

const extractorState = {
  running: false,
  stopRequested: false
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OVERLAY_ID = "maps-extractor-overlay";

function upsertOverlay(statusText) {
  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.position = "fixed";
    overlay.style.top = "12px";
    overlay.style.right = "12px";
    overlay.style.zIndex = "2147483647";
    overlay.style.background = "#111827";
    overlay.style.color = "#ffffff";
    overlay.style.padding = "10px 12px";
    overlay.style.borderRadius = "8px";
    overlay.style.fontSize = "12px";
    overlay.style.fontFamily = "Arial, sans-serif";
    overlay.style.boxShadow = "0 4px 12px rgba(0,0,0,0.25)";
    overlay.style.maxWidth = "320px";
    overlay.style.lineHeight = "1.4";
    document.body.appendChild(overlay);
  }
  overlay.textContent = statusText;
}

function sendProgress(payload) {
  upsertOverlay(
    payload?.stage === "running"
      ? `Maps Extractor (runs in background): ${payload.extracted || 0} extracted (${payload.processed || 0}/${payload.cardsTotal || 0}) — keep this Maps tab open`
      : payload?.stage === "start"
        ? "Maps Extractor: started… Keep this Google Maps tab open. You may switch to other tabs/windows."
        : payload?.stage === "done"
          ? "Maps Extractor: finished"
          : "Maps Extractor"
  );

  chrome.runtime.sendMessage({ action: "extractionProgress", ...payload }).catch(() => {});
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitForElement(selector, timeoutMs = 7000, root = document) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const node = root.querySelector(selector);
    if (node) {
      return node;
    }
    await delay(250);
  }
  return null;
}

async function applySearchKeyword(keyword) {
  const query = MapsExtractorUtils.trimText(keyword);
  if (!query) {
    return;
  }

  const searchInput =
    document.querySelector('input[role="combobox"][name="q"]') ||
    document.querySelector('input[name="q"]') ||
    document.querySelector("#searchboxinput");

  if (!searchInput) {
    // If input is missing in this view, continue with currently loaded results.
    return;
  }

  searchInput.focus();

  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (valueSetter) {
    valueSetter.call(searchInput, query);
  } else {
    searchInput.value = query;
  }

  searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  searchInput.dispatchEvent(new Event("change", { bubbles: true }));
  await delay(250);

  searchInput.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true
    })
  );
  searchInput.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true
    })
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < 12000) {
    const cards = getBusinessCards();
    if (cards.length > 0) {
      await delay(800);
      return;
    }
    await delay(300);
  }
}

async function extractFromPlaceUrl(placeUrl) {
  if (!placeUrl || !placeUrl.includes("/maps/place/")) {
    return null;
  }

  try {
    const response = await fetch(placeUrl, { credentials: "include" });
    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const entry = {
      name: "",
      address: "",
      phone: "",
      website: "",
      openingHours: "",
      category: ""
    };

    const scriptMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const scriptMatch of scriptMatches) {
      const rawJson = scriptMatch[1];
      try {
        const parsed = JSON.parse(rawJson);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        const business = candidates.find((item) =>
          item && typeof item === "object" && (item.telephone || item.name || item.address)
        );

        if (!business) {
          continue;
        }

        entry.name = MapsExtractorUtils.trimText(business.name || entry.name);
        entry.phone = MapsExtractorUtils.trimText(business.telephone || business.phone || entry.phone);
        entry.website = MapsExtractorUtils.trimText(business.url || business.website || entry.website);

        if (business.openingHours) {
          if (Array.isArray(business.openingHours)) {
            entry.openingHours = business.openingHours.join("; ");
          } else {
            entry.openingHours = MapsExtractorUtils.trimText(business.openingHours);
          }
        } else if (Array.isArray(business.openingHoursSpecification)) {
          entry.openingHours = business.openingHoursSpecification
            .map((spec) => {
              const days = Array.isArray(spec.dayOfWeek) ? spec.dayOfWeek.join(",") : spec.dayOfWeek || "";
              return [days, spec.opens, spec.closes].filter(Boolean).join(" ");
            })
            .filter(Boolean)
            .join("; ");
        }

        if (business.address) {
          if (typeof business.address === "string") {
            entry.address = MapsExtractorUtils.trimText(business.address);
          } else if (typeof business.address === "object") {
            entry.address = MapsExtractorUtils.trimText(
              [
                business.address.streetAddress,
                business.address.addressLocality,
                business.address.addressRegion,
                business.address.postalCode
              ]
                .filter(Boolean)
                .join(", ")
            );
          }
        }
      } catch (error) {
        // Ignore malformed JSON-LD blocks.
      }
    }

    if (!entry.phone) {
      const telMeta = html.match(/"telephone"\s*:\s*"([^"]+)"/i) || html.match(/"phoneNumber"\s*:\s*"([^"]+)"/i);
      if (telMeta) {
        entry.phone = MapsExtractorUtils.trimText(telMeta[1]);
      }
    }

    if (!entry.name) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch) {
        entry.name = MapsExtractorUtils.trimText(titleMatch[1].replace(/- Google Maps.*$/i, ""));
      }
    }

    return entry;
  } catch (error) {
    return null;
  }
}

function getResultsFeed() {
  // 1. Authoritative selector: actual search-results feed.
  const direct = document.querySelector('div[role="feed"]');
  if (direct) {
    return direct;
  }

  // 2. Some Maps layouts use a region whose aria-label starts with "Results for".
  // Be VERY careful here: a region with aria-label="Information for <name>" is
  // the SINGLE-PLACE info panel — that must NOT be treated as a results feed
  // (otherwise we'd mine related-business links and end up with no-name cards).
  const regions = document.querySelectorAll('div[role="main"] div[role="region"][aria-label]');
  for (const region of regions) {
    const aria = (region.getAttribute("aria-label") || "").toLowerCase();
    if (/^(results|search results)/i.test(aria)) {
      return region;
    }
  }

  // 3. Heuristic fallback: a scrollable ancestor of multiple distinct
  // /maps/place/ links. We DO NOT run this when we're on a /maps/place/<one>/
  // URL because such pages frequently include "related businesses" / "people
  // also search for" panels that contain several place links — those would be
  // wrongly identified as a results feed and lead to no-name cards.
  if (/\/maps\/place\//.test(window.location.href)) {
    return null;
  }

  const placeLinks = [...document.querySelectorAll('a[href*="/maps/place/"]')];
  const distinctHrefs = new Set(placeLinks.map((a) => a.getAttribute("href")));
  if (distinctHrefs.size < 2) {
    return null;
  }

  const placeLink = placeLinks[0];
  let current = placeLink.parentElement;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const isScrollable = /(auto|scroll)/.test(style.overflowY);
    if (isScrollable && current.scrollHeight > current.clientHeight + 100) {
      const localLinks = [...current.querySelectorAll('a[href*="/maps/place/"]')];
      const localDistinct = new Set(localLinks.map((a) => a.getAttribute("href")));
      if (localDistinct.size >= 2) {
        return current;
      }
    }
    current = current.parentElement;
  }

  return null;
}

function isOnSinglePlacePage() {
  // /maps/place/<name>/... means we're focused on ONE business, not a results list.
  const url = window.location.href;
  if (!/\/maps\/place\//.test(url)) {
    return false;
  }
  // No real results feed AND there's an Information panel for this single place.
  const hasInfoPanel = !!document.querySelector('div[role="region"][aria-label^="Information"]');
  const hasRealFeed = !!getResultsFeed();
  return hasInfoPanel && !hasRealFeed;
}

function getBusinessCards() {
  const feed = getResultsFeed();

  // Only consider cards that belong to an actual results list. If there's no feed,
  // do NOT scan the whole document — that picks up the Google Account avatar in
  // the header (which has aria-label="Google Account: ...") and other unrelated
  // place links elsewhere in the page chrome.
  if (!feed) {
    return [];
  }

  const articleCards = [...feed.querySelectorAll('div[role="article"]')];
  if (articleCards.length > 0) {
    return articleCards;
  }

  // Fallback within the feed only: /maps/place/ anchors inside the feed itself.
  const feedLinks = [...feed.querySelectorAll('a[href*="/maps/place/"]')];
  const seen = new Set();
  const unique = [];
  for (const link of feedLinks) {
    const href = link.getAttribute("href") || "";
    if (href && !seen.has(href)) {
      seen.add(href);
      unique.push(link);
    }
  }
  return unique;
}

async function autoScrollResults(maxWanted) {
  // Wait for either a results feed OR at least one business card to appear.
  const startedAt = Date.now();
  let feed = getResultsFeed();
  while (!feed && Date.now() - startedAt < 15000) {
    await delay(400);
    feed = getResultsFeed();
    if (!feed && getBusinessCards().length > 0) {
      // Cards exist but we couldn't classify a feed; bail out and let the loop work without scrolling.
      break;
    }
  }

  if (!feed) {
    if (isOnSinglePlacePage()) {
      // Single-place page: caller will extract just that one business.
      return;
    }
    if (getBusinessCards().length === 0) {
      throw new Error(
        "No business cards found. Open the Google Maps search results list (left side panel) on this tab and run again."
      );
    }
    return;
  }

  let previousCount = 0;
  let stagnantRounds = 0;

  while (!extractorState.stopRequested) {
    const cardsCount = getBusinessCards().length;
    if (cardsCount >= maxWanted) {
      break;
    }

    if (typeof feed.scrollBy === "function") {
      feed.scrollBy({ top: 1200, behavior: "smooth" });
    } else {
      feed.scrollTop += 1200;
    }
    await delay(randomBetween(1000, 2000));

    const currentCount = getBusinessCards().length;
    if (currentCount > previousCount) {
      previousCount = currentCount;
      stagnantRounds = 0;
    } else {
      stagnantRounds += 1;
    }

    if (stagnantRounds >= 4) {
      break;
    }
  }
}

function getActiveInfoPanel(expectedName) {
  const regions = [...document.querySelectorAll('div[role="region"][aria-label^="Information"]')];

  // 1. Prefer the region whose aria-label actually matches the expected business.
  if (expectedName && regions.length > 0) {
    const expectedNorm = MapsExtractorUtils
      .cleanName(expectedName)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    for (const region of regions) {
      const aria = (region.getAttribute("aria-label") || "")
        .replace(/^Information for\s*/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (aria && expectedNorm && (aria === expectedNorm || aria.includes(expectedNorm) || expectedNorm.includes(aria))) {
        return region;
      }
    }
  }

  // 2. Otherwise prefer the visible region.
  for (const region of regions) {
    const rect = region.getBoundingClientRect?.();
    if (rect && rect.height > 0 && rect.width > 0) {
      return region;
    }
  }

  // 3. Last visible region in DOM order.
  if (regions.length > 0) {
    return regions[regions.length - 1];
  }

  // 4. Newer Maps layouts may not expose "Information for ..." regions.
  // Find the closest container around the visible place title.
  const visibleTitle =
    document.querySelector('h1.DUwDvf') ||
    document.querySelector('h1.fontHeadlineLarge') ||
    document.querySelector('h1[class*="fontHeadline"]') ||
    document.querySelector('div[role="heading"][aria-level="1"]');
  if (visibleTitle) {
    const placePanel =
      visibleTitle.closest('div[role="main"]') ||
      visibleTitle.closest('div[role="region"]') ||
      visibleTitle.closest("section") ||
      visibleTitle.parentElement;
    if (placePanel) {
      return placePanel;
    }
  }

  return document.querySelector('div[role="main"]') || document;
}

function extractFromDetailsPanel(expectedName) {
  const panel = getActiveInfoPanel(expectedName);

  const getText = (selector) => {
    const el = panel.querySelector(selector);
    return MapsExtractorUtils.trimText(el ? el.textContent : "");
  };

  const getByDataItem = (containsText) => {
    const selectors = [
      `button[data-item-id*="${containsText}"]`,
      `div[data-item-id*="${containsText}"]`,
      `a[data-item-id*="${containsText}"]`
    ];
    for (const selector of selectors) {
      const el = panel.querySelector(selector);
      if (el) {
        return MapsExtractorUtils.trimText(el.textContent || el.getAttribute("aria-label") || "");
      }
    }
    return "";
  };

  const extractPhone = () => {
    const phoneRegex = /(\+?\d[\d\s\-()]{7,}\d)/;

    // Strategy 1: Google sets data-item-id="phone:tel:+91XXX..." on the phone row.
    const phoneItems = panel.querySelectorAll(
      [
        '[data-item-id^="phone:tel:"]',
        '[data-item-id*="phone:tel:"]',
        '[data-item-id*="phone"]'
      ].join(",")
    );
    for (const el of phoneItems) {
      const itemId = el.getAttribute("data-item-id") || "";
      const idMatch = itemId.match(/tel:([+\d][\d\s\-()]{6,}\d)/i);
      if (idMatch) {
        return idMatch[1];
      }
    }

    // Strategy 2: tel: anchor.
    const telLink = panel.querySelector('a[href^="tel:"]');
    if (telLink) {
      const href = telLink.getAttribute("href") || "";
      const cleaned = href.replace(/^tel:/i, "").trim();
      if (cleaned) {
        return cleaned;
      }
    }

    // Strategy 3: aria-label like "Phone: 044 4385 1799" or "Call 044...".
    const ariaCandidates = panel.querySelectorAll('[aria-label]');
    for (const el of ariaCandidates) {
      const aria = el.getAttribute("aria-label") || "";
      const labelMatch = aria.match(/\b(?:Phone|Call|Tel)[^\d+]*([+\d][\d\s\-()]{7,}\d)/i);
      if (labelMatch) {
        return labelMatch[1];
      }
    }

    // Strategy 4: visible text inside any phone-tagged button/row.
    const phoneRows = panel.querySelectorAll(
      [
        'button[aria-label*="Copy phone number"]',
        'button[data-item-id*="phone"]',
        'a[data-item-id*="phone"]',
        'div[data-item-id*="phone"]'
      ].join(",")
    );
    for (const row of phoneRows) {
      const text = MapsExtractorUtils.trimText(row.textContent || "");
      const match = text.match(phoneRegex);
      if (match) {
        return match[1];
      }
    }

    // Strategy 5: phone-icon row sibling (works when classes change).
    const phoneIcon = panel.querySelector(
      'img[src*="phone"], img[alt*="Phone"], [aria-label*="phone" i] svg'
    );
    if (phoneIcon) {
      const row = phoneIcon.closest('button, div, a');
      if (row) {
        const match = MapsExtractorUtils.trimText(row.textContent || "").match(phoneRegex);
        if (match) {
          return match[1];
        }
      }
    }

    // Strategy 6: scan all field-value cells (Google uses class Io6YTe for them).
    // We look for the cell whose text is essentially a phone number.
    const valueCells = panel.querySelectorAll(".Io6YTe, [class*='Io6YTe']");
    for (const cell of valueCells) {
      const text = MapsExtractorUtils.trimText(cell.textContent || "");
      if (!text) continue;
      const compact = text.replace(/[^\d+]/g, "");
      const looksLikePhone =
        /^[+\d][\d\s\-()]{7,}\d$/.test(text) && compact.length >= 8 && compact.length <= 15;
      if (looksLikePhone) {
        return text;
      }
    }

    // Strategy 7: line-by-line scan of the visible panel text.
    // Safe here because clickCardAndExtract verifies the panel actually changed.
    const panelLines = (panel.innerText || "")
      .split("\n")
      .map((line) => MapsExtractorUtils.trimText(line))
      .filter(Boolean);
    for (const line of panelLines) {
      const compact = line.replace(/[^\d+]/g, "");
      const looksLikePhone =
        /^[+\d][\d\s\-()]{7,}\d$/.test(line) && compact.length >= 8 && compact.length <= 15;
      if (looksLikePhone) {
        return line;
      }
    }

    return "";
  };

  const extractWebsite = () => {
    const isExternal = (href) =>
      href &&
      /^https?:\/\//i.test(href) &&
      !href.includes("google.com") &&
      !href.includes("googleusercontent.com") &&
      !href.includes("/maps/");

    // Strategy 1: the standard "Open website" / authority anchor.
    const authorityLink = panel.querySelector(
      [
        'a[data-item-id="authority"]',
        'a[data-item-id*="authority"]',
        'a[aria-label^="Website:"]',
        'a[aria-label*="Website"]',
        'a[data-tooltip*="Open website"]',
        'a[data-tooltip*="website"]'
      ].join(",")
    );
    if (authorityLink) {
      const href = authorityLink.getAttribute("href") || "";
      if (isExternal(href)) {
        return href;
      }
      // aria-label: "Website: gymitfitness.com"
      const aria = authorityLink.getAttribute("aria-label") || "";
      const ariaMatch = aria.match(/^Website:\s*(.+?)\s*$/i);
      if (ariaMatch && ariaMatch[1].trim()) {
        return ariaMatch[1].trim();
      }
      // Inner value cell.
      const valueCell = authorityLink.querySelector(".Io6YTe, [class*='Io6YTe']");
      if (valueCell) {
        const text = MapsExtractorUtils.trimText(valueCell.textContent || "");
        if (text) {
          return text;
        }
      }
      const text = MapsExtractorUtils.trimText(authorityLink.textContent || "");
      if (text && /\./.test(text)) {
        return text;
      }
    }

    // Strategy 2: any element with an aria-label of "Website: ...".
    const websiteAria = panel.querySelector('[aria-label^="Website:"]');
    if (websiteAria) {
      const aria = websiteAria.getAttribute("aria-label") || "";
      const ariaMatch = aria.match(/^Website:\s*(.+?)\s*$/i);
      if (ariaMatch && ariaMatch[1].trim()) {
        return ariaMatch[1].trim();
      }
    }

    // Strategy 3: any anchor pointing to an external URL.
    const externalLinks = panel.querySelectorAll('a[href^="http"]');
    for (const link of externalLinks) {
      const href = link.getAttribute("href") || "";
      if (isExternal(href)) {
        return href;
      }
    }

    // Strategy 4: a field-value cell whose text looks like a domain.
    const valueCells = panel.querySelectorAll(".Io6YTe, [class*='Io6YTe']");
    for (const cell of valueCells) {
      const text = MapsExtractorUtils.trimText(cell.textContent || "");
      if (!text) continue;
      const domainOnly = /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(text);
      const hasDomain = /\b[a-z0-9.\-]+\.(com|in|net|org|co|io|biz|info|app|store|shop|me|us|uk)\b/i.test(text);
      if (domainOnly || hasDomain) {
        return text;
      }
    }

    return "";
  };

  const extractOpeningHours = () => {
    // Strategy 1: the small status line "Open · Closes 10:30 pm".
    const statusNode = panel.querySelector(".ZDu9vd, .o0Svhf .ZDu9vd");
    if (statusNode) {
      const text = MapsExtractorUtils.trimText(statusNode.textContent || "");
      if (text) {
        return text;
      }
    }

    // Strategy 2: the wrapper button with aria-expanded for the hours dropdown.
    const hoursToggle = panel.querySelector(
      [
        '[jsaction*="openhours"]',
        '[aria-label^="Hours:"]',
        '[data-item-id*="oh"]',
        '[aria-label="Hours"] ~ * .ZDu9vd'
      ].join(",")
    );
    if (hoursToggle) {
      const text = MapsExtractorUtils.trimText(hoursToggle.textContent || "");
      if (text) {
        return text.replace(/Show open hours.*$/i, "").trim();
      }
    }

    // Strategy 3: aria-label fallback.
    const ariaNode = panel.querySelector('[aria-label*="Hours" i]');
    if (ariaNode) {
      const aria = MapsExtractorUtils.trimText(ariaNode.getAttribute("aria-label") || "");
      if (aria) {
        return aria;
      }
    }

    return "";
  };

  const parseFromPanelText = () => {
    const lines = (panel.innerText || "")
      .split("\n")
      .map((line) => MapsExtractorUtils.trimText(line))
      .filter(Boolean);

    const ignored = new Set([
      "your maps history",
      "add a label",
      "share",
      "save",
      "nearby",
      "send to your phone",
      "open",
      "closed",
      "delivery",
      "website",
      "directions",
      "call"
    ]);

    const cleanedLines = lines.filter((line) => {
      const lower = line.toLowerCase();
      return !ignored.has(lower);
    });

    const nameGuess = cleanedLines[0] || "";

    const addressGuess = cleanedLines.find((line) => {
      const lower = line.toLowerCase();
      return (
        line.length > 15 &&
        /,/.test(line) &&
        !/\b(closes?|open|hours?|history|label|website|call)\b/i.test(lower)
      );
    }) || "";

    const categoryGuess = cleanedLines.find((line) => {
      const lower = line.toLowerCase();
      return /\b(store|shop|market|bakery|cafe|restaurant|hotel|supermarket|mall|pharmacy|clothing)\b/.test(lower);
    }) || "";

    return {
      name: nameGuess,
      phone: "",
      address: addressGuess,
      category: categoryGuess
    };
  };

  const name =
    getText("h1") ||
    getText('h1.DUwDvf') ||
    getText('h1.fontHeadlineLarge') ||
    getText('div[role="heading"][aria-level="1"]') ||
    MapsExtractorUtils.trimText(
      (
        document.querySelector("h1.DUwDvf") ||
        document.querySelector("h1.fontHeadlineLarge") ||
        document.querySelector('div[role="heading"][aria-level="1"]') ||
        {}
      ).textContent || ""
    ) ||
    getText('h1[aria-level="1"]') ||
    getText('div[role="main"] h1');

  let rating = "";
  let reviewsCount = "";
  const ratingNode = panel.querySelector('[role="img"][aria-label*="star"], span[aria-label*="star"]');
  if (ratingNode) {
    const aria = MapsExtractorUtils.trimText(ratingNode.getAttribute("aria-label") || "");
    const ratingMatch = aria.match(/(\d+(\.\d+)?)/);
    if (ratingMatch) {
      rating = ratingMatch[1];
    }
    const reviewsMatch = aria.match(/(\d[\d,]*)\s*reviews?/i);
    if (reviewsMatch) {
      reviewsCount = reviewsMatch[1].replace(/,/g, "");
    }
  }

  if (!reviewsCount) {
    const reviewsNode = panel.querySelector('button[aria-label*="reviews"], span[aria-label*="reviews"]');
    const reviewsText = MapsExtractorUtils.trimText(reviewsNode ? reviewsNode.textContent : "");
    const reviewsMatch = reviewsText.match(/(\d[\d,]*)/);
    if (reviewsMatch) {
      reviewsCount = reviewsMatch[1].replace(/,/g, "");
    }
  }

  const extractAddress = () => {
    // Strategy 1: aria-label="Address: ..." (most reliable, gives full address text)
    const addrButton = panel.querySelector(
      [
        '[data-item-id="address"]',
        '[data-item-id*="address"]',
        '[aria-label^="Address:"]',
        'button[aria-label^="Address"]'
      ].join(",")
    );
    if (addrButton) {
      const aria = addrButton.getAttribute("aria-label") || "";
      const ariaMatch = aria.match(/^Address:\s*([\s\S]+?)\s*$/i);
      if (ariaMatch && ariaMatch[1].trim()) {
        return ariaMatch[1].trim();
      }

      // Strategy 2: the value cell inside the address row.
      const valueCell = addrButton.querySelector(".Io6YTe, [class*='Io6YTe']");
      if (valueCell) {
        const text = MapsExtractorUtils.trimText(valueCell.textContent || "");
        if (text) {
          return text;
        }
      }

      // Strategy 3: textContent of the row as last resort.
      const rowText = MapsExtractorUtils.trimText(addrButton.textContent || "");
      if (rowText) {
        return rowText;
      }
    }
    return "";
  };

  const address = extractAddress();
  const phone =
    getByDataItem("phone") ||
    getByDataItem("tel") ||
    extractPhone();
  const website = extractWebsite();
  const openingHours = extractOpeningHours();

  const category =
    getText('button[jsaction*="pane.rating.category"]') ||
    getText('div[role="main"] button[aria-label*="category"]') ||
    getText('div[role="main"] span button');

  const parsed = parseFromPanelText();

  return {
    name: name || parsed.name,
    address: address || parsed.address,
    phone: phone || parsed.phone,
    website,
    openingHours,
    category: category || parsed.category
  };
}

function readNameFromCard(card) {
  // 1. card aria-label (works for div[role="article"] cards).
  const aria = MapsExtractorUtils.trimText(card.getAttribute?.("aria-label") || "");
  if (aria) {
    const firstPart = aria.split("·")[0]?.split(",")[0] || "";
    const cleaned = MapsExtractorUtils.cleanName(firstPart);
    if (cleaned) {
      return cleaned;
    }
  }

  // 2. inner heading (works for some Maps layouts that wrap names in h3 / role=heading).
  const heading = card.querySelector?.('h3, [role="heading"], .qBF1Pd, .fontHeadlineSmall');
  if (heading) {
    const cleaned = MapsExtractorUtils.cleanName(heading.textContent || "");
    if (cleaned) {
      return cleaned;
    }
  }

  // 3. inner /maps/place/ link's aria-label or text.
  const link = card.matches?.('a[href*="/maps/place/"]')
    ? card
    : card.querySelector?.('a[href*="/maps/place/"]');
  if (link) {
    const linkAria = MapsExtractorUtils.cleanName(link.getAttribute("aria-label") || "");
    if (linkAria) {
      return linkAria;
    }
    const linkText = MapsExtractorUtils.cleanName(link.textContent || "");
    if (linkText) {
      return linkText;
    }
    // 4. derive name from the place URL slug as last resort.
    const href = link.getAttribute("href") || "";
    const slugMatch = href.match(/\/maps\/place\/([^/]+)\//);
    if (slugMatch) {
      const fromSlug = decodeURIComponent(slugMatch[1])
        .replace(/\+/g, " ")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const cleaned = MapsExtractorUtils.cleanName(fromSlug);
      if (cleaned) {
        return cleaned;
      }
    }
  }

  return "";
}

function extractFallbackFromCard(card) {
  const text = MapsExtractorUtils.trimText(
    `${card.getAttribute?.("aria-label") || ""} ${card.textContent || ""}`
  );
  const phoneMatch = text.match(/(\+?\d[\d\s\-()]{7,}\d)/);
  const addressMatch = text.match(/(\d[^|]*?,[^|]{5,})/);
  return {
    name: readNameFromCard(card),
    address: MapsExtractorUtils.cleanAddress(addressMatch ? addressMatch[1] : ""),
    phone: phoneMatch ? phoneMatch[1] : "",
    website: "",
    openingHours: "",
    category: ""
  };
}

function getExpectedNameFromCard(card) {
  return readNameFromCard(card);
}

function normalizeNameForCompare(name) {
  return MapsExtractorUtils
    .cleanName(name)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function namesLookSame(a, b) {
  const left = normalizeNameForCompare(a);
  const right = normalizeNameForCompare(b);
  if (!left || !right) {
    return false;
  }
  return left === right || left.includes(right) || right.includes(left);
}

async function clickCardAndExtract(card) {
  const clickable =
    card.querySelector('a[href*="/maps/place/"]') ||
    card.querySelector('a[role="link"]') ||
    card;
  const placeUrl = clickable?.getAttribute?.("href") || card?.getAttribute?.("href") || "";
  const expectedName = getExpectedNameFromCard(card);

  const getPanelSignature = () => {
    const panel = getActiveInfoPanel(expectedName);
    const title = MapsExtractorUtils.trimText((document.querySelector("h1") || {}).textContent || "");
    const addrNode = panel.querySelector('[data-item-id*="address"]');
    const address = MapsExtractorUtils.trimText((addrNode || {}).textContent || "");
    const ariaLabel = panel.getAttribute?.("aria-label") || "";
    return `${window.location.href}|${title}|${address}|${ariaLabel}`;
  };

  // Wait until the panel for THIS business is the visible/active one and contains
  // its address row (which means phone/website rows are also painted).
  const waitForPanelReady = async (timeoutMs) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const panel = getActiveInfoPanel(expectedName);
      const ariaLabel = (panel.getAttribute?.("aria-label") || "").replace(/^Information for\s*/i, "");
      const ariaMatches =
        !expectedName ||
        namesLookSame(ariaLabel, expectedName);
      const addrNode = panel.querySelector('[data-item-id*="address"]');
      const addrText = MapsExtractorUtils.trimText((addrNode || {}).textContent || "");
      if (ariaMatches && addrText.length > 5) {
        return true;
      }
      await delay(200);
    }
    return false;
  };

  let details = null;
  const beforeSignature = getPanelSignature();
  let panelChanged = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await delay(randomBetween(120, 260));
    clickable.click();

    const start = Date.now();
    while (Date.now() - start < 8000) {
      const currentSignature = getPanelSignature();
      panelChanged = currentSignature !== beforeSignature;
      if (panelChanged) {
        break;
      }
      await delay(250);
    }

    // Even if signature changed, wait until the panel's address cell is populated
    // so phone/website/hours are also rendered before we extract.
    if (panelChanged) {
      await waitForPanelReady(4000);
    }
    await delay(randomBetween(700, 1400));

    if (panelChanged) {
      details = extractFromDetailsPanel(expectedName);
    }

    if (panelChanged && details?.name && MapsExtractorUtils.cleanPhone(details?.phone || "")) {
      break;
    }
    if (panelChanged && details?.name && attempt === 1) {
      // Accept name-only on second attempt; phone may genuinely be absent.
      break;
    }
  }

  const fallback = extractFallbackFromCard(card);
  if (!panelChanged) {
    const fromUrl = await extractFromPlaceUrl(placeUrl);
    const candidate = {
      name: MapsExtractorUtils.cleanName(fromUrl?.name) || fallback.name,
      address: MapsExtractorUtils.cleanAddress(fromUrl?.address) || fallback.address,
      phone: fromUrl?.phone || fallback.phone,
      website: fromUrl?.website || fallback.website || "",
      openingHours: fromUrl?.openingHours || fallback.openingHours || "",
      category: fromUrl?.category || fallback.category
    };
    if (expectedName && candidate.name && !namesLookSame(expectedName, candidate.name)) {
      candidate.phone = "";
    }
    return candidate;
  }

  let merged = {
    name: MapsExtractorUtils.cleanName(details?.name) || fallback.name,
    address: MapsExtractorUtils.cleanAddress(details?.address) || fallback.address,
    phone: details?.phone || fallback.phone,
    website: details?.website || fallback.website || "",
    openingHours: details?.openingHours || fallback.openingHours || "",
    category: details?.category || fallback.category
  };

  if (!MapsExtractorUtils.cleanPhone(merged.phone)) {
    const fromUrl = await extractFromPlaceUrl(placeUrl);
    merged = {
      name: MapsExtractorUtils.cleanName(merged.name) || MapsExtractorUtils.cleanName(fromUrl?.name),
      address: MapsExtractorUtils.cleanAddress(merged.address) || MapsExtractorUtils.cleanAddress(fromUrl?.address),
      phone: merged.phone || fromUrl?.phone || "",
      website: merged.website || fromUrl?.website || "",
      openingHours: merged.openingHours || fromUrl?.openingHours || "",
      category: merged.category || fromUrl?.category || ""
    };
  }

  if (expectedName && merged.name && !namesLookSame(expectedName, merged.name)) {
    merged.phone = "";
  }

  return merged;
}

async function runExtraction(options) {
  extractorState.running = true;
  extractorState.stopRequested = false;
  upsertOverlay(
    "Maps Extractor: starting… Keep this Google Maps tab open. You may switch to other tabs or windows while it runs."
  );

  let result = null;

  try {
    await applySearchKeyword(options.searchKeyword || "");

    const maxResults = Number(options.maxResults) || 100;
    await autoScrollResults(maxResults);

    // Special case: user is on a single business page (/maps/place/<one>) with no
    // results feed. Extract just that one business from the open Information panel
    // instead of erroring out with "no cards" or matching the avatar button.
    if (isOnSinglePlacePage()) {
      const singleEntry = extractFromDetailsPanel("");
      const candidate = {
        name: MapsExtractorUtils.cleanName(singleEntry.name),
        address: MapsExtractorUtils.cleanAddress(singleEntry.address),
        phone: singleEntry.phone,
        website: singleEntry.website || "",
        openingHours: singleEntry.openingHours || "",
        category: singleEntry.category || ""
      };

      const cleanedSingle = MapsExtractorUtils.dedupeEntries([candidate]);
      const filteredSingle = cleanedSingle.filter((entry) =>
        MapsExtractorUtils.matchesCategory(entry, options.categoryFilter || "")
      );

      const sample = `${candidate.name || "no-name"}:${MapsExtractorUtils.cleanPhone(candidate.phone) || "no-phone"}`;

      if (filteredSingle.length === 0) {
        result = {
          success: false,
          error:
            "Single business page detected, but no usable phone number found. Go back to the Google Maps search results list and run again to scrape multiple businesses.",
          debug: {
            cardsFound: 1,
            rawCollected: 1,
            withPhone: cleanedSingle.length,
            sample
          }
        };
        return result;
      }

      result = {
        success: true,
        count: filteredSingle.length,
        data: filteredSingle,
        lines: filteredSingle.map((item) => MapsExtractorUtils.toPrettyLine(item)),
        debug: {
          cardsFound: 1,
          rawCollected: 1,
          withPhone: cleanedSingle.length,
          sample
        }
      };
      return result;
    }

    const cards = getBusinessCards().slice(0, maxResults);

    // Diagnostic: per-card (first card) structure + name resolution result, so
    // we can see if readNameFromCard returns empty or if data is lost later.
    const cardDiagnostic = (() => {
      if (cards.length === 0) {
        return "no-cards";
      }
      const c = cards[0];
      const tag = (c.tagName || "").toLowerCase();
      const aria = c.getAttribute?.("aria-label") || "";
      const innerLink = c.querySelector?.("a[href*='/maps/place/']");
      const innerLinkAria = innerLink?.getAttribute?.("aria-label") || "";
      const resolvedName = readNameFromCard(c) || "EMPTY";
      const expectedName = getExpectedNameFromCard(c) || "EMPTY";
      return [
        `tag:${tag}`,
        `outerAria:${aria ? aria.slice(0, 30) : "NONE"}`,
        `linkAria:${innerLinkAria ? innerLinkAria.slice(0, 30) : "NONE"}`,
        `readName:${resolvedName.slice(0, 30)}`,
        `expName:${expectedName.slice(0, 30)}`
      ].join(" | ");
    })();

    const rawData = [];
    let liveExtracted = 0;
    let lastFingerprint = "";
    let lastName = "";

    sendProgress({
      stage: "start",
      cardsTotal: cards.length,
      processed: 0,
      extracted: 0
    });

    const perCardDebug = [];

    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i];
      if (extractorState.stopRequested) {
        break;
      }

      const cardName = readNameFromCard(card);
      const entry = await clickCardAndExtract(card);
      const candidate = { ...entry };

      if (i < 3) {
        perCardDebug.push(
          `c${i}={cardName:${(cardName || "EMPTY").slice(0, 25)},entryName:${(entry?.name || "EMPTY").slice(0, 25)},entryPhone:${entry?.phone || "EMPTY"}}`
        );
      }
      const fingerprint = [
        MapsExtractorUtils.cleanPhone(candidate.phone),
        MapsExtractorUtils.cleanAddress(candidate.address),
        MapsExtractorUtils.trimText(candidate.website || "")
      ].join("|");
      const candidateName = MapsExtractorUtils.cleanName(candidate.name);

      // If detail payload is identical but shop name changed, the panel is stale.
      if (fingerprint && fingerprint === lastFingerprint && candidateName && lastName && candidateName !== lastName) {
        candidate.phone = "";
      } else if (fingerprint) {
        lastFingerprint = fingerprint;
        lastName = candidateName;
      }

      rawData.push(candidate);
      const normalized = MapsExtractorUtils.normalizeEntry(candidate);
      if (normalized) {
        liveExtracted += 1;
      }
      sendProgress({
        stage: "running",
        cardsTotal: cards.length,
        processed: i + 1,
        extracted: liveExtracted
      });
      await delay(randomBetween(500, 1500));
    }

    const cleaned = MapsExtractorUtils.dedupeEntries(rawData);
    const deduped = cleaned.filter((entry) =>
      MapsExtractorUtils.matchesCategory(entry, options.categoryFilter || "")
    );

    const sample = rawData
      .slice(0, 5)
      .map((item) => `${MapsExtractorUtils.trimText(item.name) || "no-name"}:${MapsExtractorUtils.cleanPhone(item.phone) || "no-phone"}`)
      .join(" | ");

    const perCardSummary = perCardDebug.join(" || ");

    const buildDebug = () => ({
      cardsFound: cards.length,
      rawCollected: rawData.length,
      withPhone: cleaned.length,
      sample,
      cardShape: cardDiagnostic,
      perCard: perCardSummary
    });

    if (deduped.length === 0 && cleaned.length > 0) {
      result = {
        success: false,
        error: "No records matched category filter. Try empty filter or a real category like grocery, clothing, supermarket.",
        debug: buildDebug()
      };
      return result;
    }

    if (cleaned.length === 0) {
      const onPlacePage = /\/maps\/place\//.test(window.location.href);
      const message =
        cards.length === 0
          ? onPlacePage
            ? "You are on a single business page. Click the back arrow (or search a keyword) so the left-side results list appears, then run again."
            : "No business cards found on this page. Open Google Maps search results (the left-side list) on this tab, then run again."
          : "Cards were processed but no phone numbers were detected. These businesses may not list phones on Google Maps.";
      result = {
        success: false,
        error: message,
        debug: buildDebug()
      };
      return result;
    }

    result = {
      success: true,
      count: deduped.length,
      data: deduped,
      lines: deduped.map((item) => MapsExtractorUtils.toPrettyLine(item)),
      debug: buildDebug()
    };
    return result;
  } catch (error) {
    result = {
      success: false,
      error: error.message || "Extraction failed."
    };
    return result;
  } finally {
    sendProgress({
      stage: "done"
    });
    extractorState.running = false;

    chrome.runtime
      .sendMessage({
        action: "extractionComplete",
        success: Boolean(result?.success),
        data: result?.data || [],
        count: result?.count ?? 0,
        error: result?.error || "",
        debug: result?.debug
      })
      .catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "ping") {
    sendResponse({ success: true });
    return false;
  }

  if (message?.action === "startExtraction") {
    if (extractorState.running) {
      sendResponse({ success: false, error: "Extraction already running." });
      return false;
    }

    runExtraction(message.options || {}).then(sendResponse);
    return true;
  }

  if (message?.action === "stopExtraction") {
    extractorState.stopRequested = true;
    sendResponse({ success: true, stopped: true });
    return false;
  }

  return false;
});

} // end of __mapsExtractorContentLoaded__ guard
