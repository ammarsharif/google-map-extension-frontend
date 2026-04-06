// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkMaps') {
    sendResponse({ onMaps: window.location.href.includes('google.com/maps') });
    return true;
  }
  if (message.action === 'waitForResults') {
    waitForResultsFeed().then(sendResponse);
    return true;
  }
  if (message.action === 'scrapeSidebar') {
    scrapeSidebar(message.count, message.seenKeys || []).then(sendResponse);
    return true;
  }
  if (message.action === 'scrapeDetails') {
    scrapeDetails(message.businesses).then(sendResponse);
    return true;
  }
});

// WAIT FOR RESULTS FEED
async function waitForResultsFeed() {
  const maxAttempts = 30; // 30 * 500 = 15s
  for (let i = 0; i < maxAttempts; i++) {
    const feed = document.querySelector('div[role="feed"]') || document.querySelector('div.m6QErb[aria-label]');
    
    const storageRes = await new Promise(r => chrome.storage.local.get(['cancelScrape'], r));
    if (storageRes.cancelScrape) {
       return { success: false, error: 'Canceled by user' };
    }

    if (feed) {
      return { success: true };
    }
    await sleep(500);
  }
  return { success: false, error: 'Timeout waiting for results feed to appear' };
}

// SCRAPE SIDEBAR (fast pass - no clicking)
async function scrapeSidebar(targetCount, seenKeysArray) {
  const seenKeys = new Set(seenKeysArray);
  let feed = document.querySelector('div[role="feed"]') || document.querySelector('div.m6QErb[aria-label]');
  if (!feed) return { success: false, results: [] };

  const SELECTORS = {
    cards: 'div[role="feed"] > div > div > a[href*="/maps/place"]',
    name: ['.fontHeadlineSmall', 'h3', '[jstcache].fontHeadlineSmall', '.qBF1Pd'],
    rating: ['.MW4etd', 'span[aria-label*="stars"]'],
    reviews: ['.UY7F9', 'span[aria-label*="reviews"]'],
    categoryContainer: '.W4Efsd',
    addressFallback: '.rogA2c'
  };

  await scrollFeedToLoad(feed, targetCount, seenKeys, SELECTORS);

  // Fallback if feed lost reference after heavy DOM load
  feed = document.querySelector('div[role="feed"]') || document.querySelector('div.m6QErb[aria-label]') || document.body;
  
  const allCards = Array.from(feed.querySelectorAll(SELECTORS.cards));
  
  // Filter down to ONLY cards we haven't seen in previous searches
  const localSeen = new Set();
  const unseenCards = allCards.filter(card => {
     const pId = extractPlaceIdFromUrl(card.href);
     const parentContainer = card.parentElement;
     
     if (parentContainer && (parentContainer.textContent.includes('Sponsored') || parentContainer.textContent.includes('Sponsorisé') || parentContainer.textContent.includes('Ad '))) {
        return false;
     }

     const name = parentContainer ? (trySelectors(parentContainer, SELECTORS.name) || card.getAttribute('aria-label')) : card.getAttribute('aria-label');
     
     if (seenKeys.has(pId) || seenKeys.has(name) || localSeen.has(pId) || localSeen.has(name)) {
        return false;
     }

     if (pId) localSeen.add(pId);
     if (name) localSeen.add(name);
     
     return true;
  }).slice(0, targetCount);

  const results = [];

  for (const card of unseenCards) {
    const parentContainer = card.parentElement;
    
    let name = trySelectors(parentContainer, SELECTORS.name) || card.getAttribute('aria-label') || '';
    let rating = trySelectors(parentContainer, SELECTORS.rating) || '0';
    let reviewCountStr = trySelectors(parentContainer, SELECTORS.reviews) || '0';
    
    // Clean review count "(1,234)" -> 1234
    let reviewCount = parseInt(reviewCountStr.replace(/[^0-9]/g, ''), 10) || 0;
    
    const w4Containers = parentContainer.querySelectorAll(SELECTORS.categoryContainer);
    let category = '';
    let address = '';

    if (w4Containers.length > 0) {
       const catSpans = w4Containers[0].querySelectorAll('span');
       if (catSpans.length >= 3) {
          category = catSpans[2].textContent.replace(/·/g, '').trim();
       } else if (catSpans.length === 1 && !catSpans[0].textContent.includes('★')) {
          category = catSpans[0].textContent.trim();
       }
       if (w4Containers.length > 1) {
          const addrSpans = w4Containers[1].querySelectorAll('span');
          if (addrSpans.length > 1) {
             address = addrSpans[1].textContent.replace(/·/g, '').trim();
          } else if (addrSpans.length > 0) {
             address = addrSpans[0].textContent.replace(/·/g, '').trim();
          }
       }
    }

    if (!address) {
       address = trySelectors(parentContainer, ['.rogA2c']) || '';
    }
    
    const mapsUrl = card.href;
    // Extract real placeId from URL — try CID/data parameter first, then path segment
    const placeId = extractPlaceIdFromUrl(mapsUrl) || String(Math.random());

    results.push({
      id: placeId,
      name,
      rating: parseFloat(rating),
      reviewCount,
      category,
      address,
      mapsUrl,
      placeId
    });
  }

  return { success: true, results };
}

// Extract a stable placeId from a Google Maps URL
function extractPlaceIdFromUrl(url) {
  try {
    // Only use the /place/<name> slug as the stable key. 
    // Attempting to extract from data=!1s coordinates is highly dangerous because 
    // URLs contain multiple CIDs (for the city, user location, etc.) causing false duplicates.
    const pathMatch = url.match(/\/place\/([^/?]+)/);
    if (pathMatch) return 'place_' + pathMatch[1];
  } catch {}
  return null;
}

// SCRAPE DETAILS (click each card, read detail panel)
async function scrapeDetails(businesses) {
  const enriched = [...businesses];

  for (let i = 0; i < enriched.length; i++) {
    const config = await new Promise(r => chrome.storage.local.get(['cancelScrape'], r));
    if (config.cancelScrape) break;

    if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'scrapeProgress',
          percent: Math.round((i / enriched.length) * 100),
          label: `Getting details ${i + 1}/${enriched.length}: ${enriched[i].name}`,
          current: i + 1,
          total: enriched.length
        });
    }

    const clicked = await clickCardByName(enriched[i].name, enriched[i].mapsUrl);

    if (clicked) {
      // Wait for the detail panel to fully load
      const loaded = await waitForDetailPanel();
      
      if (loaded) {
        enriched[i].phone = extractPhone();
        enriched[i].website = extractWebsite();
        
        // Try to grab full address from detail panel
        const fullAddress = extractFullAddress();
        if (fullAddress && fullAddress.length > 5) {
          enriched[i].address = fullAddress;
        }

        // Try to extract a real Place ID from current URL (after panel opens)
        const currentUrl = window.location.href;
        const realPlaceId = extractPlaceIdFromUrl(currentUrl);
        if (realPlaceId && !realPlaceId.startsWith('place_')) {
          enriched[i].placeId = realPlaceId;
          enriched[i].id = realPlaceId;
        }
      }
      
      // Go back to results list
      await goBackToList();
    }
  }

  return { success: true, businesses: enriched };
}

// Click a card by matching name or falling back to mapsUrl
async function clickCardByName(name, mapsUrl) {
  // First attempt: match by visible name text
  const cards = document.querySelectorAll('a[href*="/maps/place"]');
  
  for (const card of cards) {
    const parent = card.parentElement;
    const nameEl = parent ? parent.querySelector('.fontHeadlineSmall, h3, .qBF1Pd') : null;
    const tName = nameEl ? nameEl.textContent.trim() : card.getAttribute('aria-label');
    
    if (tName === name) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(300); // let scroll settle
      card.click();
      return true;
    }
  }

  // Fallback: match by URL
  for (const card of cards) {
    if (card.href === mapsUrl) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(300);
      card.click();
      return true;
    }
  }

  return false;
}

// Wait for the detail panel to load with generous timeout
async function waitForDetailPanel() {
  // Initial wait for panel to start loading
  await sleep(1800);
  
  // Then poll until we get data or timeout (max ~6s extra)
  for (let j = 0; j < 12; j++) {
    const website = extractWebsite();
    const phone = extractPhone();
    const address = extractFullAddress();
    const hasTitle = document.querySelector('h1.DUwDvf, [data-attrid="title"] span');
    
    if (website || phone || address || hasTitle) {
      // Got something — wait a tiny bit more for remaining fields
      await sleep(400);
      return true;
    }
    await sleep(500);
  }
  
  // Return true anyway — even partial data is useful
  return true;
}

// Navigate back to the results list
async function goBackToList() {
  const backBtn = document.querySelector(
    'button[aria-label="Back"], button.wNK10e, button[jsaction*="back"], [data-tooltip="Back"]'
  );
  if (backBtn) {
    backBtn.click();
    await sleep(1000); // wait for list to re-render
  } else {
    // If no back button found, wait anyway for stability
    await sleep(800);
  }
}

// EXTRACTION HELPERS
function extractPhone() {
  // Primary: copy button tooltip
  const phNode = document.querySelector('button[data-tooltip="Copy phone number"]');
  if (phNode) {
    const label = phNode.getAttribute('aria-label') || '';
    return label.replace(/copy phone number/i, '').trim() || null;
  }
  
  // Secondary: data-item-id
  const infoNodes = document.querySelectorAll('[data-item-id*="phone"] .fontBodyMedium');
  if (infoNodes.length > 0) return infoNodes[0].textContent.trim() || null;
  
  // Tertiary: regex scan for tel links
  const telLink = document.querySelector('a[href^="tel:"]');
  if (telLink) return telLink.textContent.trim() || null;

  return null;
}

function extractWebsite() {
  // Primary: authority link
  const webNode = document.querySelector('a[data-item-id="authority"]');
  if (webNode) return webNode.href;
  
  // Secondary: any outbound non-google link in the detail area
  const aNodes = document.querySelectorAll('.m6QErb > div > a[href^="http"]:not([href*="google.com"])');
  if (aNodes.length > 0) return aNodes[0].href;
  
  return null;
}

function extractFullAddress() {
  // Primary: copy address button
  const addrBtn = document.querySelector('button[data-tooltip*="Copy address"]');
  if (addrBtn) {
    return addrBtn.getAttribute('aria-label')?.replace(/copy address/i, '').trim() || null;
  }
  
  // Secondary: address data item
  const addrNode = document.querySelector('[data-item-id="address"] .fontBodyMedium');
  if (addrNode) return addrNode.textContent.trim() || null;
  
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trySelectors(element, selectors) {
  for (const sel of selectors) {
    try {
      const el = element.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    } catch {}
  }
  return null;
}

async function scrollFeedToLoad(feed, targetCount, seenKeys, SELECTORS) {
  let prevUnseenCount = 0;
  let staleAttempts = 0;
  let totalAttempts = 0;
  const MAX_STALE = 8;   // give up after 8 consecutive no-new-cards scrolls
  const MAX_TOTAL = 50;  // hard cap

  while (totalAttempts < MAX_TOTAL) {
    const storageRes = await new Promise(r => chrome.storage.local.get(['cancelScrape'], r));
    if (storageRes.cancelScrape) return;

    const cards = Array.from(feed.querySelectorAll('a[href*="/maps/place"]'));
    const unseenCards = cards.filter(card => {
       const pId = extractPlaceIdFromUrl(card.href);
       const parent = card.parentElement;
       const nameEl = parent ? trySelectors(parent, SELECTORS.name) : null;
       const name = nameEl || card.getAttribute('aria-label');
       return !seenKeys.has(pId) && !seenKeys.has(name);
    });

    if (unseenCards.length >= targetCount) break;

    if (unseenCards.length === prevUnseenCount) {
      staleAttempts++;
      if (staleAttempts >= MAX_STALE) break; // no more cards loading
    } else {
      staleAttempts = 0;
      prevUnseenCount = unseenCards.length;
    }
    
    let scrollEl = feed;
    if (feed.scrollHeight <= feed.clientHeight + 10) {
        scrollEl = feed.parentElement || feed;
    }
    
    scrollEl.scrollTop = scrollEl.scrollHeight;
    await sleep(900);
    totalAttempts++;
  }
}
