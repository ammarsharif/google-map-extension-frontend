document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const leadsBody = document.getElementById('leadsBody');
  const searchInput = document.getElementById('searchInput');
  const totalSavedCount = document.getElementById('totalSavedCount');
  const paginationLabel = document.getElementById('paginationLabel');
  const pageNumbers = document.getElementById('pageNumbers');
  const prevPageBtn = document.getElementById('prevPage');
  const nextPageBtn = document.getElementById('nextPage');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const emptyState = document.getElementById('emptyState');
  const refreshBtn = document.getElementById('refreshBtn');
  const exportAllBtn = document.getElementById('exportAllBtn');

  // State
  let currentPage = 1;
  const limit = 10;
  let searchTask = null;
  let totalSaved = 0;

  // Initialize
  fetchLeads();

  // Event Listeners
  refreshBtn.addEventListener('click', () => {
    currentPage = 1;
    fetchLeads();
  });

  exportAllBtn.addEventListener('click', async () => {
    try {
      const response = await fetch(`${ENV.API_BASE_URL}/businesses/export`, {
        headers: { 'x-api-key': ENV.API_KEY || 'test-key-123' }
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `all-leads-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error(err);
      alert('Failed to export leads. Ensure backend is running.');
    }
  });

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTask);
    searchTask = setTimeout(() => {
      currentPage = 1;
      fetchLeads();
    }, 500);
  });


  prevPageBtn.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      fetchLeads();
    }
  });

  nextPageBtn.addEventListener('click', () => {
    currentPage++;
    fetchLeads();
  });

  // Functions
  async function fetchLeads() {
    showLoading(true);
    
    const searchTerm = searchInput.value.trim();
    
    let url = `${ENV.API_BASE_URL}/businesses?page=${currentPage}&limit=${limit}`;
    if (searchTerm) url += `&search=${encodeURIComponent(searchTerm)}`;

    try {
      const response = await fetch(url, {
        headers: { 'x-api-key': ENV.API_KEY || 'test-key-123' }
      });
      const data = await response.json();

      if (data.success) {
        renderLeads(data.businesses);
        updatePagination(data.pagination);
        updateStats(data.pagination.total);
        if (currentPage === 1 && !searchTerm) {
          totalSaved = data.pagination.total;
          totalSavedCount.textContent = totalSaved.toLocaleString();
        }
      } else {
        console.error('Failed to fetch leads:', data.error);
      }
    } catch (error) {
      console.error('Error fetching leads:', error);
    } finally {
      showLoading(false);
    }
  }

  function renderLeads(leads) {
    leadsBody.innerHTML = '';
    
    if (leads.length === 0) {
      emptyState.style.display = 'flex';
      return;
    }
    
    emptyState.style.display = 'none';

    leads.forEach(lead => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="business-name-cell">
          <div style="display: flex; flex-direction: column;">
            <span>${lead.name}</span>
            <span style="font-size: 11px; color: var(--text-dim); font-weight: normal;">ID: ${lead.placeId || lead._id}</span>
            ${lead.searchIdentifier ? `<span style="font-size: 11px; color: var(--accent); font-weight: 500; margin-top: 2px;">Tag: ${lead.searchIdentifier}</span>` : ''}
          </div>
        </td>
        <td>
          <span class="category-badge">${lead.category || 'N/A'}</span>
        </td>
        <td>
          ${lead.rating ? `
            <div class="rating-pill">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
              ${lead.rating} (${lead.reviewCount || 0})
            </div>
          ` : '<span style="color: var(--text-dim)">-</span>'}
        </td>
        <td>${lead.phone || '<span style="color: var(--text-dim)">No phone</span>'}</td>
        <td style="max-width: 15rem">
          ${lead.website ? `
            <a href="${lead.website}" target="_blank" class="status-link address-cell" title="${lead.website}">
              ${lead.website.replace(/^https?:\/\/(www\.)?/, '').substring(0, 30)}...
            </a>
          ` : '<span style="color: var(--text-dim)">-</span>'}
        </td>
        <td class="address-cell" title="${lead.address}">
          ${lead.address || 'N/A'}
        </td>
        <td>
          <div style="display: flex; gap: 8px;">
            <a href="${lead.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.name + ' ' + (lead.address || ''))}`}" 
               target="_blank" class="action-btn" title="View on Maps">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
            </a>
            <button class="action-btn copy-btn" data-phone="${lead.phone || ''}" title="Copy Phone">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
        </td>
      `;
      
      const copyBtn = row.querySelector('.copy-btn');
      copyBtn.addEventListener('click', (e) => {
        const phone = e.currentTarget.getAttribute('data-phone');
        if (phone) {
          navigator.clipboard.writeText(phone);
          const originalHTML = e.currentTarget.innerHTML;
          e.currentTarget.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
          setTimeout(() => e.currentTarget.innerHTML = originalHTML, 2000);
        }
      });

      leadsBody.appendChild(row);
    });
  }

  function updatePagination(pagination) {
    const { page, pages, total } = pagination;
    paginationLabel.textContent = `Showing page ${page} of ${pages} (${total} total)`;
    
    prevPageBtn.disabled = page === 1;
    nextPageBtn.disabled = page >= pages;
    
    pageNumbers.innerHTML = '';
    
    // Show max 5 page numbers
    let start = Math.max(1, page - 2);
    let end = Math.min(pages, start + 4);
    if (end - start < 4) start = Math.max(1, end - 4);

    for (let i = start; i <= end; i++) {
        const btn = document.createElement('button');
        btn.className = `page-btn ${i === page ? 'active' : ''}`;
        btn.textContent = i;
        btn.addEventListener('click', () => {
            currentPage = i;
            fetchLeads();
        });
        pageNumbers.appendChild(btn);
    }
  }

  function updateStats(total) {
    totalSavedCount.textContent = total.toLocaleString();
  }


  function showLoading(show) {
    loadingOverlay.style.display = show ? 'flex' : 'none';
  }
});
