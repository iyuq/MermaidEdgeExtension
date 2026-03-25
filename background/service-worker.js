/**
 * Mermaid Diagram Previewer - Background Service Worker
 * Manages badge updates and cross-tab messaging.
 */

// Track diagram counts per tab
const tabCounts = {};

// Listen for diagram render counts from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "DIAGRAMS_RENDERED" && sender.tab) {
    const tabId = sender.tab.id;
    tabCounts[tabId] = (tabCounts[tabId] || 0) + msg.count;
    updateBadge(tabId, tabCounts[tabId]);
    sendResponse({ ok: true });
  }
  return true;
});

function updateBadge(tabId, count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count), tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#0969da", tabId });
  } else {
    chrome.action.setBadgeText({ text: "", tabId });
  }
}

// Clear badge on full-page navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabCounts[tabId] = 0;
    updateBadge(tabId, 0);
  }
});

// Also clear badge on SPA navigation (pushState / replaceState).
// The content script will re-report its count after scanning.
try {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) { // main frame only
      const tabId = details.tabId;
      tabCounts[tabId] = 0;
      updateBadge(tabId, 0);
    }
  });
} catch (e) {
  // webNavigation may not be available without the permission
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabCounts[tabId];
});
