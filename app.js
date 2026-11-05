// ── Bookmarklet (save current page into 踩點 from anywhere) ─────────────────────
const BOOKMARKLET = `javascript:(function(){var sel=window.getSelection().toString().trim();var p=new URLSearchParams({url:location.href,title:document.title,name:sel});var w=window.open('http://localhost:7999/quick.html?'+p.toString(),'cafe_quick','width=440,height=920,top=40,left=200');if(!w||w.closed)window.open('http://localhost:7999/quick.html?'+p.toString(),'_blank');})();`;

// ── Type helpers (comma-separated multi-select) ────────────────────────────────
function typeToArr(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}
function arrToType(arr) { return arr.join(','); }
function typesIncludes(cafeType, t) { return typeToArr(cafeType).includes(t); }

function initTypePicker(selectedStr) {
  const selected = typeToArr(selectedStr);
  document.getElementById('field-type').value = selectedStr || '';
  document.querySelectorAll('.type-pick-chip').forEach(chip => {
    chip.classList.toggle('selected', selected.includes(chip.dataset.val));
  });
}

document.getElementById('type-picker').addEventListener('click', e => {
  const chip = e.target.closest('.type-pick-chip');
  if (!chip) return;
  const input = document.getElementById('field-type');
  const selected = typeToArr(input.value);
  const val = chip.dataset.val;
  const idx = selected.indexOf(val);
  if (idx === -1) selected.push(val);
  else selected.splice(idx, 1);
  input.value = arrToType(selected);
  chip.classList.toggle('selected', selected.includes(val));
});

function updateSourceUrlBtns() {
  const url = document.getElementById('field-source-url').value.trim();
  document.getElementById('btn-copy-url').classList.toggle('hidden', !url);
  const btnOpen = document.getElementById('btn-open-url');
  btnOpen.classList.toggle('hidden', !url);
  if (url) btnOpen.href = url;
}

// ── API layer ─────────────────────────────────────────────────────────────────
const API = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async put(url, data) {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
};

// cache a Google photo URL to local server; returns local path
async function cachePhoto(url) {
  if (!url || url.startsWith('data:') || url.startsWith('/photos/')) return url;
  try {
    const res = await API.post('/api/photos/cache', { url });
    return res.url;
  } catch (e) {
    return url; // fallback to original if cache fails
  }
}

// ── State ──────────────────────────────────────────────────────────────────────
const READONLY = true; // places.json static mode (no FastAPI)
let collections     = [];
let activeCollectionId = localStorage.getItem('activeCollection') || 'default';
let allCafes        = []; // full dump; cafes = current collection slice
let cafes           = [];
let currentPlace   = null;
let editingId      = null;
let selectedRating = 0;
let tempVisits     = [];
let tempTags       = [];
let activeTab      = 'list';
let activeStatuses  = new Set();
let activeKeyword   = '';
let activeTypes     = new Set();
let activeCities    = new Set();
let activeDistricts = new Set();
let activeView     = 'grid'; // 'grid' | 'list'
let timelinePeriod = 'month';
let placesService  = null;
let pendingPhotoUrl = null; // photo staged in modal before save

// Map state
let map            = null;
let markers        = [];
let infoWindow     = null;
let mapInitialized = false;

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Optional Maps key for 地圖 tab only — never block browse UI
  const apiKey = localStorage.getItem('gmaps_api_key') || '';
  if (apiKey) loadGoogleMaps(apiKey);

  try {
    const data = await fetch('./places.json', { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error('places.json HTTP ' + r.status);
      return r.json();
    });
    collections = Array.isArray(data.collections) ? data.collections : [];
    allCafes = Array.isArray(data.cafes) ? data.cafes : [];
  } catch (e) {
    console.error('載入 places.json 失敗', e);
    collections = [];
    allCafes = [];
    const grid = document.getElementById('cafe-grid');
    if (grid) {
      grid.innerHTML = '<div class="empty-state"><div class="icon">📍</div><p>無法載入 places.json<br>請確認檔案在同一資料夾</p></div>';
    }
  }

  if (collections.length === 0 && allCafes.length) {
    collections = [{ id: 'all', name: '全部' }];
    allCafes.forEach(c => { c.collectionId = c.collectionId || 'all'; });
  }

  if (!collections.find(c => c.id === activeCollectionId)) {
    activeCollectionId = collections[0]?.id || 'all';
    localStorage.setItem('activeCollection', activeCollectionId);
  }

  cafes = allCafes.filter(c => c.collectionId === activeCollectionId);

  applyReadonlyChrome();
  renderCollectionPills();
  try { updateAllFilters(); } catch (e) { console.error('updateAllFilters 失敗', e); }
  renderCafes();
  bindEvents();
});

function applyReadonlyChrome() {
  if (!READONLY) return;
  const hideIds = [
    'search-container', 'refresh-btn', 'bookmark-btn', 'settings-btn',
    'btn-add-collection', 'bookmark-modal', 'setup-modal',
  ];
  hideIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  // subtitle badge
  const h1 = document.querySelector('header h1');
  if (h1 && !document.getElementById('readonly-badge')) {
    const badge = document.createElement('span');
    badge.id = 'readonly-badge';
    badge.textContent = '本機匯出・唯讀';
    badge.style.cssText = 'margin-left:10px;font-size:.72rem;font-weight:600;color:#888;vertical-align:middle;border:1px solid #ddd;border-radius:999px;padding:2px 8px;';
    h1.appendChild(badge);
  }
  const emptyHint = document.querySelector('.empty-state p');
  void emptyHint;
}

function linkButtonsHtml(cafe) {
  const src = cafe.sourceUrl || '';
  const ig = /instagram/i.test(src) ? src : '';
  const th = /threads\.(com|net)/i.test(src) ? src : '';
  const map = cafe.mapsUrl || (cafe.placeId ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(cafe.placeId)}` : '');
  const btn = (label, url, cls) => url
    ? `<a class="card-link-btn ${cls}" href="${esc(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${label}</a>`
    : `<span class="card-link-btn ${cls} is-disabled" aria-disabled="true" onclick="event.stopPropagation()">${label}</span>`;
  return `<div class="card-links">${btn('IG', ig, 'is-ig')}${btn('THREADS', th, 'is-threads')}${btn('MAP', map, 'is-map')}</div>`;
}

function openPlaceLink(cafe) {
  // Priority: IG/Threads/source first, then Google Maps. Never open Notion.
  const maps = cafe.mapsUrl || (cafe.placeId ? `https://www.google.com/maps/place/?q=place_id:${cafe.placeId}` : '');
  const url = cafe.sourceUrl || maps || '';
  if (url) window.open(url, '_blank', 'noopener');
  else alert('這個地點還沒有推薦連結或地圖');
}

// Click backdrop to close, only if both press and release land on the empty backdrop
// (so selecting text inside the modal and releasing the mouse outside it doesn't close it)
function bindBackdropClose(el, onClose) {
  let downOnBackdrop = false;
  el.addEventListener('mousedown', e => { downOnBackdrop = (e.target === el); });
  el.addEventListener('click', e => {
    if (downOnBackdrop && e.target === el) onClose();
    downOnBackdrop = false;
  });
}

function bindEvents() {
  // API Key
  document.getElementById('save-api-key').addEventListener('click', saveApiKey);
  document.getElementById('api-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });
  document.getElementById('settings-btn')?.addEventListener('click', showSetupModal);
  bindBackdropClose(document.getElementById('setup-modal'), () => {
    if (localStorage.getItem('gmaps_api_key'))
      document.getElementById('setup-modal').classList.add('hidden'); // only dismiss if key already set
  });

  // Bookmarklet install
  document.getElementById('bookmarklet-link').href = BOOKMARKLET;
  document.getElementById('bookmark-btn')?.addEventListener('click', () => {
    document.getElementById('bookmark-modal').classList.remove('hidden');
  });
  document.getElementById('bookmark-modal-close').addEventListener('click', () => {
    document.getElementById('bookmark-modal').classList.add('hidden');
  });
  bindBackdropClose(document.getElementById('bookmark-modal'), () => {
    document.getElementById('bookmark-modal').classList.add('hidden');
  });

  // Cafe modal
  document.getElementById('close-modal').addEventListener('click', closeCafeModal);
  document.getElementById('save-cafe').addEventListener('click', handleSaveCafe);
  document.getElementById('delete-cafe').addEventListener('click', handleDeleteCafe);
  bindBackdropClose(document.getElementById('cafe-modal'), closeCafeModal);
  // Source URL buttons
  document.getElementById('field-source-url').addEventListener('input', updateSourceUrlBtns);
  document.getElementById('btn-copy-url').addEventListener('click', () => {
    const url = document.getElementById('field-source-url').value.trim();
    if (!url) return;
    const btn = document.getElementById('btn-copy-url');
    navigator.clipboard.writeText(url).then(() => {
      btn.title = '已複製！';
      setTimeout(() => { btn.title = '複製連結'; }, 1500);
    });
  });
  updateSourceUrlBtns();

  document.getElementById('btn-fetch-photo').addEventListener('click', fetchPhotoForEditing);
  document.getElementById('btn-remove-photo').addEventListener('click', removePhoto);
  document.getElementById('upload-photo').addEventListener('change', e => handlePhotoUpload(e.target.files[0]));
  document.getElementById('upload-photo-replace').addEventListener('change', e => handlePhotoUpload(e.target.files[0]));

  // View toggle
  document.getElementById('btn-view-grid').addEventListener('click', () => setView('grid'));
  document.getElementById('btn-view-list').addEventListener('click', () => setView('list'));

  // Stars
  const ratingEl = document.getElementById('field-rating');
  ratingEl.querySelectorAll('.star').forEach(star => {
    star.addEventListener('click', () => { selectedRating = +star.dataset.value; renderStarInput(selectedRating); });
    star.addEventListener('mouseenter', () => renderStarInput(+star.dataset.value));
  });
  ratingEl.addEventListener('mouseleave', () => renderStarInput(selectedRating));

  // Tag input
  const tagInput = document.getElementById('tag-input');
  tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = tagInput.value.trim().replace(/,/g, '');
      if (val && !tempTags.includes(val)) { tempTags.push(val); renderTagChips(); }
      tagInput.value = '';
    }
    if (e.key === 'Backspace' && tagInput.value === '' && tempTags.length > 0) {
      tempTags.pop(); renderTagChips();
    }
  });
  document.getElementById('tag-input-wrap').addEventListener('click', () => tagInput.focus());

  // Visit records
  document.getElementById('btn-add-visit').addEventListener('click', () => {
    const row = document.getElementById('new-visit-row');
    row.classList.remove('hidden');
    const dateInput = document.getElementById('new-visit-date');
    dateInput.value = todayStr();
    dateInput.focus();
  });
  document.getElementById('btn-confirm-visit').addEventListener('click', confirmAddVisit);
  document.getElementById('btn-cancel-visit').addEventListener('click', () => {
    document.getElementById('new-visit-row').classList.add('hidden');
  });
  document.getElementById('new-visit-date').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmAddVisit();
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Status pills (sidebar) — multi-select
  document.querySelectorAll('.status-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const s = pill.dataset.status;
      if (activeStatuses.has(s)) activeStatuses.delete(s);
      else activeStatuses.add(s);
      document.querySelectorAll('.status-pill').forEach(p =>
        p.classList.toggle('active', activeStatuses.has(p.dataset.status))
      );
      rerender();
    });
  });

  // Keyword search
  document.getElementById('filter-keyword').addEventListener('input', e => {
    activeKeyword = e.target.value.trim();
    rerender();
  });

  // Sort
  document.getElementById('filter-sort').addEventListener('change', rerender);

  // Timeline sub-tabs
  document.querySelectorAll('.timeline-sub-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      timelinePeriod = btn.dataset.period;
      document.querySelectorAll('.timeline-sub-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.period === timelinePeriod)
      );
      renderTimeline();
    });
  });

  // Collections
  document.getElementById('btn-add-collection')?.addEventListener('click', addCollection);

  // Refresh all
  document.getElementById('refresh-btn')?.addEventListener('click', refreshAllPlaces);

  // Export / Import
  document.getElementById('export-btn').addEventListener('click', () =>
    document.getElementById('export-modal').classList.remove('hidden')
  );
  document.getElementById('close-export-modal').addEventListener('click', () =>
    document.getElementById('export-modal').classList.add('hidden')
  );
  document.getElementById('export-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('export-modal'))
      document.getElementById('export-modal').classList.add('hidden');
  });
  document.getElementById('btn-export-json').addEventListener('click', exportJSON);
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
  document.getElementById('import-file').addEventListener('change', importJSON);
}

// ── Collections ────────────────────────────────────────────────────────────────
function renderCollectionPills() {
  const container = document.getElementById('collection-pills');
  container.innerHTML = collections.map(col => `
    <div class="collection-pill-wrap">
      <button class="collection-pill ${col.id === activeCollectionId ? 'active' : ''}"
              data-id="${esc(col.id)}">
        ${esc(col.name)}
      </button>
    </div>`).join('');

  container.querySelectorAll('.collection-pill').forEach(btn => {
    btn.addEventListener('click', () => switchCollection(btn.dataset.id));
  });
}

async function switchCollection(id) {
  activeCollectionId = id;
  localStorage.setItem('activeCollection', id);
  cafes = allCafes.filter(c => c.collectionId === id);
  renderCollectionPills();
  updateAllFilters();
  rerender();
}

async function addCollection() {
  if (READONLY) { alert('唯讀模式：請更新本機踩點後再匯出'); return; }
  const name = prompt('新分類名稱（例如：日本旅遊、首爾踩點）：');
  if (!name?.trim()) return;
  const id = 'col_' + Date.now();
  const col = await API.post('/api/collections', { id, name: name.trim() });
  collections.push(col);
  await switchCollection(id);
}

async function renameCollection(id) {
  if (READONLY) return;
  const col = collections.find(c => c.id === id);
  if (!col) return;
  const name = prompt('分類名稱：', col.name);
  if (!name?.trim() || name.trim() === col.name) return;
  col.name = name.trim();
  await API.put(`/api/collections/${id}`, { name: col.name });
  renderCollectionPills();
}

async function deleteCollection(id) {
  if (READONLY) return;
  if (collections.length <= 1) { alert('至少需要保留一個分類'); return; }
  const col = collections.find(c => c.id === id);
  const colCafes = await API.get(`/api/collections/${id}/cafes`);
  const count = colCafes.length;
  const msg = count > 0
    ? `確定刪除「${col?.name}」？此分類內的 ${count} 筆記錄將一併刪除。`
    : `確定刪除「${col?.name}」？`;
  if (!confirm(msg)) return;
  await API.del(`/api/collections/${id}`);
  collections = collections.filter(c => c.id !== id);
  if (activeCollectionId === id) {
    await switchCollection(collections[0].id);
  } else {
    renderCollectionPills();
  }
}

// ── Tabs ───────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('view-list').classList.toggle('hidden', tab !== 'list');
  document.getElementById('view-timeline').classList.toggle('hidden', tab !== 'timeline');
  document.getElementById('view-map').classList.toggle('hidden', tab !== 'map');
  rerender();
}

function rerender() {
  if (activeTab === 'list')           renderCafes();
  else if (activeTab === 'timeline')  renderTimeline();
  else if (activeTab === 'map')       renderMap();
}

// ── Google Maps ────────────────────────────────────────────────────────────────
function loadGoogleMaps(apiKey) {
  if (window.google && window.google.maps) { initAutocomplete(); return; }
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&language=zh-TW&callback=_mapsReady`;
  script.onerror = () => { alert('Google Maps 載入失敗，請確認 API Key 是否正確'); showSetupModal(); };
  window._mapsReady = initAutocomplete;
  document.head.appendChild(script);
}

function showDupModal(existing, onAddAnyway) {
  document.getElementById('dup-name').textContent = existing.name;
  document.getElementById('dup-modal').classList.remove('hidden');

  const close = () => document.getElementById('dup-modal').classList.add('hidden');

  document.getElementById('close-dup-modal').onclick = close;
  document.getElementById('dup-view').onclick = () => { close(); openEditModal(existing.id); };
  document.getElementById('dup-add').onclick  = () => { close(); onAddAnyway(); };
}

function initAutocomplete() {
  placesService = new google.maps.places.PlacesService(document.createElement('div'));
  const input = document.getElementById('search-input');
  const ac = new google.maps.places.Autocomplete(input, {
    types: ['establishment'],
    fields: ['place_id', 'name', 'formatted_address'],
  });
  ac.addListener('place_changed', () => {
    const basic = ac.getPlace();
    if (!basic?.place_id) return;
    input.value = '';

    const proceed = () => {
      placesService.getDetails({
        placeId: basic.place_id,
        fields: ['place_id', 'name', 'formatted_address', 'opening_hours', 'rating', 'user_ratings_total', 'geometry', 'photos', 'utc_offset_minutes'],
      }, (details, status) => {
        openAddModal(status === google.maps.places.PlacesServiceStatus.OK && details ? details : basic);
      });
    };

    const existing = cafes.find(c => c.placeId === basic.place_id);
    if (existing) {
      showDupModal(existing, proceed);
    } else {
      proceed();
    }
  });
}

// ── API Key ────────────────────────────────────────────────────────────────────
function showSetupModal() {
  document.getElementById('api-key-input').value = localStorage.getItem('gmaps_api_key') || '';
  document.getElementById('setup-modal').classList.remove('hidden');
}
async function saveApiKey() {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) { alert('請輸入 API Key'); return; }
  localStorage.setItem('gmaps_api_key', key);
  try { await API.post('/api/config', { gmaps_api_key: key }); } catch {}
  document.getElementById('setup-modal').classList.add('hidden');
  if (!window.google) loadGoogleMaps(key);
}

// ── Modal ──────────────────────────────────────────────────────────────────────
async function openAddModal(place) {
  currentPlace = place; editingId = null; selectedRating = 0; tempVisits = []; tempTags = [];

  document.getElementById('modal-title').textContent = '新增地點';
  document.getElementById('modal-cafe-name').textContent = place.name || '';

  const address = normalizeTw(place.formatted_address || '');
  document.getElementById('modal-cafe-address').textContent = address;

  const gEl = document.getElementById('modal-google-rating');
  if (place.rating) {
    const total = place.user_ratings_total ? ` (${place.user_ratings_total.toLocaleString()} 則評論)` : '';
    gEl.textContent = `Google ★ ${place.rating}${total}`;
    gEl.classList.remove('hidden');
  } else { gEl.classList.add('hidden'); }

  const hours = place.opening_hours?.weekday_text;
  document.getElementById('modal-cafe-hours').textContent = hours ? hours.map(normalizeTw).join('\n') : '';

  const rawPhotoUrl = place.photos?.[0]?.getUrl({ maxWidth: 800 }) || null;
  const photoUrl = rawPhotoUrl ? await cachePhoto(rawPhotoUrl) : null;
  currentPlace._photoUrl = photoUrl;
  pendingPhotoUrl = photoUrl;
  setModalPhoto(photoUrl, false);

  resetForm();
  document.getElementById('field-city').value     = extractCity(address);
  document.getElementById('field-district').value = extractDistrict(address);

  document.getElementById('delete-cafe').classList.add('hidden');
  document.getElementById('new-visit-row').classList.add('hidden');
  renderTagChips();
  renderVisitsList();
  document.getElementById('cafe-modal').classList.remove('hidden');
}

function openEditModal(id) {
  const cafe = (cafes.find(c => c.id === id) || allCafes.find(c => c.id === id));
  if (!cafe) return;
  if (READONLY) {
    // Card click no longer navigates; use IG / THREADS / MAP buttons.
    return;
  }

  editingId = id; currentPlace = null; selectedRating = cafe.rating || 0;
  tempVisits = [...(cafe.visits || [])];
  tempTags   = [...(cafe.tags   || [])];

  document.getElementById('modal-title').textContent = '編輯地點';
  document.getElementById('modal-cafe-name').textContent = cafe.name;
  document.getElementById('modal-cafe-address').textContent = cafe.address || '';

  const gEl = document.getElementById('modal-google-rating');
  if (cafe.googleRating) { gEl.textContent = `Google ★ ${cafe.googleRating}`; gEl.classList.remove('hidden'); }
  else { gEl.classList.add('hidden'); }

  document.getElementById('modal-cafe-hours').textContent = cafe.hours || '';

  pendingPhotoUrl = cafe.photoUrl || null;
  setModalPhoto(cafe.photoUrl || null, !!cafe.placeId);

  initTypePicker(cafe.type || '');
  document.getElementById('field-city').value      = cafe.city      || '';
  document.getElementById('field-district').value  = cafe.district  || '';
  document.getElementById('field-notes').value      = cafe.notes     || '';
  document.getElementById('field-source-url').value = cafe.sourceUrl || '';
  updateSourceUrlBtns();
  renderStarInput(selectedRating);

  document.getElementById('delete-cafe').classList.remove('hidden');
  document.getElementById('new-visit-row').classList.add('hidden');
  renderTagChips();
  renderVisitsList();
  document.getElementById('cafe-modal').classList.remove('hidden');
}

function closeCafeModal() {
  document.getElementById('cafe-modal').classList.add('hidden');
  currentPlace = null; editingId = null; pendingPhotoUrl = null;
}

function resetForm() {
  initTypePicker('');
  document.getElementById('field-city').value      = '';
  document.getElementById('field-district').value  = '';
  document.getElementById('field-notes').value      = '';
  document.getElementById('field-source-url').value = '';
  updateSourceUrlBtns();
  renderStarInput(0);
}

// ── Tag Chips ──────────────────────────────────────────────────────────────────
function renderTagChips() {
  const wrap  = document.getElementById('tag-input-wrap');
  const input = document.getElementById('tag-input');
  wrap.querySelectorAll('.tag-chip').forEach(c => c.remove());
  tempTags.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `${esc(tag)}<button class="tag-remove" data-i="${i}" tabindex="-1">×</button>`;
    wrap.insertBefore(chip, input);
  });
  wrap.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      tempTags.splice(+btn.dataset.i, 1);
      renderTagChips();
    });
  });
}

// ── Visit Records ──────────────────────────────────────────────────────────────
function confirmAddVisit() {
  const date = document.getElementById('new-visit-date').value;
  if (!date) return;
  const costVal = document.getElementById('new-visit-cost').value;
  const cost = costVal !== '' ? parseFloat(costVal) : null;
  tempVisits.push({ id: Date.now().toString(), date, cost });
  tempVisits.sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById('new-visit-row').classList.add('hidden');
  document.getElementById('new-visit-cost').value = '';
  renderVisitsList();
}

function renderVisitsList() {
  const list = document.getElementById('visits-list');
  if (tempVisits.length === 0) {
    list.innerHTML = '<div class="no-visits">尚無造訪記錄</div>'; return;
  }
  const sorted = [...tempVisits].sort((a, b) => b.date.localeCompare(a.date));
  list.innerHTML = sorted.map(v => `
    <div class="visit-item">
      <span class="visit-date-text">${formatDate(v.date)}</span>
      ${v.cost != null ? `<span class="visit-cost">${formatCost(v.cost)}</span>` : ''}
      <button class="btn-remove-visit" data-vid="${esc(v.id)}" title="刪除">×</button>
    </div>`).join('');
  list.querySelectorAll('.btn-remove-visit').forEach(btn => {
    btn.addEventListener('click', () => {
      tempVisits = tempVisits.filter(v => v.id !== btn.dataset.vid);
      renderVisitsList();
    });
  });
}

// ── Save / Delete ──────────────────────────────────────────────────────────────
async function handleSaveCafe() {
  if (READONLY) { alert('唯讀模式：請在本機踩點編輯後再匯出'); return; }
  const data = {
    type:      document.getElementById('field-type').value.trim(),
    city:      document.getElementById('field-city').value.trim(),
    district:  document.getElementById('field-district').value.trim(),
    notes:     document.getElementById('field-notes').value.trim(),
    sourceUrl: document.getElementById('field-source-url').value.trim(),
    rating:    selectedRating,
    visits:    tempVisits,
    tags:      tempTags,
    photoUrl:  pendingPhotoUrl,
  };

  if (editingId) {
    const updated = await API.put(`/api/cafes/${editingId}`, data);
    const idx = cafes.findIndex(c => c.id === editingId);
    if (idx !== -1) cafes[idx] = updated;
  } else if (currentPlace) {
    const newCafe = {
      id:                  Date.now().toString(),
      collectionId:        activeCollectionId,
      placeId:             currentPlace.place_id || '',
      name:                currentPlace.name,
      address:             normalizeTw(currentPlace.formatted_address || ''),
      hours:               currentPlace.opening_hours?.weekday_text?.map(normalizeTw).join('\n') || '',
      googleRating:        currentPlace.rating || null,
      googleRatingsTotal:  currentPlace.user_ratings_total || null,
      periods:             currentPlace.opening_hours?.periods
                             ? JSON.parse(JSON.stringify(currentPlace.opening_hours.periods)) : [],
      lat:                 currentPlace.geometry?.location?.lat() || null,
      lng:                 currentPlace.geometry?.location?.lng() || null,
      createdAt:           new Date().toISOString(),
      favorite:            false,
      ...data,
    };
    const created = await API.post('/api/cafes', newCafe);
    cafes.unshift(created);
  }

  updateAllFilters();
  rerender();

  if (document.getElementById('sync-to-brain')?.checked) {
    if (!editingId && currentPlace) {
      await syncCafeToBrain({
        name:     currentPlace.name,
        place_id: currentPlace.place_id || '',
        address:  normalizeTw(currentPlace.formatted_address || ''),
        notes:    document.getElementById('field-notes').value.trim(),
      });
    } else if (editingId) {
      const cafe = cafes.find(c => c.id === editingId);
      if (cafe) await syncCafeToBrain(cafe);
    }
  }

  closeCafeModal();
}

async function syncCafeToBrain(cafe) {
  const pid = cafe.placeId || cafe.place_id || '';
  const mapsUrl = pid ? `https://maps.google.com/maps?q=place_id:${pid}` : '';
  try {
    await fetch('http://localhost:8001/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title:   cafe.name,
        content: cafe.address || '',
        url:     mapsUrl,
        notes:   cafe.notes || '',
        tags:    ['踩點'],
      }),
    });
  } catch {
    alert('Brain 同步失敗，請確認 Brain 正在執行中（port 8001）');
  }
}

async function handleDeleteCafe() {
  if (READONLY) return;
  if (!editingId || !confirm('確定要刪除這個地點嗎？')) return;
  await API.del(`/api/cafes/${editingId}`);
  cafes = cafes.filter(c => c.id !== editingId);
  updateAllFilters();
  rerender();
  closeCafeModal();
}

// ── Star Input ─────────────────────────────────────────────────────────────────
function renderStarInput(value) {
  document.querySelectorAll('#field-rating .star').forEach((s, i) => s.classList.toggle('active', i < value));
}

// ── List Render ────────────────────────────────────────────────────────────────
function getFiltered() {
  const sort = document.getElementById('filter-sort').value;

  const kw = activeKeyword.toLowerCase();
  const filtered = cafes.filter(c => {
    if (activeTypes.size && !typeToArr(c.type).some(t => activeTypes.has(t))) return false;
    if (activeCities.size && !activeCities.has(c.city)) return false;
    if (activeDistricts.size && !activeDistricts.has(c.district)) return false;
    if (activeStatuses.size) {
      const ok =
        (activeStatuses.has('visited')   && (c.visits?.length > 0)) ||
        (activeStatuses.has('unvisited') && (!c.visits || c.visits.length === 0)) ||
        (activeStatuses.has('fav')       && c.favorite) ||
        (activeStatuses.has('open')      && getTodayStatus(c)?.openNow === true);
      if (!ok) return false;
    }
    if (kw) {
      const haystack = [c.name, c.address, c.notes, ...(c.tags || []), c.type, c.city, c.district]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(kw)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    switch (sort) {
      case 'rating':
        return (b.rating || 0) - (a.rating || 0);
      case 'visits':
        return (b.visits?.length || 0) - (a.visits?.length || 0);
      case 'recent': {
        const la = a.visits?.length ? a.visits.slice().sort((x,y) => y.date.localeCompare(x.date))[0].date : '';
        const lb = b.visits?.length ? b.visits.slice().sort((x,y) => y.date.localeCompare(x.date))[0].date : '';
        return lb.localeCompare(la);
      }
      case 'name':
        return a.name.localeCompare(b.name, 'zh-TW');
      case 'newest':
      default:
        return (b.createdAt || '').localeCompare(a.createdAt || '');
    }
  });

  return filtered;
}

function renderCafes() {
  const container = document.getElementById('cafe-grid');
  const filtered  = getFiltered();
  document.getElementById('cafe-count').textContent =
    cafes.length ? `${filtered.length} / ${cafes.length} 筆` : '';

  if (filtered.length === 0) {
    container.className = 'cafe-grid';
    container.innerHTML = `<div class="empty-state"><div class="icon">📍</div><p>${
      cafes.length === 0 ? '這個分類還沒有地點<br>換個分類或到 Notion「地點」新增' : '沒有符合條件的地點'
    }</p></div>`;
    return;
  }

  if (activeView === 'list') {
    container.className = 'cafe-list';
    container.innerHTML = filtered.map(renderListRow).join('');
  } else {
    container.className = 'cafe-grid';
    container.innerHTML = filtered.map(renderCard).join('');
  }
  container.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', e => { if (e.target.closest('.card-links')) return; openEditModal(el.dataset.id); });
  });
  container.querySelectorAll('.fav-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleFavorite(btn.dataset.favId);
    });
  });
}

function renderListRow(cafe) {
  const visited   = (cafe.visits || []).length;
  const totalCost = (cafe.visits || []).reduce((s, v) => s + (v.cost || 0), 0);
  const tagsHtml  = (cafe.tags || []).length
    ? cafe.tags.map(t => `<span class="card-tag">${esc(t)}</span>`).join('') : '';
  const status    = getTodayStatus(cafe);
  const locParts  = locationLineParts(cafe);
  const locText   = locParts.length ? locParts.map(esc).join('・') : '';
  const stars     = renderStars(cafe.rating || 0);
  const gRating   = cafe.googleRating ? `${stars ? ' ・ ' : ''}★ ${esc(String(cafe.googleRating))}` : '';

  return `
    <div class="list-row" data-id="${esc(cafe.id)}">
      <div class="list-row-photo ${cafe.photoUrl ? '' : 'list-row-photo--empty'}"
           ${cafe.photoUrl ? `style="background-image:url(${cafe.photoUrl})"` : ''}></div>
      <div class="list-row-main">
        <div class="list-row-top">
          <span class="list-row-name">${esc(cafe.name)}</span>
          ${cafe.placeId ? `<a class="review-link" href="https://search.google.com/local/reviews?placeid=${esc(cafe.placeId)}" target="_blank" rel="noopener" title="查看 Google 評論" onclick="event.stopPropagation()">評論 ↗</a>` : ''}
          <span class="list-row-badges">${getStatusBadges(cafe)}</span>
        </div>
        <div class="list-row-sub">
          ${typeToArr(cafe.type).map(t => `<span class="type-badge">${esc(t)}</span>`).join('')}
          ${tagsHtml}
        </div>
        ${locText ? `<div class="list-row-address">${locText}</div>` : ''}
      </div>
      <div class="list-row-right">
        <div class="list-row-actions">
          <button class="copy-btn" onclick="copyForLine('${esc(cafe.id)}',event)" title="複製名稱/類型/標籤">📋</button>
          <button class="fav-btn ${cafe.favorite ? 'is-fav' : ''}" data-fav-id="${esc(cafe.id)}" title="${cafe.favorite ? '取消最愛' : '加入最愛'}">♥</button>
        </div>
        ${(stars || gRating) ? `<div class="list-row-stars">${stars}${gRating}</div>` : ''}
        ${status ? `<div class="list-row-status ${status.openNow ? 'is-open' : status.today === '公休' ? 'is-closed' : 'is-off'}">${status.label}</div>` : ''}
        ${visited ? `<div class="list-row-visits">${visited}次</div>` : ''}
        ${totalCost ? `<div class="list-row-cost">${formatCost(totalCost)}</div>` : ''}
      </div>
    </div>`;
}

function renderCard(cafe) {
  const types        = typeToArr(cafe.type);
  const typeOverlay   = types.length
    ? `<div class="type-badge-overlay">${types.map(t => esc(t)).join('・')}</div>` : '';
  const typeInline    = (!cafe.photoUrl && types.length)
    ? types.map(t => `<div class="type-badge">${esc(t)}</div>`).join('') : '';
  const photoHtml    = cafe.photoUrl
    ? `<div class="card-photo" style="background-image:url(${cafe.photoUrl})">${typeOverlay}</div>` : '';
  const locationHtml = renderLocationTags(cafe);
  const ratingHtml   = renderRatingRow(cafe);
  const tagsHtml     = (cafe.tags || []).length
    ? `<div class="card-tags">${cafe.tags.map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}</div>` : '';
  const notesHtml    = cafe.notes ? `<div class="card-notes">${esc(cafe.notes)}</div>` : '';
  const footerHtml   = (notesHtml || tagsHtml) ? `<div class="card-footer">${notesHtml}${tagsHtml}</div>` : '';
  const totalCost    = (cafe.visits || []).reduce((s, v) => s + (v.cost || 0), 0);
  const costHtml     = totalCost > 0 ? `<div class="card-total-cost">累計 ${formatCost(totalCost)}</div>` : '';
  const status       = getTodayStatus(cafe);
  const statusHtml   = status ? `<div class="card-hours-status ${status.openNow ? 'is-open' : status.today === '公休' ? 'is-closed' : 'is-off'}">
    <span class="hours-dot"></span>${esc(status.label)}
  </div>` : '';

  return `
    <div class="cafe-card" data-id="${esc(cafe.id)}">
      ${photoHtml}
      <div class="card-body">
        <div class="card-header">
          <div class="cafe-name">${esc(cafe.name)}</div>
          <div class="card-header-right">
            <button class="copy-btn" onclick="copyForLine('${esc(cafe.id)}',event)" title="複製名稱/類型/標籤">📋</button>
            <button class="fav-btn ${cafe.favorite ? 'is-fav' : ''}" data-fav-id="${esc(cafe.id)}" title="${cafe.favorite ? '取消最愛' : '加入最愛'}">♥</button>
            <div class="status-badges">${getStatusBadges(cafe)}</div>
          </div>
        </div>
        ${typeInline}
        ${locationHtml}
        ${ratingHtml}
        ${statusHtml}${costHtml}${footerHtml}
        ${linkButtonsHtml(cafe)}
      </div>
    </div>`;
}

// ── Timeline ───────────────────────────────────────────────────────────────────
function renderTimeline() {
  const content = document.getElementById('timeline-content');
  const filtered = getFiltered();
  const allVisits = [];
  for (const cafe of filtered) {
    for (const v of (cafe.visits || [])) allVisits.push({ ...v, cafe });
  }
  if (allVisits.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="icon">📅</div><p>${
      cafes.length === 0 ? '還沒有記錄' : '目前篩選條件下沒有造訪記錄'
    }</p></div>`;
    return;
  }
  allVisits.sort((a, b) => b.date.localeCompare(a.date));

  const groupKey = v => {
    if (timelinePeriod === 'month') return v.date.substring(0, 7);
    if (timelinePeriod === 'week')  return getWeekKey(v.date);
    return v.date; // day
  };

  const groups = {};
  for (const v of allVisits) {
    const key = groupKey(v);
    if (!groups[key]) groups[key] = [];
    groups[key].push(v);
  }

  let html = '';
  for (const [key, visits] of Object.entries(groups)) {
    const total     = visits.reduce((s, v) => s + (v.cost || 0), 0);
    const totalChip = total > 0 ? `<span class="month-total-chip">${formatCost(total)}</span>` : '';
    const label = timelinePeriod === 'month' ? formatMonthKey(key)
                : timelinePeriod === 'week'  ? formatWeekKey(key)
                : formatDayKey(key);
    html += `<div class="timeline-month-header">${label}${totalChip}</div>`;
    if (timelinePeriod === 'day') {
      // day view: compact list, not grid
      html += '<div class="timeline-day-list">';
      for (const v of visits) html += renderDayRow(v);
      html += '</div>';
    } else {
      html += '<div class="cafe-grid">';
      for (const v of visits) html += renderTimelineCard(v);
      html += '</div>';
    }
  }
  content.innerHTML = html;
  content.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', e => { if (e.target.closest('.card-links')) return; openEditModal(el.dataset.id); });
  });
}

function renderDayRow(v) {
  const { cafe, cost } = v;
  const typeHtml = typeToArr(cafe.type).map(t => `<span class="day-row-type">${esc(t)}</span>`).join('');
  const costHtml = cost != null ? `<span class="day-row-cost">${formatCost(cost)}</span>` : '';
  const stars    = cafe.rating ? renderStars(cafe.rating) : '';
  return `
    <div class="day-row" data-id="${esc(cafe.id)}">
      <div class="day-row-photo ${cafe.photoUrl ? '' : 'day-row-photo--empty'}"
           ${cafe.photoUrl ? `style="background-image:url(${cafe.photoUrl})"` : ''}></div>
      <div class="day-row-info">
        <div class="day-row-name">${esc(cafe.name)}</div>
        <div class="day-row-meta">
          ${typeHtml}
          ${cafe.district ? `<span class="day-row-city">${esc(cafe.district)}</span>` : ''}
          ${stars ? `<span class="day-row-stars">${stars}</span>` : ''}
        </div>
      </div>
      ${costHtml}
    </div>`;
}

function renderTimelineCard(v) {
  const { cafe, date, cost } = v;
  const [, month, day] = date.split('-');
  const types        = typeToArr(cafe.type);
  const typeOverlay   = types.length
    ? `<div class="type-badge-overlay">${types.map(t => esc(t)).join('・')}</div>` : '';
  const typeInline    = (!cafe.photoUrl && types.length)
    ? types.map(t => `<div class="type-badge">${esc(t)}</div>`).join('') : '';
  const photoHtml    = cafe.photoUrl
    ? `<div class="card-photo" style="background-image:url(${cafe.photoUrl})">${typeOverlay}</div>` : '';
  const locationHtml = renderLocationTags(cafe);
  const ratingHtml   = renderRatingRow(cafe);
  const tagsHtml     = (cafe.tags || []).length
    ? `<div class="card-tags">${cafe.tags.map(t => `<span class="card-tag">${esc(t)}</span>`).join('')}</div>` : '';
  const notesHtml    = cafe.notes ? `<div class="card-notes">${esc(cafe.notes)}</div>` : '';
  const footerHtml   = (notesHtml || tagsHtml) ? `<div class="card-footer">${notesHtml}${tagsHtml}</div>` : '';
  const costHtml     = cost != null ? `<div class="card-visit-cost">${formatCost(cost)}</div>` : '';

  return `
    <div class="cafe-card" data-id="${esc(cafe.id)}">
      <div class="timeline-date-banner">
        ${parseInt(month)}月${parseInt(day)}日
        ${cost != null ? `<span class="banner-cost">${formatCost(cost)}</span>` : ''}
      </div>
      ${photoHtml}
      <div class="card-body">
        <div class="card-header" style="margin-bottom:4px">
          <div class="cafe-name">${esc(cafe.name)}</div>
        </div>
        ${typeInline}
        ${locationHtml}
        ${ratingHtml}
        ${costHtml}${footerHtml}
        ${linkButtonsHtml(cafe)}
      </div>
    </div>`;
}

// ── Map ────────────────────────────────────────────────────────────────────────
function renderMap() {
  if (!window.google) {
    document.getElementById('map-container').innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6B6B6B;font-size:.9rem">請先設定 Google Maps API Key</div>';
    return;
  }

  if (!mapInitialized) {
    map = new google.maps.Map(document.getElementById('map-container'), {
      center: { lat: 25.0478, lng: 121.5318 },
      zoom: 12,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });
    infoWindow = new google.maps.InfoWindow();
    map.addListener('click', () => infoWindow.close());
    mapInitialized = true;
  }

  markers.forEach(m => m.setMap(null));
  markers = [];

  const filtered = getFiltered();
  let noCoords = 0;
  const bounds = new google.maps.LatLngBounds();
  let hasMarkers = false;

  for (const cafe of filtered) {
    if (!cafe.lat || !cafe.lng) { noCoords++; continue; }
    const isVisited = (cafe.visits || []).length > 0;
    const color = isVisited ? '#C0392B' : '#9e9e9e';
    const marker = new google.maps.Marker({
      position: { lat: cafe.lat, lng: cafe.lng },
      map,
      title: cafe.name,
      icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: color, fillOpacity: 1, strokeColor: 'white', strokeWeight: 2, scale: 10 },
    });
    marker.addListener('click', () => {
      infoWindow.setContent(buildInfoWindowContent(cafe));
      infoWindow.open(map, marker);
    });
    markers.push(marker);
    bounds.extend({ lat: cafe.lat, lng: cafe.lng });
    hasMarkers = true;
  }

  if (hasMarkers) {
    map.fitBounds(bounds);
    if (markers.length === 1) map.setZoom(16);
  }

  const notice = document.getElementById('map-no-coords');
  if (noCoords > 0) {
    notice.textContent = `${noCoords} 個地點缺少座標（透過搜尋加入才有座標）`;
    notice.classList.remove('hidden');
  } else {
    notice.classList.add('hidden');
  }
}

function buildInfoWindowContent(cafe) {
  const n = (cafe.visits || []).length;
  const status = n > 0 ? `去過${n > 1 ? ` ${n}次` : ''}` : '';
  const typeHtml = typeToArr(cafe.type).map(t =>
    `<div style="font-size:.75rem;background:#FAF0EE;color:#C0392B;border-radius:3px;padding:1px 7px;display:inline-block;font-weight:600;margin:3px 0">${esc(t)}</div>`
  ).join('');
  const ratingHtml = cafe.rating
    ? `<div style="color:#C0392B;font-size:.82rem;margin:3px 0">${'★'.repeat(cafe.rating)}${'★'.repeat(5-cafe.rating).replace(/★/g,'<span style="color:#ddd">★</span>')}</div>` : '';
  const notesHtml = cafe.notes
    ? `<div style="font-size:.75rem;color:#888;margin-top:4px;font-style:italic;max-width:220px">${esc(cafe.notes)}</div>` : '';

  return `
    <div style="font-family:'Noto Sans TC',-apple-system,sans-serif;min-width:180px;max-width:240px;padding:2px">
      <strong style="font-size:.92rem;color:#1A1A1A">${esc(cafe.name)}</strong>
      ${typeHtml}
      <div style="font-size:.75rem;color:#6B6B6B;margin:3px 0;line-height:1.4">${esc(cafe.address)}</div>
      ${ratingHtml}
      ${status ? `<div style="font-size:.78rem;color:#C0392B;font-weight:600;margin:2px 0">${status}</div>` : ''}
      ${notesHtml}
      <button onclick="openEditModal('${esc(cafe.id)}')"
        style="margin-top:10px;padding:5px 14px;background:#C0392B;color:white;border:none;border-radius:6px;cursor:pointer;font-size:.78rem;font-weight:700">
        開啟地圖
      </button>
    </div>`;
}

// ── Filter Updates ─────────────────────────────────────────────────────────────
function updateAllFilters() {
  renderSidebar();
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
function renderSidebar() {
  renderSidebarTypes();
  renderSidebarCities();
  renderSidebarDistricts();
}

function renderSidebarTypes() {
  const types = [...new Set(cafes.flatMap(c => typeToArr(c.type)))].sort();
  const section = document.getElementById('sidebar-type-section');
  const container = document.getElementById('sidebar-types');
  section.style.display = types.length ? '' : 'none';

  container.innerHTML = types.map(t => `
    <button class="sidebar-filter-btn ${activeTypes.has(t) ? 'active' : ''}" data-val="${esc(t)}">
      <span>${esc(t)}</span>
      <span class="sidebar-filter-count">${cafes.filter(c => typesIncludes(c.type, t)).length}</span>
    </button>
  `).join('');

  container.querySelectorAll('.sidebar-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (activeTypes.has(btn.dataset.val)) activeTypes.delete(btn.dataset.val);
      else activeTypes.add(btn.dataset.val);
      renderSidebarTypes();
      rerender();
    });
  });
}

function renderSidebarCities() {
  const cities = [...new Set(cafes.map(c => c.city).filter(Boolean))].sort();
  const section = document.getElementById('sidebar-city-section');
  const container = document.getElementById('sidebar-cities');
  section.style.display = cities.length ? '' : 'none';

  container.innerHTML = cities.map(c => `
    <button class="sidebar-filter-btn ${activeCities.has(c) ? 'active' : ''}" data-val="${esc(c)}">
      <span>${esc(c)}</span>
      <span class="sidebar-filter-count">${cafes.filter(x => x.city === c).length}</span>
    </button>
  `).join('');

  container.querySelectorAll('.sidebar-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (activeCities.has(btn.dataset.val)) activeCities.delete(btn.dataset.val);
      else activeCities.add(btn.dataset.val);
      // 清掉不在選取城市裡的區篩選
      if (activeCities.size) {
        const pool = cafes.filter(c => activeCities.has(c.city));
        const validDistricts = new Set(pool.map(c => c.district).filter(Boolean));
        for (const d of activeDistricts) { if (!validDistricts.has(d)) activeDistricts.delete(d); }
      } else {
        activeDistricts.clear();
      }
      renderSidebarCities();
      renderSidebarDistricts();
      rerender();
    });
  });
}

function renderSidebarDistricts() {
  const pool = activeCities.size ? cafes.filter(c => activeCities.has(c.city)) : cafes;
  const districts = [...new Set(pool.map(c => c.district).filter(Boolean))].sort();
  const section = document.getElementById('sidebar-district-section');
  const container = document.getElementById('sidebar-districts');
  section.style.display = districts.length ? '' : 'none';

  container.innerHTML = districts.map(d => `
    <button class="sidebar-filter-btn ${activeDistricts.has(d) ? 'active' : ''}" data-val="${esc(d)}">
      <span>${esc(d)}</span>
      <span class="sidebar-filter-count">${pool.filter(c => c.district === d).length}</span>
    </button>
  `).join('');

  container.querySelectorAll('.sidebar-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (activeDistricts.has(btn.dataset.val)) activeDistricts.delete(btn.dataset.val);
      else activeDistricts.add(btn.dataset.val);
      renderSidebarDistricts();
      rerender();
    });
  });
}

// ── Render Helpers ─────────────────────────────────────────────────────────────
function getStatusBadges(cafe) {
  const n = (cafe.visits || []).length;
  let html = '';
  if (n > 0) html += `<span class="status-badge visited">去過${n > 1 ? ` ${n}次` : ''}</span>`;
  return html;
}

// Strip postal code / "台灣" / city / district from a full address, leaving just the street name.
function simplifyStreet(cafe) {
  let addr = cafe.address || '';
  if (!addr) return '';
  addr = addr.replace(/^\d{3,6}/, '');
  addr = addr.replace(/^(台灣|臺灣)/, '');
  if (cafe.city && addr.startsWith(cafe.city)) addr = addr.slice(cafe.city.length);
  if (cafe.district && addr.startsWith(cafe.district)) addr = addr.slice(cafe.district.length);
  const idx = addr.search(/[0-9]/);
  const street = idx === -1 ? addr : addr.slice(0, idx);
  return street.trim();
}

// Merged "城市・區・路名" line — replaces the old city-tag/district-tag badges + full address.
function locationLineParts(cafe) {
  const parts = [];
  if (cafe.city) parts.push(cafe.city.replace(/(市|縣)$/, ''));
  if (cafe.district) parts.push(cafe.district);
  const street = simplifyStreet(cafe);
  if (street) parts.push(street);
  return parts;
}

function renderLocationTags(cafe) {
  const parts = locationLineParts(cafe);
  return parts.length ? `<div class="cafe-address">${parts.map(esc).join('・')}</div>` : '';
}

function renderAttr(label, val) {
  val = val || 'unknown';
  if (val === 'unknown') return '';
  return `<span class="attr ${val}">${label} ${val === 'yes' ? '✓' : '✗'}</span>`;
}

function renderStars(rating) {
  return rating > 0 ? '★'.repeat(rating) : '';
}

// Merged personal rating + Google rating into one amber row (empty stars removed entirely).
function renderRatingRow(cafe) {
  const parts = [];
  if (cafe.rating) parts.push(`<span class="rating-badge">${renderStars(cafe.rating)}</span>`);
  if (cafe.googleRating) {
    const isLink = !!cafe.placeId;
    const tag = isLink ? 'a' : 'span';
    const attrs = isLink
      ? `href="https://search.google.com/local/reviews?placeid=${esc(cafe.placeId)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"`
      : '';
    parts.push(`<${tag} class="rating-badge google" ${attrs} title="查看 Google 評論">★ ${esc(String(cafe.googleRating))}</${tag}>`);
  }
  return parts.length ? `<div class="rating-row">${parts.join('')}</div>` : '';
}

// ── Photo Management ───────────────────────────────────────────────────────────
function setModalPhoto(url, canFetchGoogle) {
  const previewEl = document.getElementById('modal-photo-preview');
  const emptyEl   = document.getElementById('modal-photo-empty');
  const fetchBtn  = document.getElementById('btn-fetch-photo');
  if (url) {
    previewEl.style.backgroundImage = `url(${url})`;
    previewEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
  } else {
    previewEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    fetchBtn.classList.toggle('hidden', !canFetchGoogle);
  }
}

function handlePhotoUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    pendingPhotoUrl = e.target.result; // base64
    setModalPhoto(pendingPhotoUrl, false);
  };
  reader.readAsDataURL(file);
}

function fetchPhotoForEditing() {
  const placeId = editingId
    ? cafes.find(c => c.id === editingId)?.placeId
    : currentPlace?.place_id;
  if (!placeId || !placesService) return;

  const btn = document.getElementById('btn-fetch-photo');
  btn.textContent = '抓取中…'; btn.disabled = true;

  placesService.getDetails({ placeId, fields: ['photos', 'opening_hours'] }, async (details) => {
    btn.textContent = '從 Google 抓取'; btn.disabled = false;
    const rawUrl = details?.photos?.[0]?.getUrl({ maxWidth: 800 }) || null;
    if (!rawUrl) { btn.textContent = '找不到照片'; return; }
    const url = await cachePhoto(rawUrl);
    pendingPhotoUrl = url;
    // also refresh periods if editing
    if (editingId && details?.opening_hours?.periods) {
      const cafe = cafes.find(c => c.id === editingId);
      if (cafe) {
        cafe.periods = JSON.parse(JSON.stringify(details.opening_hours.periods));
        API.put(`/api/cafes/${editingId}`, { periods: cafe.periods });
      }
    }
    setModalPhoto(url, false);
  });
}

function removePhoto() {
  pendingPhotoUrl = null;
  const canFetch = !!(editingId
    ? cafes.find(c => c.id === editingId)?.placeId
    : currentPlace?.place_id);
  setModalPhoto(null, canFetch);
}

// ── View Toggle ────────────────────────────────────────────────────────────────
function setView(v) {
  activeView = v;
  document.getElementById('btn-view-grid').classList.toggle('active', v === 'grid');
  document.getElementById('btn-view-list').classList.toggle('active', v === 'list');
  renderCafes();
}

// ── Opening Hours ──────────────────────────────────────────────────────────────
function getTodayStatus(cafe) {
  if (!cafe.periods || !cafe.periods.length) return null;

  const now     = new Date();
  const today   = now.getDay(); // 0=Sun
  const nowMins = now.getHours() * 60 + now.getMinutes();

  // 24h: single period open.day=0 time="0000" no close
  if (cafe.periods.length === 1 && cafe.periods[0].open?.time === '0000' && !cafe.periods[0].close) {
    return { openNow: true, label: '24小時營業', today: '24小時' };
  }

  const todayPeriods = cafe.periods.filter(p => p.open?.day === today);

  if (!todayPeriods.length) {
    return { openNow: false, label: '今日公休', today: '公休' };
  }

  const fmt = s => `${s.slice(0,2)}:${s.slice(2)}`;
  let openNow = false;
  let closeAt = null;     // this period's close time, if currently open
  let nextOpenAt = null;  // earliest still-upcoming open time today, if currently closed

  for (const p of todayPeriods) {
    const ot = p.open.time;   // "HHMM"
    const ct = p.close?.time;
    const oMins = parseInt(ot.slice(0,2)) * 60 + parseInt(ot.slice(2));
    const cMins = ct ? parseInt(ct.slice(0,2)) * 60 + parseInt(ct.slice(2)) : null;

    let isOpenInThis = false;
    if (cMins === null) {
      if (nowMins >= oMins) isOpenInThis = true;
    } else if (cMins <= oMins) { // crosses midnight
      if (nowMins >= oMins || nowMins < cMins) isOpenInThis = true;
    } else {
      if (nowMins >= oMins && nowMins < cMins) isOpenInThis = true;
    }

    if (isOpenInThis) {
      openNow = true;
      closeAt = ct;
    } else if (nowMins < oMins) {
      const nextMins = nextOpenAt ? parseInt(nextOpenAt.slice(0,2)) * 60 + parseInt(nextOpenAt.slice(2)) : null;
      if (nextMins === null || oMins < nextMins) nextOpenAt = ot;
    }
  }

  if (openNow) {
    return {
      openNow: true,
      label: closeAt ? `營業中・${fmt(closeAt)} 打烊` : '營業中',
      today: '營業中',
    };
  }
  return {
    openNow: false,
    label: nextOpenAt ? `已打烊・${fmt(nextOpenAt)} 開始營業` : '已打烊',
    today: '已打烊',
  };
}

// ── Cost Format ────────────────────────────────────────────────────────────────
function formatCost(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '';
}

// ── Date Utils ─────────────────────────────────────────────────────────────────
function todayStr()  { return new Date().toLocaleDateString('sv-SE'); }

function formatDate(s) {
  const [y, m, d] = s.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function formatMonthKey(key) {
  const [y, m] = key.split('-');
  return `${y}年${parseInt(m)}月`;
}

function getWeekKey(dateStr) {
  const d = new Date(dateStr);
  // Monday of that week
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d.toLocaleDateString('sv-SE'); // YYYY-MM-DD of Monday
}

function formatWeekKey(mondayStr) {
  const mon = new Date(mondayStr);
  const sun = new Date(mondayStr);
  sun.setDate(sun.getDate() + 6);
  const fmt = d => `${d.getMonth()+1}/${d.getDate()}`;
  return `${mon.getFullYear()}年　${fmt(mon)} — ${fmt(sun)}`
}

function formatDayKey(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const weekdays = ['日','一','二','三','四','五','六'];
  const dow = weekdays[new Date(dateStr).getDay()];
  return `${y}年${parseInt(m)}月${parseInt(d)}日　週${dow}`;
}

// ── Address Parsing ────────────────────────────────────────────────────────────
function normalizeTw(str) { return String(str || '').replace(/臺/g, '台'); }

function extractCity(address) {
  const clean = normalizeTw(address).replace(/^\d+/, '').replace(/^台灣/, '');
  const m = clean.match(/^(.+?(?:縣|市))/);
  return m ? m[1] : '';
}

function extractDistrict(address) {
  const m = normalizeTw(address).match(/(?:縣|市)(.+?(?:區|鎮|鄉))/);
  return m ? m[1] : '';
}

// ── One-time migration from localStorage → DB ──────────────────────────────────
async function migrateFromLocalStorage() {
  if (READONLY) return;
  if (localStorage.getItem('db_migrated')) return;
  const oldCollections = JSON.parse(localStorage.getItem('collections') || 'null');
  if (!oldCollections) return;

  const dbColIds = new Set(collections.map(c => c.id));
  for (const col of oldCollections) {
    if (!dbColIds.has(col.id)) {
      await API.post('/api/collections', { id: col.id, name: col.name });
      collections.push(col);
    }
    const oldCafes = JSON.parse(localStorage.getItem('cafes_' + col.id) || '[]');
    for (const cafe of oldCafes) {
      // normalise legacy fields before inserting
      if (cafe.area !== undefined && cafe.city === undefined) {
        cafe.district = cafe.area || ''; cafe.city = ''; delete cafe.area;
      }
      if (!cafe.visits)    cafe.visits   = [];
      if (!cafe.tags)      cafe.tags     = [];
      if (!cafe.type)      cafe.type     = '';
      if (cafe.wishlist === undefined) cafe.wishlist = false;
      if (cafe.favorite === undefined) cafe.favorite = false;
      cafe.collectionId = col.id;
      await API.post('/api/cafes', cafe);
    }
  }

  localStorage.setItem('db_migrated', '1');
  collections = await API.get('/api/collections');
}

// ── Favorites ──────────────────────────────────────────────────────────────────
async function toggleFavorite(id) {
  const cafe = cafes.find(c => c.id === id) || allCafes.find(c => c.id === id);
  if (!cafe) return;
  cafe.favorite = !cafe.favorite;
  if (!READONLY) {
    try { await API.put(`/api/cafes/${id}`, { favorite: cafe.favorite }); } catch {}
  }
  document.querySelectorAll(`.fav-btn[data-fav-id="${id}"]`).forEach(btn => {
    btn.classList.toggle('is-fav', cafe.favorite);
    btn.title = cafe.favorite ? '取消最愛' : '加入最愛';
  });
  if (activeStatuses.has('fav')) rerender();
}

// ── Copy for LINE ──────────────────────────────────────────────────────────────
function cafeCopyText(cafe) {
  const lines = [cafe.name];
  if (cafe.city) lines.push(`城市：${cafe.city}`);
  if (cafe.district) lines.push(`地區：${cafe.district}`);
  const types = typeToArr(cafe.type);
  if (types.length) lines.push(`類型：${types.join('、')}`);
  if ((cafe.tags || []).length) lines.push(`標籤：${cafe.tags.join('、')}`);
  const maps = cafe.mapsUrl || (cafe.placeId ? `https://maps.google.com/maps?q=place_id:${cafe.placeId}` : '');
  if (maps) lines.push(`Google 地圖：${maps}`);
  if (cafe.sourceUrl) lines.push(`推薦：${cafe.sourceUrl}`);
  return lines.join('\n');
}

async function copyForLine(id, e) {
  e.stopPropagation();
  const cafe = cafes.find(c => c.id === id);
  if (!cafe) return;

  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(cafeCopyText(cafe));
    const original = btn.textContent;
    btn.textContent = '✅';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1200);
  } catch {
    alert('複製失敗，請手動選取文字複製');
  }
}

async function copyAllUnvisited(e) {
  const btn = document.getElementById('copy-unvisited-btn');
  btn.disabled = true;
  try {
    const blocks = cafes
      .filter(cafe => (cafe.visits || []).length === 0)
      .map(cafeCopyText);
    if (!blocks.length) {
      alert('這個分類裡目前沒有還沒去過的地點');
      return;
    }
    await navigator.clipboard.writeText(blocks.join('\n\n------\n\n'));
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch {
    alert('複製失敗，請手動選取文字複製');
  } finally {
    btn.disabled = false;
  }
}

// ── Refresh All Places ─────────────────────────────────────────────────────────
async function refreshAllPlaces() {
  if (READONLY) { alert('唯讀模式：請重新匯出 places.json'); return; }
  if (!placesService) {
    alert('請先設定 Google Maps API Key'); return;
  }

  // collect all cafes with placeId across ALL collections
  const targets = [];
  for (const col of collections) {
    const colCafes = col.id === activeCollectionId
      ? cafes
      : await API.get(`/api/collections/${col.id}/cafes`);
    for (const c of colCafes) {
      if (c.placeId) targets.push({ cafe: c, colId: col.id });
    }
  }

  if (!targets.length) {
    alert('沒有可更新的地點（需透過 Google Maps 搜尋加入才有 placeId）'); return;
  }

  const btn      = document.getElementById('refresh-btn');
  const toast    = document.getElementById('refresh-toast');
  const toastTxt = document.getElementById('refresh-toast-text');
  const fill     = document.getElementById('refresh-progress-fill');

  btn.disabled = true;
  toast.classList.remove('hidden');
  let done = 0;

  const setProgress = () => {
    const pct = Math.round((done / targets.length) * 100);
    fill.style.width = pct + '%';
    toastTxt.textContent = `更新中… ${done} / ${targets.length}`;
  };
  setProgress();

  // helper: wrap getDetails in a Promise
  const fetchDetails = placeId => new Promise(resolve => {
    placesService.getDetails(
      { placeId, fields: ['opening_hours', 'photos'] },
      (details, status) => resolve(status === 'OK' ? details : null)
    );
  });

  // process with small delay to avoid hitting rate limits
  for (const { cafe, colId } of targets) {
    const details = await fetchDetails(cafe.placeId);
    if (details) {
      if (details.opening_hours?.periods) {
        cafe.periods = JSON.parse(JSON.stringify(details.opening_hours.periods));
        cafe.hours   = details.opening_hours.weekday_text?.map(normalizeTw).join('\n') || cafe.hours;
      }
      if (details.photos?.[0] && !cafe.photoUrl?.startsWith('data:') && !cafe.photoUrl?.startsWith('/photos/')) {
        // only update if not a user-uploaded or already-cached photo
        cafe.photoUrl = await cachePhoto(details.photos[0].getUrl({ maxWidth: 800 }));
      }
    }
    // save updated cafe to DB
    await API.put(`/api/cafes/${cafe.id}`, {
      periods:  cafe.periods,
      hours:    cafe.hours,
      photoUrl: cafe.photoUrl,
    });

    done++;
    setProgress();

    // small throttle: 120ms between requests
    await new Promise(r => setTimeout(r, 120));
  }

  btn.disabled = false;
  toastTxt.textContent = `已更新 ${done} 個地點`;
  fill.style.width = '100%';
  setTimeout(() => toast.classList.add('hidden'), 2500);

  rerender();
}

// ── Export / Import ────────────────────────────────────────────────────────────
async function exportJSON() {
  if (READONLY) {
    downloadFile(
      JSON.stringify({ exportedAt: new Date().toISOString(), collections, cafes: allCafes }, null, 2),
      `踩點_places_${todayStr()}.json`,
      'application/json'
    );
    return;
  }
  const data = {};
  for (const col of collections) {
    data[col.id] = await API.get(`/api/collections/${col.id}/cafes`);
  }
  const bundle = {
    exportedAt: new Date().toISOString(),
    version: 1,
    collections,
    data: Object.fromEntries(
      collections.map(col => [col.id, data[col.id]])
    ),
  };
  downloadFile(
    JSON.stringify(bundle, null, 2),
    `踩點備份_${todayStr()}.json`,
    'application/json'
  );
}

async function exportCSV() {
  const rows = [['分類', '名稱', '地址', '類型', '縣市', '地區', '評分', 'Google評分',
    '造訪次數', '總消費', '標籤', 'IG內容', '建立時間']];

  for (const col of collections) {
    const colCafes = READONLY
      ? allCafes.filter(c => c.collectionId === col.id)
      : await API.get(`/api/collections/${col.id}/cafes`);
    for (const c of colCafes) {
      const totalCost = (c.visits || []).reduce((s, v) => s + (v.cost || 0), 0);
      rows.push([
        col.name, c.name, c.address, c.type, c.city, c.district,
        c.rating || '', c.googleRating || '',
        (c.visits || []).length,
        totalCost || '',
        (c.tags || []).join('、'),
        c.notes || '',
        c.createdAt ? c.createdAt.split('T')[0] : '',
      ]);
    }
  }

  const csv = rows.map(r =>
    r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');

  // BOM for Excel UTF-8
  downloadFile('\uFEFF' + csv, `踩點_${todayStr()}.csv`, 'text/csv');
}

function importJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('import-status');

  const reader = new FileReader();
  reader.onload = async evt => {
    try {
      const bundle = JSON.parse(evt.target.result);
      if (!bundle.collections || !bundle.data) throw new Error('格式不正確');

      let importedCols = 0, importedItems = 0;

      for (const col of bundle.collections) {
        const incoming = bundle.data[col.id] || [];
        if (!incoming.length) continue;

        // create collection in DB if not exists
        if (!collections.find(c => c.id === col.id)) {
          await API.post('/api/collections', { id: col.id, name: col.name });
          collections.push(col);
          importedCols++;
        }

        // merge records: fetch existing, upsert each item
        const existing = await API.get(`/api/collections/${col.id}/cafes`);
        const existingIds = new Set(existing.map(c => c.id));
        for (const item of incoming) {
          const itemWithCol = { ...item, collectionId: col.id };
          if (!existingIds.has(item.id)) {
            await API.post('/api/cafes', itemWithCol);
            importedItems++;
          } else {
            await API.put(`/api/cafes/${item.id}`, itemWithCol);
          }
        }
      }

      cafes = await API.get(`/api/collections/${activeCollectionId}/cafes`);
      renderCollectionPills();
      updateAllFilters();
      rerender();

      statusEl.textContent = `匯入完成：${importedItems} 筆記錄、${importedCols} 個新分類`;
      statusEl.className = 'import-status import-status--ok';
      statusEl.classList.remove('hidden');
    } catch (err) {
      statusEl.textContent = '匯入失敗：' + err.message;
      statusEl.className = 'import-status import-status--err';
      statusEl.classList.remove('hidden');
    }
    e.target.value = ''; // reset input
  };
  reader.readAsText(file);
}

function downloadFile(content, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── XSS Escape ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
