/**
 * Service worker: keeps extraction state when the popup is closed.
 * Content script sends progress + final rows here; we persist to chrome.storage.local.
 */

const STORAGE_KEY = "mapsExtractorLastResults";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message?.action === "extractionProgress") {
    const payload = {
      mapsExtractorProgress: {
        stage: message.stage,
        extracted: message.extracted ?? 0,
        processed: message.processed ?? 0,
        cardsTotal: message.cardsTotal ?? 0,
        tabId: tabId ?? null,
        updatedAt: Date.now()
      }
    };

    chrome.storage.local.set(payload).catch(() => {});

    if (tabId && message.stage === "running") {
      const n = String(message.extracted ?? "");
      chrome.action.setBadgeText({ text: n || "…", tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: "#2563eb", tabId }).catch(() => {});
    }

    if (tabId && message.stage === "done") {
      chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
    }

    sendResponse({ ok: true });
    return false;
  }

  if (message?.action === "extractionComplete") {
    (async () => {
      if (message.success && Array.isArray(message.data) && message.data.length > 0) {
        await chrome.storage.local.set({
          [STORAGE_KEY]: message.data,
          mapsExtractorLastFinishedAt: Date.now(),
          mapsExtractorLastCount: message.data.length,
          mapsExtractorLastError: ""
        });
      } else {
        await chrome.storage.local.set({
          mapsExtractorLastError: message.error || "No rows extracted.",
          mapsExtractorLastFinishedAt: Date.now()
        });
      }

      await chrome.storage.local.remove("mapsExtractorProgress");

      if (tabId) {
        chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
      }
    })();

    sendResponse({ ok: true });
    return false;
  }

  return false;
});
