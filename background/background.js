chrome.runtime.onInstalled.addListener(() => {
  console.log('Maps Lead Scraper installed');
});

// Keep service worker alive during long scraping operations
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') {
    sendResponse({ alive: true });
  }
});
