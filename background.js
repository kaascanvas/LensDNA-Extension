// Allows users to open the side panel by clicking the extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Optional: Context menu for "Extract DNA"
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "extract-dna",
    title: "LensDNA: Extract Page DNA",
    contexts: ["page", "link", "selection"]
  });
});

// Listener to actually process the context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "extract-dna" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'GET_DOM_STATE' }).catch(() => {});
  }
});

// --- 1. Persistent Cross-Tab Memory Tracker ---
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab && tab.url && !tab.url.startsWith("chrome://")) {
      // Notify the side panel Sovereign Agent about the context switch
      chrome.runtime.sendMessage({
        action: 'TAB_CONTEXT_SWITCH',
        data: { url: tab.url, title: tab.title }
      }).catch(() => {}); // Fails silently if side panel is closed
    }
  });
});