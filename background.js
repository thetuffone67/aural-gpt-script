chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'openTabs' && Array.isArray(msg.urls)) {
    for (const url of msg.urls) {
      if (typeof url === 'string' &&
          (url.startsWith('https://chatgpt.com/') || url.startsWith('https://chat.openai.com/'))) {
        chrome.tabs.create({ url, active: false });
      }
    }
    sendResponse({ ok: true });
  }
  return false;
});
