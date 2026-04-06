// Shared utilities loaded in popup

function generateSessionId() {
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function formatRating(rating) {
  if (!rating) return '';
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  let stars = '★'.repeat(full);
  if (half) stars += '½';
  return stars;
}

function truncateUrl(url, maxLen = 30) {
  if (!url) return '';
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    return domain.length > maxLen ? domain.substr(0, maxLen) + '...' : domain;
  } catch { return url.substr(0, maxLen); }
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

function formatDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Deep fallback selector — tries each selector, returns first match's text
function trySelectors(element, selectors) {
  for (const sel of selectors) {
    try {
      const el = element.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    } catch {}
  }
  return null;
}
