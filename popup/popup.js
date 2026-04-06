// State
const state = {
  sessionId: null,
  isSearching: false,
  results: [],
  searchId: null,
  selectedIds: new Set(),
  currentTabId: null,
  cancelRequested: false
};

// On DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  await initSession();
  await checkCurrentTab();
  bindEvents();
});

// INIT SESSION
async function initSession() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['sessionId'], (res) => {
      if (chrome.runtime.lastError) console.error(chrome.runtime.lastError);
      let session = res.sessionId;
      if (!session) {
        session = generateSessionId();
        chrome.storage.local.set({ sessionId: session });
      }
      state.sessionId = session;
      const el = document.getElementById('sessionBadge');
      if (el) el.textContent = 'Session: ' + session.substr(-8);
      resolve();
    });
  });
}

// CHECK CURRENT TAB
async function checkCurrentTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError);
          resolve(false);
          return;
        }
        if (tabs && tabs[0]) {
          state.currentTabId = tabs[0].id;
          const url = tabs[0].url || '';
          if (url.includes('google.com/maps') || url.includes('maps.google.com')) {
            document.getElementById('notOnMaps').style.display = 'none';
            document.getElementById('searchSection').style.display = 'flex';
            resolve(true);
            return;
          }
        }
        document.getElementById('notOnMaps').style.display = 'flex';
        document.getElementById('searchSection').style.display = 'none';
        resolve(false);
      });
    } catch (e) {
      console.error("Tab query failed:", e);
      resolve(false);
    }
  });
}

// BIND EVENTS
function bindEvents() {
  const searchBtn = document.getElementById('searchBtn');
  if (searchBtn) searchBtn.addEventListener('click', handleSearch);

  const openMapsBtn = document.getElementById('openMapsBtn');
  if (openMapsBtn) {
    openMapsBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://www.google.com/maps' }, () => {
        window.close();
      });
    });
  }

  const cancelBtn = document.getElementById('cancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      state.cancelRequested = true;
      chrome.storage.local.set({ cancelScrape: true });
      showError("Search canceled by user");
      resetToSearch();
    });
  }

  const selectAllBtn = document.getElementById('selectAllBtn');
  if (selectAllBtn) selectAllBtn.addEventListener('click', toggleSelectAll);

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', handleExport);

  const newSearchBtn = document.getElementById('newSearchBtn');
  if (newSearchBtn) newSearchBtn.addEventListener('click', resetToSearch);

  const resetSessionBtn = document.getElementById('resetSessionBtn');
  if (resetSessionBtn) {
    resetSessionBtn.addEventListener('click', async () => {
      try {
        await fetch(`${ENV.API_BASE_URL}/session/${state.sessionId}/reset`, {
          method: 'POST',
          headers: { 'x-api-key': ENV.API_KEY || 'test-key-123' }
        });
        await new Promise(r => chrome.storage.local.remove(['seenKeys'], r));
        showMessage("History cleared on backend.", 'success');
      } catch (err) {
        showError("Failed to clear history");
      }
    });
  }

  const viewDashboardBtn = document.getElementById('viewDashboardBtn');
  if (viewDashboardBtn) {
    viewDashboardBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    });
  }
}

// HANDLE SEARCH
async function handleSearch() {
  const placeInput = document.getElementById('placeName');
  const locationInput = document.getElementById('location');
  const searchIdentifierInput = document.getElementById('searchIdentifier');
  const resultCountInput = document.getElementById('resultCount');
  const scrapeModeInput = document.getElementById('scrapeMode');

  const placeName = placeInput.value.trim();
  const location = locationInput.value.trim();
  const searchIdentifier = searchIdentifierInput ? searchIdentifierInput.value.trim() : '';
  const count = parseInt(resultCountInput.value, 10);
  const mode = scrapeModeInput.value;

  if (placeName.length < 2 || location.length < 2) {
    if (placeName.length < 2) placeInput.classList.add('shake');
    if (location.length < 2) locationInput.classList.add('shake');
    setTimeout(() => {
      placeInput.classList.remove('shake');
      locationInput.classList.remove('shake');
    }, 500);
    showError("Please enter valid search terms");
    return;
  }

  document.getElementById('searchSection').style.display = 'none';
  document.getElementById('progressSection').style.display = 'flex';
  
  state.isSearching = true;
  state.cancelRequested = false;
  state.results = [];
  chrome.storage.local.set({ cancelScrape: false });

  ['step1', 'step2', 'step3', 'step4', 'step5'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove('active', 'done', 'error');
  });

  try {
    // Step 1: Navigate to maps search URL
    setStep('step1', 'active');
    updateProgress(10, 'Navigating to maps...', 0, 0);
    const query = encodeURIComponent(`${placeName} in ${location}`);
    const searchUrl = `https://www.google.com/maps/search/${query}`;
    
    await navigateTab(state.currentTabId, searchUrl);
    setStep('step1', 'done');
    if (state.cancelRequested) return;

    // Step 2: Wait for results feed
    setStep('step2', 'active');
    updateProgress(20, 'Waiting for maps results...', 0, 0);
    
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.currentTabId },
        files: ['content/content.js']
      });
    } catch(e) {
      console.warn("Script injection possible duplicate:", e);
    }
    
    await new Promise(r => setTimeout(r, 500));
    
    const waitResponse = await sendContentMessage({ action: 'waitForResults' });
    if (!waitResponse || !waitResponse.success) {
      throw new Error(waitResponse?.error || 'Failed to detect results feed on page');
    }
    setStep('step2', 'done');
    if (state.cancelRequested) return;

    // Step 3: Scrape sidebar — scroll and collect all visible results
    setStep('step3', 'active');
    updateProgress(40, `Scrolling to find businesses...`, 0, count);

    // Pass empty seenKeys — we do global dedup AFTER sidebar scrape (see Step 3b below)
    // so the scroll isn't confused by cross-search placeId lists.
    const sidebarResponse = await sendContentMessage({ action: 'scrapeSidebar', count: count, seenKeys: [] });
    if (!sidebarResponse || !sidebarResponse.success || !sidebarResponse.results) {
      throw new Error('Failed to scrape sidebar results');
    }
    
    let businesses = sidebarResponse.results;
    setStep('step3', 'done');
    if (state.cancelRequested) return;

    // ── Step 3b: Global dedup — filter out businesses already in DB ─────────
    // We check ALL placeIds in the database (across every search term).
    // This catches "hotel karachi" returning hotels already saved via "hotel pakistan".
    let alreadyInDbCount = 0;
    if (businesses.length > 0) {
      updateProgress(55, `Checking ${businesses.length} results against database...`, 0, businesses.length);
      try {
        const placeIdsToCheck = businesses.map(b => b.placeId).filter(Boolean);
        const filterRes = await fetch(`${ENV.API_BASE_URL}/businesses/filter-new`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ENV.API_KEY },
          body: JSON.stringify({ placeIds: placeIdsToCheck })
        });
        if (filterRes.ok) {
          const filterData = await filterRes.json();
          const newPlaceIdSet = new Set(filterData.newPlaceIds || []);
          const filtered = businesses.filter(b => !b.placeId || newPlaceIdSet.has(b.placeId));
          alreadyInDbCount = businesses.length - filtered.length;
          businesses = filtered;

          if (alreadyInDbCount > 0) {
            updateProgress(55, `Skipped ${alreadyInDbCount} already-saved — ${businesses.length} new found`, 0, businesses.length);
            await new Promise(r => setTimeout(r, 800)); // let user read the message
          }
        }
      } catch (e) {
        console.warn('Global dedup check failed, proceeding with all results:', e);
      }
    }

    // If ALL scraped results were already in the DB, stop here
    if (businesses.length === 0) {
      setStep('step4', 'done');
      setStep('step5', 'done');
      updateProgress(100, 'All results already saved!', 0, 0);
      setTimeout(() => {
        renderResults([], alreadyInDbCount);
        showAlreadySavedMessage(alreadyInDbCount, placeName, location);
      }, 600);
      state.isSearching = false;
      return;
    }


    // Step 4: Full Details
    if (mode === 'full') {
       setStep('step4', 'active');
       updateProgress(60, 'Starting detail extraction...', 0, businesses.length);
       const detailResponse = await sendContentMessage({ action: 'scrapeDetails', businesses: businesses });
       if (!detailResponse || !detailResponse.success) {
          throw new Error('Failed to extract business details');
       }
       businesses = detailResponse.businesses;
       setStep('step4', 'done');
    } else {
       setStep('step4', 'done');
    }
    
    if (state.cancelRequested) return;

    // Step 5: Save to Database
    setStep('step5', 'active');
    updateProgress(90, 'Saving to database...', businesses.length, businesses.length);
    
    try {
      const dbResponse = await fetch(`${ENV.API_BASE_URL}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ENV.API_KEY
        },
        body: JSON.stringify({
          placeName,
          location,
          searchIdentifier: buildSearchIdentifier(placeName, location),
          scrapeMode: mode,
          sessionId: state.sessionId,
          businesses
        })
      });
      
      let data = { results: businesses, searchId: `local-${Date.now()}`, excluded: 0 };
      if (dbResponse.ok) {
        data = await dbResponse.json();
      } else {
        console.warn("Backend unavailable, using local mock response");
      }
      
      state.results = data.results || businesses;
      state.searchId = data.searchId;
      setStep('step5', 'done');

      // (We no longer save seenKeys to local storage to avoid memory issues and bugs)
      // Removed local storage update block.

      updateProgress(100, 'Complete!', businesses.length, businesses.length);
      setTimeout(() => renderResults(state.results, data.excluded || 0), 600);

    } catch (err) {
      console.warn("Backend request failed, showing local results", err);
      state.results = businesses;
      state.searchId = `local-${Date.now()}`;
      setStep('step5', 'done');
      updateProgress(100, 'Complete (Local only)!', businesses.length, businesses.length);
      setTimeout(() => renderResults(businesses, 0), 600);
    }

  } catch (err) {
    showError(err.message || "An error occurred during scrape");
    resetToSearch();
  }
}

// WRAPPER TO SEND MESSAGE TO CONTENT SCRIPT
function sendContentMessage(msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(state.currentTabId, msg, (response) => {
      if (chrome.runtime.lastError) {
         console.warn("Message error:", chrome.runtime.lastError.message);
         resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
         resolve(response);
      }
    });
  });
}

// PROGRESS HELPERS
function setStep(stepNum, status) {
  const el = document.getElementById(stepNum);
  if (!el) return;
  el.classList.remove('active', 'done', 'error');
  el.classList.add(status);
}

function updateProgress(percent, label, current, total) {
  const fill = document.getElementById('progressFill');
  const labelEl = document.getElementById('progressLabel');
  const countEl = document.getElementById('progressCount');
  
  if (fill) fill.style.width = percent + '%';
  if (labelEl) labelEl.textContent = label;
  if (countEl && total > 0) countEl.textContent = `${current} / ${total}`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'scrapeProgress') {
    updateProgress(msg.percent, msg.label, msg.current, msg.total);
  }
});

// RENDER RESULTS
function renderResults(results, excluded) {
  document.getElementById('progressSection').style.display = 'none';
  document.getElementById('resultsSection').style.display = 'flex';
  
  document.getElementById('resultsCount').textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
  
  const badge = document.getElementById('excludedBadge');
  if (excluded > 0) {
    badge.textContent = `${excluded} excluded`;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  state.selectedIds.clear();
  const listEl = document.getElementById('resultsList');
  listEl.innerHTML = '';
  
  if (results.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <p>No results found for this search.</p>
        <p style="font-size:12px; opacity:0.7">Try a different location or check if all results were deduplicated.</p>
      </div>`;
    return;
  }

  results.forEach((biz) => {
    const cardEl = document.createElement('div');
    cardEl.className = 'result-card';
    cardEl.dataset.id = biz.id || biz.placeId || biz.mapsUrl;
    cardEl.innerHTML = createResultCard(biz);
    
    // Toggle on card click
    cardEl.addEventListener('click', (e) => {
       if (e.target.tagName.toLowerCase() !== 'a' && e.target.tagName.toLowerCase() !== 'input') {
          toggleCard(cardEl.dataset.id);
       }
    });

    // Toggle on checkbox click
    const cb = cardEl.querySelector('.card-checkbox input');
    if (cb) {
       cb.addEventListener('change', () => {
          toggleCard(cardEl.dataset.id, cb.checked);
       });
    }

    listEl.appendChild(cardEl);
  });
}

function createResultCard(biz) {
  const id = biz.id || biz.placeId || biz.mapsUrl;
  const ratingStr = formatRating(biz.rating);
  const phoneHtml = biz.phone ? `
    <div class="detail-row">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      <a href="tel:${escapeHtml(biz.phone)}">${escapeHtml(biz.phone)}</a>
    </div>` : '';
    
  const webHtml = biz.website ? `
    <div class="detail-row">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      <a href="${escapeHtml(biz.website)}" target="_blank" title="${escapeHtml(biz.website)}">${escapeHtml(truncateUrl(biz.website))}</a>
    </div>` : '';

  return `
    <div class="card-checkbox">
      <input type="checkbox" id="cb_${id}">
    </div>
    <div class="card-content">
      <div class="card-header">
        <h3 class="card-title" title="${escapeHtml(biz.name)}">${escapeHtml(biz.name)}</h3>
        <a href="${escapeHtml(biz.mapsUrl)}" target="_blank" class="open-maps-link" title="Open in Maps">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
      </div>
      <div class="card-rating">
        ${biz.rating ? `<span class="stars">${ratingStr}</span> <span class="reviews-count">(${biz.reviewCount || 0})</span>` : '<span class="reviews-count">No rating</span>'}
        ${biz.category ? `<span class="card-badge">${escapeHtml(biz.category)}</span>` : ''}
      </div>
      <div class="card-details">
        ${biz.address ? `
        <div class="detail-row">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <span title="${escapeHtml(biz.address)}">${escapeHtml(biz.address)}</span>
        </div>` : ''}
        ${phoneHtml}
        ${webHtml}
      </div>
    </div>
  `;
}

// SELECTION
function toggleSelectAll() {
  const cards = document.querySelectorAll('.result-card');
  const allSelected = state.selectedIds.size === cards.length && cards.length > 0;
  
  cards.forEach(card => {
    const id = card.dataset.id;
    const cb = card.querySelector('.card-checkbox input');
    if (allSelected) {
      state.selectedIds.delete(id);
      card.classList.remove('selected');
      if (cb) cb.checked = false;
    } else {
      state.selectedIds.add(id);
      card.classList.add('selected');
      if (cb) cb.checked = true;
    }
  });
}

function toggleCard(id, forceState) {
  const card = document.querySelector(`.result-card[data-id="${id}"]`);
  if (!card) return;
  const cb = card.querySelector('.card-checkbox input');
  
  const isSelected = forceState !== undefined ? forceState : !state.selectedIds.has(id);
  
  if (isSelected) {
    state.selectedIds.add(id);
    card.classList.add('selected');
    if (cb) cb.checked = true;
  } else {
    state.selectedIds.delete(id);
    card.classList.remove('selected');
    if (cb) cb.checked = false;
  }
}

// EXPORT CSV
async function handleExport() {
  if (state.results.length === 0) return;

  const toExport = state.selectedIds.size > 0
    ? state.results.filter(r => state.selectedIds.has(r.id || r.placeId || r.mapsUrl))
    : state.results;

  // Fall back to local CSV generation if no valid backend searchId
  if (!state.searchId || typeof state.searchId !== 'string' || state.searchId.startsWith('local')) {
    generateLocalCSV(toExport);
    return;
  }

  try {
    const idsParams = toExport.map(b => b.id).filter(Boolean).join(',');
    const url = `${ENV.API_BASE_URL}/search/${state.searchId}/export?ids=${encodeURIComponent(idsParams)}`;

    // Must use fetch so we can send x-api-key header (bare <a> tags cannot)
    const resp = await fetch(url, {
      headers: { 'x-api-key': ENV.API_KEY }
    });

    if (!resp.ok) throw new Error(`Export request failed: ${resp.status}`);

    const blob = await resp.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `maps-leads-${formatDate()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(blobUrl);
  } catch (err) {
    console.warn('Backend export failed, falling back to local CSV:', err);
    generateLocalCSV(toExport);
  }
}

function generateLocalCSV(businesses) {
  const headers = ['Name', 'Category', 'Rating', 'Reviews', 'Address', 'Phone', 'Website', 'Maps URL'];
  const rows = [headers.join(',')];
  
  businesses.forEach(b => {
    const row = [
      `"${(b.name || '').replace(/"/g, '""')}"`,
      `"${(b.category || '').replace(/"/g, '""')}"`,
      b.rating || '',
      b.reviewCount || 0,
      `"${(b.address || '').replace(/"/g, '""')}"`,
      `"${(b.phone || '').replace(/"/g, '""')}"`,
      `"${(b.website || '').replace(/"/g, '""')}"`,
      `"${(b.mapsUrl || '').replace(/"/g, '""')}"`
    ];
    rows.push(row.join(','));
  });
  
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `local-maps-leads-${formatDate()}.csv`;
  a.click();
  window.URL.revokeObjectURL(url);
}

// RESET
function resetToSearch() {
  state.isSearching = false;
  state.results = [];
  document.getElementById('resultsSection').style.display = 'none';
  document.getElementById('progressSection').style.display = 'none';
  document.getElementById('searchSection').style.display = 'flex';
}

// STATUS DISPLAY
function showMessage(message, type = 'error') {
  const bar = document.getElementById('statusBar');
  const icon = document.getElementById('statusIcon');
  const text = document.getElementById('statusText');
  
  bar.className = `status-bar ${type}`;
  icon.textContent = type === 'error' ? '❌' : '✓';
  text.textContent = message;
  bar.style.display = 'flex';
  
  setTimeout(() => {
    bar.style.display = 'none';
  }, 4000);
}

function showError(message) {
  showMessage(message, 'error');
}

// Tab navigation helper
function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      chrome.tabs.onUpdated.addListener(function listener(id, info, tab) {
        if (id === tabId && info.status === 'complete' && tab.url && tab.url.includes('/maps/search')) {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 2000);
        }
      });
    });
  });
}

// ── Utility helpers ──────────────────────────────────────────────────────────

// Build a stable search identifier from place name + location (used for DB lookup)
function buildSearchIdentifier(placeName, location) {
  return `${placeName.toLowerCase().trim()}__${location.toLowerCase().trim()}`;
}

// Show a friendly message when all results are already in the database
function showAlreadySavedMessage(count, placeName, location) {
  const listEl = document.getElementById('resultsList');
  if (!listEl) return;
  listEl.innerHTML = `
    <div class="empty-state" style="text-align:center; padding: 24px 16px;">
      <div style="font-size: 32px; margin-bottom: 12px;">✅</div>
      <p style="font-weight: 600; font-size: 14px; margin-bottom: 8px;">All results already saved!</p>
      <p style="font-size: 12px; opacity: 0.7; margin-bottom: 16px;">
        All <strong>${count}</strong> known results for <em>${escapeHtml(placeName)} in ${escapeHtml(location)}</em> are already in your database.
      </p>
      <p style="font-size: 11px; opacity: 0.55;">View them in the Dashboard or try a different search to find more.</p>
    </div>`;
}

function generateSessionId() {
  return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 9);
}

function formatDate() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url.length > 40 ? url.substring(0, 37) + '...' : url;
  }
}

function formatRating(rating) {
  if (!rating) return '';
  const r = parseFloat(rating);
  if (isNaN(r)) return '';
  const full  = Math.floor(r);
  const half  = r - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}
