/* global MapsExtractorUtils */

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
  const status = payload?.stage === "running"
    ? `Maps Extractor: ${payload.extracted || 0} extracted (${payload.processed || 0}/${payload.cardsTotal || 0})`
    : payload?.stage === "start"
      ? "Maps Extractor: started..."
      : payload?.stage === "done"
        ? "Maps Extractor: done"
        : "Maps Extractor";
  upsertOverlay(status);

  try {
    chrome.runtime.sendMessage({
      action: "extractionProgress",
      ...payload
    });
  } catch (error) {
    // Popup may be closed; ignore progress errors.
  }
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
      rating: "",
      address: "",
      phone: "",
      category: "",
      description: "",
      reviewsCount: ""
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
        entry.description = MapsExtractorUtils.trimText(business.description || entry.description);

        if (business.aggregateRating && typeof business.aggregateRating === "object") {
          entry.rating = MapsExtractorUtils.trimText(business.aggregateRating.ratingValue || entry.rating);
          entry.reviewsCount = MapsExtractorUtils.trimText(business.aggregateRating.reviewCount || entry.reviewsCount);
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
  const directFeed = (
    document.querySelector('div[role="feed"]') ||
    document.querySelector('div[aria-label][role="main"] div[role="region"] div[role="feed"]') ||
    document.querySelector('div[role="main"] div[role="region"][aria-label]')
  );

  if (directFeed) {
    return directFeed;
  }

  const placeLink = document.querySelector('a[href*="/maps/place/"]');
  if (!placeLink) {
    return null;
  }

  let current = placeLink.parentElement;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const isScrollable = /(auto|scroll)/.test(style.overflowY);
    if (isScrollable && current.scrollHeight > current.clientHeight + 100) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function getBusinessCards() {
  const feed = getResultsFeed();
  const root = feed || document;

  const cards = [...root.querySelectorAll('div[role="article"]')];
  if (cards.length > 0) {
    return cards;
  }

  return [...root.querySelectorAll('a[href*="/maps/place/"]')];
}

async function autoScrollResults(maxWanted) {
  const startedAt = Date.now();
  let feed = getResultsFeed();
  while (!feed && Date.now() - startedAt < 12000) {
    await delay(300);
    feed = getResultsFeed();
  }

  if (!feed) {
    throw new Error("Could not find results panel. Open a Google Maps search results page first.");
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

function extractFromDetailsPanel() {
  const panel = document.querySelector('div[role="main"]') || document;

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
    const copyValueNode = panel.querySelector(
      [
        'button[aria-label*="Copy phone number"] .Io6YTe.fontBodyMedium.kR99db.fdkmkc',
        'button[data-item-id*="phone"] .Io6YTe.fontBodyMedium.kR99db.fdkmkc',
        'div[data-item-id*="phone"] .Io6YTe.fontBodyMedium.kR99db.fdkmkc'
      ].join(",")
    );
    if (copyValueNode) {
      const val = MapsExtractorUtils.trimText(copyValueNode.textContent || "");
      if (val) {
        return val;
      }
    }

    const candidates = panel.querySelectorAll(
      [
        'button[data-item-id*="phone"]',
        'a[data-item-id*="phone"]',
        'button[aria-label*="Phone"]',
        'button[aria-label*="Call"]',
        'a[href^="tel:"]'
      ].join(",")
    );

    for (const el of candidates) {
      const source = [
        el.getAttribute("data-item-id"),
        el.getAttribute("aria-label"),
        el.getAttribute("href"),
        el.textContent
      ]
        .filter(Boolean)
        .join(" ");
      const match = source.match(/(\+?\d[\d\s\-()]{7,}\d)/);
      if (match) {
        return match[1];
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

  const address = getByDataItem("address");
  const phone = getByDataItem("phone") || extractPhone();

  const category =
    getText('button[jsaction*="pane.rating.category"]') ||
    getText('div[role="main"] button[aria-label*="category"]') ||
    getText('div[role="main"] span button');

  const description =
    getByDataItem("description") ||
    getText('div[aria-label*="From"] span') ||
    getText('div[role="main"] div[jsaction] span');

  const parsed = parseFromPanelText();

  return {
    name: name || parsed.name,
    rating,
    address: address || parsed.address,
    phone: phone || parsed.phone,
    category: category || parsed.category,
    description,
    reviewsCount
  };
}

function extractFallbackFromCard(card) {
  const text = MapsExtractorUtils.trimText(
    `${card.getAttribute("aria-label") || ""} ${card.textContent || ""}`
  );
  const aria = MapsExtractorUtils.trimText(card.getAttribute("aria-label") || "");
  const firstPart = aria.split("·")[0]?.split(",")[0] || "";
  const phoneMatch = text.match(/(\+?\d[\d\s\-()]{7,}\d)/);
  const addressMatch = text.match(/(\d[^|]*?,[^|]{5,})/);
  return {
    name: MapsExtractorUtils.cleanName(firstPart) || MapsExtractorUtils.cleanName(aria),
    rating: "",
    address: MapsExtractorUtils.cleanAddress(addressMatch ? addressMatch[1] : ""),
    phone: phoneMatch ? phoneMatch[1] : "",
    category: "",
    description: "",
    reviewsCount: ""
  };
}

function getExpectedNameFromCard(card) {
  const aria = MapsExtractorUtils.trimText(card.getAttribute("aria-label") || "");
  const byAria = aria.split("·")[0]?.split(",")[0] || "";
  if (MapsExtractorUtils.cleanName(byAria)) {
    return MapsExtractorUtils.cleanName(byAria);
  }

  const heading = card.querySelector('h3, [role="heading"]');
  if (heading) {
    return MapsExtractorUtils.cleanName(heading.textContent || "");
  }

  const link = card.querySelector('a[href*="/maps/place/"]');
  if (link) {
    return MapsExtractorUtils.cleanName(link.getAttribute("aria-label") || link.textContent || "");
  }

  return "";
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
    const title = MapsExtractorUtils.trimText((document.querySelector("h1") || {}).textContent || "");
    const addrNode = document.querySelector('[data-item-id*="address"]');
    const address = MapsExtractorUtils.trimText((addrNode || {}).textContent || "");
    return `${window.location.href}|${title}|${address}`;
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
    await delay(randomBetween(700, 1400));

    if (panelChanged) {
      details = extractFromDetailsPanel();
    }

    if (panelChanged && details?.name) {
      break;
    }
  }

  const fallback = extractFallbackFromCard(card);
  if (!panelChanged) {
    const fromUrl = await extractFromPlaceUrl(placeUrl);
    const candidate = {
      name: MapsExtractorUtils.cleanName(fromUrl?.name) || fallback.name,
      rating: fromUrl?.rating || fallback.rating,
      address: MapsExtractorUtils.cleanAddress(fromUrl?.address) || fallback.address,
      phone: fromUrl?.phone || fallback.phone,
      category: fromUrl?.category || fallback.category,
      description: fromUrl?.description || fallback.description,
      reviewsCount: fromUrl?.reviewsCount || fallback.reviewsCount
    };
    if (expectedName && !namesLookSame(expectedName, candidate.name)) {
      candidate.phone = "";
    }
    return candidate;
  }

  let merged = {
    name: MapsExtractorUtils.cleanName(details?.name) || fallback.name,
    rating: details?.rating || fallback.rating,
    address: MapsExtractorUtils.cleanAddress(details?.address) || fallback.address,
    phone: details?.phone || fallback.phone,
    category: details?.category || fallback.category,
    description: details?.description || fallback.description,
    reviewsCount: details?.reviewsCount || fallback.reviewsCount
  };

  if (!MapsExtractorUtils.cleanPhone(merged.phone)) {
    const fromUrl = await extractFromPlaceUrl(placeUrl);
    merged = {
      name: MapsExtractorUtils.cleanName(merged.name) || MapsExtractorUtils.cleanName(fromUrl?.name),
      rating: merged.rating || fromUrl?.rating || "",
      address: MapsExtractorUtils.cleanAddress(merged.address) || MapsExtractorUtils.cleanAddress(fromUrl?.address),
      phone: merged.phone || fromUrl?.phone || "",
      category: merged.category || fromUrl?.category || "",
      description: merged.description || fromUrl?.description || "",
      reviewsCount: merged.reviewsCount || fromUrl?.reviewsCount || ""
    };
  }

  if (expectedName && !namesLookSame(expectedName, merged.name)) {
    merged.phone = "";
  }

  return merged;
}

async function runExtraction(options) {
  extractorState.running = true;
  extractorState.stopRequested = false;
  upsertOverlay("Maps Extractor: started...");

  try {
    await applySearchKeyword(options.searchKeyword || "");

    const maxResults = Number(options.maxResults) || 100;
    await autoScrollResults(maxResults);

    const cards = getBusinessCards().slice(0, maxResults);
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

    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i];
      if (extractorState.stopRequested) {
        break;
      }

      const entry = await clickCardAndExtract(card);
      const candidate = { ...entry };
      const fingerprint = [
        MapsExtractorUtils.cleanPhone(candidate.phone),
        MapsExtractorUtils.trimText(candidate.rating),
        MapsExtractorUtils.cleanAddress(candidate.address),
        MapsExtractorUtils.trimText(candidate.reviewsCount)
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

    if (deduped.length === 0 && cleaned.length > 0) {
      return {
        success: false,
        error: "No records matched category filter. Try empty filter or a real category like grocery, clothing, supermarket.",
        debug: {
          cardsFound: cards.length,
          rawCollected: rawData.length,
          withPhone: cleaned.length,
          sample
        }
      };
    }

    if (cleaned.length === 0) {
      return {
        success: false,
        error: "Cards were clicked but phone numbers were not detected. Try zooming in and opening full details list view.",
        debug: {
          cardsFound: cards.length,
          rawCollected: rawData.length,
          withPhone: cleaned.length,
          sample
        }
      };
    }

    return {
      success: true,
      count: deduped.length,
      data: deduped,
      lines: deduped.map((item) => MapsExtractorUtils.toPrettyLine(item)),
      debug: {
        cardsFound: cards.length,
        rawCollected: rawData.length,
        withPhone: cleaned.length,
        sample
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Extraction failed."
    };
  } finally {
    sendProgress({
      stage: "done"
    });
    extractorState.running = false;
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
