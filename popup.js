/* global MapsExtractorUtils */

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const downloadJsonBtn = document.getElementById("downloadJsonBtn");
const downloadTxtBtn = document.getElementById("downloadTxtBtn");
const countText = document.getElementById("countText");
const statusText = document.getElementById("statusText");
const limitSelect = document.getElementById("limitSelect");
const categoryFilterInput = document.getElementById("categoryFilter");
const locationInput = document.getElementById("locationInput");

let extractedData = [];
let isRunning = false;
let liveExtractedCount = 0;

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? "#b91c1c" : "#374151";
}

function setRunningState(running) {
  isRunning = running;
  startBtn.disabled = running;
  limitSelect.disabled = running;
  categoryFilterInput.disabled = running;
  locationInput.disabled = running;
}

function updateCount() {
  const value = isRunning ? liveExtractedCount : extractedData.length;
  countText.textContent = `Extracted: ${value}`;
}

function getPreviewText(data) {
  const firstTwo = (data || []).slice(0, 2);
  if (firstTwo.length === 0) {
    return "";
  }
  return firstTwo.map((item) => MapsExtractorUtils.toPrettyLine(item)).join(" | ");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return;
  } catch (error) {
    const message = error?.message || "";
    const recoverable =
      message.includes("Receiving end does not exist") ||
      message.includes("message channel is closed") ||
      message.includes("back/forward cache") ||
      message.includes("Extension context invalidated");

    if (!recoverable) {
      throw error;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["utils.js", "content.js"]
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
}

function resetSearchInputs() {
  categoryFilterInput.value = "";
  locationInput.value = "";
}

function resetAllState() {
  resetSearchInputs();
  extractedData = [];
  liveExtractedCount = 0;
  updateCount();
}

function saveBlob(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download(
    {
      url,
      filename: fileName,
      saveAs: true
    },
    () => {
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  );
}

async function startExtraction() {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url?.includes("google.com/maps")) {
    setStatus("Open Google Maps search results in the active tab.", true);
    return;
  }

  setRunningState(true);
  liveExtractedCount = 0;
  updateCount();
  setStatus("Extraction started. Please wait...");

  const keyword = MapsExtractorUtils.trimText(categoryFilterInput.value);
  const location = MapsExtractorUtils.trimText(locationInput.value);

  const combinedSearch = location ? `${keyword} in ${location}` : keyword;

  const options = {
    maxResults: Number(limitSelect.value) || 5,
    searchKeyword: combinedSearch,
    categoryFilter: ""
  };

  try {
    await ensureContentScript(tab.id);

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        action: "startExtraction",
        options
      });
    } catch (firstSendError) {
      // Recover from bfcache/port channel closure by reinjecting once and retrying.
      await ensureContentScript(tab.id);
      response = await chrome.tabs.sendMessage(tab.id, {
        action: "startExtraction",
        options
      });
    }

    if (!response?.success) {
      const debug = response?.debug
        ? ` [cards:${response.debug.cardsFound}, raw:${response.debug.rawCollected}, withPhone:${response.debug.withPhone}${response.debug.sample ? `, sample:${response.debug.sample}` : ""}]`
        : "";
      throw new Error((response?.error || "Extraction failed.") + debug);
    }

    extractedData = response.data || [];
    updateCount();
    const preview = getPreviewText(extractedData);
    const debug = response?.debug
      ? ` cards:${response.debug.cardsFound}, raw:${response.debug.rawCollected}, withPhone:${response.debug.withPhone}${response.debug.sample ? `, sample:${response.debug.sample}` : ""}`
      : "";
    setStatus(`Done. ${response.count || 0} extracted.${debug}${preview ? ` First 2: ${preview}` : ""}`);
  } catch (error) {
    setStatus(error.message || "Failed to extract data.", true);
  } finally {
    setRunningState(false);
    resetSearchInputs();
  }
}

async function stopExtraction() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return;
  }

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { action: "stopExtraction" });
    setStatus("Stop requested. Waiting for current item to finish...");
    setRunningState(false);
  } catch (error) {
    setStatus(error.message || "Failed to send stop signal.", true);
  }
}

function downloadCsv() {
  if (extractedData.length === 0) {
    setStatus("No data to export. Run extraction first.", true);
    return;
  }

  const csv = MapsExtractorUtils.toCSV(extractedData);
  saveBlob(csv, "maps-businesses.csv", "text/csv;charset=utf-8;");
  setStatus("CSV download started.");
  resetSearchInputs();
}

function downloadJson() {
  if (extractedData.length === 0) {
    setStatus("No data to export. Run extraction first.", true);
    return;
  }

  const json = JSON.stringify(extractedData, null, 2);
  saveBlob(json, "maps-businesses.json", "application/json;charset=utf-8;");
  setStatus("JSON download started.");
  resetSearchInputs();
}

function downloadTxt() {
  if (extractedData.length === 0) {
    setStatus("No data to export. Run extraction first.", true);
    return;
  }

  const txt = extractedData.map((item) => MapsExtractorUtils.toPrettyLine(item)).join("\n");
  saveBlob(txt, "maps-businesses.txt", "text/plain;charset=utf-8;");
  setStatus("TXT download started.");
  resetSearchInputs();
}

startBtn.addEventListener("click", startExtraction);
stopBtn.addEventListener("click", stopExtraction);
downloadCsvBtn.addEventListener("click", downloadCsv);
downloadJsonBtn.addEventListener("click", downloadJson);
downloadTxtBtn.addEventListener("click", downloadTxt);
resetBtn.addEventListener("click", () => {
  resetAllState();
  setStatus("Inputs and extracted data reset.");
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action !== "extractionProgress") {
    return;
  }

  if (typeof message.extracted === "number") {
    liveExtractedCount = message.extracted;
    updateCount();
  }

  if (message.stage === "running") {
    setStatus(`Processing ${message.processed || 0}/${message.cardsTotal || 0}...`);
  }
});

updateCount();
