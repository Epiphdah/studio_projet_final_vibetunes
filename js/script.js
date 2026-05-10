/* =============================================================================
   VibeTunes — Deezer API (JSONP), audio, queue, UI (vanilla, single file)
   ============================================================================= */

'use strict';

// -----------------------------------------------------------------------------
// CONFIG / API
// -----------------------------------------------------------------------------
const CONFIG = Object.freeze({
  API_BASE: 'https://api.deezer.com',
  SEARCH_DEBOUNCE_MS: 320,
  SEARCH_LIMIT: 18,
  CHART_TRACKS_LIMIT: 15,
  CHART_PLAYLISTS_LIMIT: 8,
  PLAYLIST_PREVIEW_LIMIT: 40,
  RECENT_MAX: 14,
  STORAGE: Object.freeze({
    THEME: 'vibetunes-theme',
    QUEUE: 'vibetunes-queue',
    QUEUE_INDEX: 'vibetunes-queue-index',
    FAVORITES: 'vibetunes-favorites',
    VOLUME: 'vibetunes-volume',
    SHUFFLE: 'vibetunes-shuffle',
    REPEAT: 'vibetunes-repeat'
  }),
  PLACEHOLDER_COVER:
    'https://e-cdns-images.dzcdn.net/images/cover/250x250-000000-80-0-0.jpg'
});

// -----------------------------------------------------------------------------
// STATE
// -----------------------------------------------------------------------------
const state = {
  chartTracks: [],
  chartPlaylists: [],
  searchResults: [],
  searchAbortId: 0,
  favorites: new Set(),
  recent: [],

  queue: [],
  currentIndex: -1,
  shuffle: false,
  repeatMode: 'none',

  playing: false,
  volume: 0.85,
  isScrubbing: false,

  heroTrack: null,
  previewRecoverTried: false,

  /** Pile pour Précédent après Suivant aléatoire / navigation */
  backStack: []
};

// -----------------------------------------------------------------------------
// DOM ELEMENTS
// -----------------------------------------------------------------------------
/** @type {Record<string, HTMLElement | null>} */
const dom = {};

function cacheDom() {
  dom.audio = document.getElementById('audio-el');
  dom.searchInput = document.getElementById('search-input');
  dom.searchDropdown = document.getElementById('search-dropdown');
  dom.searchWrap = document.querySelector('.search-wrap');

  dom.heroSection = document.getElementById('hero-section');
  dom.heroTitle = document.querySelector('.hero-title');
  dom.heroArtist = document.querySelector('.hero-artist');
  dom.heroVisualImg = dom.heroSection.querySelector('.hero-visual img');

  dom.playlistsGrid = document.getElementById('playlists-grid');
  dom.topTracksList = document.getElementById('top-tracks-list');
  dom.recentGrid = document.getElementById('recent-grid');

  dom.queuePanel = document.getElementById('queue-panel');
  dom.queueList = document.getElementById('queue-list');
  dom.queueToggle = document.getElementById('queue-toggle');
  dom.queueClose = document.getElementById('queue-close');

  dom.currentTitle = document.getElementById('current-title');
  dom.currentArtist = document.getElementById('current-artist');
  dom.currentImg = document.querySelector('.current-track-img');
  dom.playPauseBtn = document.getElementById('play-pause');
  dom.playPauseIcon = dom.playPauseBtn.querySelector('i');
  dom.prevBtn = document.getElementById('prev');
  dom.nextBtn = document.getElementById('next');
  dom.shuffleBtn = document.getElementById('shuffle');
  dom.repeatBtn = document.getElementById('repeat');
  dom.likeBtn = document.querySelector('.like-btn');
  dom.likeIcon = dom.likeBtn.querySelector('i');

  dom.progressBar = document.getElementById('progress-bar');
  dom.progressFill = dom.progressBar.querySelector('.progress-fill');
  dom.progressKnob = dom.progressBar.querySelector('.progress-knob');
  dom.currentTimeEl = document.querySelector('.current-time');
  dom.totalTimeEl = document.querySelector('.total-time');

  dom.volumeBar = document.getElementById('volume-bar');
  dom.volumeFill = dom.volumeBar.querySelector('.volume-fill');
  dom.volumeIcon = document.getElementById('volume-icon');

  dom.themeToggle = document.getElementById('theme-toggle');
  dom.mobileMenuBtn = document.getElementById('mobile-menu-btn');
  dom.sidebar = document.getElementById('sidebar');

  dom.heroPlayBtn = dom.heroSection.querySelector('.btn-primary');
  dom.heroQueueBtn = dom.heroSection.querySelector('.btn-outline');

  dom.body = document.body;
}

// -----------------------------------------------------------------------------
// API REQUESTS (JSONP — navigateur sans proxy CORS)
// -----------------------------------------------------------------------------
/** @returns {Promise<any>} */
function deezerJSONP(relPathAndQuery) {
  const sep = relPathAndQuery.includes('?') ? '&' : '?';
  const urlBase = `${CONFIG.API_BASE}${relPathAndQuery}${sep}output=jsonp&callback=`;

  return new Promise((resolve, reject) => {
    const cbName = `__dz_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    let scriptEl = document.createElement('script');
    /** @type {typeof window & Record<string, unknown>} */
    const w = window;

    let settled = false;
    const tId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        delete w[cbName];
      } catch (_) {
        /* ignore */
      }
      if (scriptEl?.parentNode) scriptEl.parentNode.removeChild(scriptEl);
      scriptEl = null;
      reject(new Error('Délai dépassé (API Deezer)'));
    }, 15000);

    const finish = (ok, val) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(tId);
      try {
        delete w[cbName];
      } catch (_) {
        /* ignore */
      }
      if (scriptEl?.parentNode) scriptEl.parentNode.removeChild(scriptEl);
      scriptEl = null;
      if (ok) resolve(val);
      else reject(val instanceof Error ? val : new Error(String(val)));
    };

    w[cbName] = payload => {
      try {
        if (payload && payload.error) {
          const msg = payload.error.message || payload.error.type || 'Erreur API Deezer';
          finish(false, new Error(msg));
          return;
        }
        finish(true, payload);
      } catch (err) {
        finish(false, err instanceof Error ? err : new Error('Réponse Deezer invalide'));
      }
    };

    scriptEl.onerror = () => {
      finish(false, new Error('Réseau indisponible ou script bloqué'));
    };

    scriptEl.async = true;
    scriptEl.src = urlBase + encodeURIComponent(cbName);
    document.body.appendChild(scriptEl);
  });
}

/** @param {any} t */
function normalizeTrack(t) {
  return {
    id: t?.id ?? 0,
    title: String(t?.title_short || t?.title || '—').trim(),
    artistName: String(t?.artist?.name ?? '—'),
    albumTitle: String(t?.album?.title ?? ''),
    cover:
      t?.album?.cover_medium ||
      t?.album?.cover ||
      t?.album?.cover_small ||
      CONFIG.PLACEHOLDER_COVER,
    preview: typeof t?.preview === 'string' ? t.preview : '',
    duration: typeof t?.duration === 'number' ? t.duration : 0,
    deezerLink: typeof t?.link === 'string' ? t.link : ''
  };
}

/** @returns {Promise<any[]>} */
async function fetchSearchTracks(query) {
  const q = query.trim();
  if (!q) return [];
  const data = await deezerJSONP(
    `/search/track?q=${encodeURIComponent(q)}&limit=${CONFIG.SEARCH_LIMIT}`
  );
  return Array.isArray(data?.data) ? data.data.map(normalizeTrack) : [];
}

/** @returns {Promise<any[]>} */
async function fetchChartTracks() {
  const data = await deezerJSONP(`/chart/0/tracks?limit=${CONFIG.CHART_TRACKS_LIMIT}`);
  return Array.isArray(data?.data) ? data.data.map(normalizeTrack) : [];
}

/** @returns {Promise<any[]>} */
async function fetchChartPlaylists() {
  const data = await deezerJSONP(
    `/chart/0/playlists?limit=${CONFIG.CHART_PLAYLISTS_LIMIT}`
  );
  return Array.isArray(data?.data) ? data.data : [];
}

/** @returns {Promise<any[]>} */
async function fetchPlaylistTracks(playlistId) {
  const data = await deezerJSONP(
    `/playlist/${playlistId}/tracks?limit=${CONFIG.PLAYLIST_PREVIEW_LIMIT}`
  );
  return Array.isArray(data?.data) ? data.data.map(normalizeTrack) : [];
}

/** @returns {Promise<ReturnType<typeof normalizeTrack>>} */
async function fetchTrackById(trackId) {
  const data = await deezerJSONP(`/track/${encodeURIComponent(trackId)}`);
  return normalizeTrack(data);
}

// -----------------------------------------------------------------------------
// AUDIO PLAYER
// -----------------------------------------------------------------------------
/** réassigné dans bindAudioHandlers — utilisé après scrub de la barre */
let startProgressAnimation = () => {};

function togglePlayChrome(isPlaying) {
  state.playing = isPlaying;
  const btn = dom.playPauseBtn;
  const icon = dom.playPauseIcon;
  if (!btn || !icon) return;

  icon.classList.remove('fa-play', 'fa-pause');
  icon.classList.add(isPlaying ? 'fa-pause' : 'fa-play');

  if (isPlaying) {
    btn.style.backgroundColor = 'var(--primary-color)';
    btn.style.color = 'white';
  } else {
    btn.style.backgroundColor = '';
    btn.style.color = '';
  }
}

function setProgressUI(percent01, curSec, durSec) {
  const p = Math.max(0, Math.min(100, Math.round((percent01 || 0) * 1000) / 10));
  if (dom.progressFill) dom.progressFill.style.width = `${p}%`;
  if (dom.progressKnob) dom.progressKnob.style.left = `${p}%`;

  dom.progressBar?.setAttribute('aria-valuenow', String(Math.round(p)));

  if (dom.currentTimeEl && !Number.isNaN(curSec))
    dom.currentTimeEl.textContent = formatDuration(curSec);
  if (dom.totalTimeEl && !Number.isNaN(durSec))
    dom.totalTimeEl.textContent = formatDuration(durSec);
}

function bindAudioHandlers() {
  const a = dom.audio;

  const onTime = () => {
    if (state.isScrubbing || !Number.isFinite(a.duration) || a.duration <= 0) return;
    setProgressUI(a.currentTime / a.duration, a.currentTime, a.duration);
  };

  a.addEventListener('timeupdate', onTime);

  let rafId = 0;
  const stopRaf = () => {
    window.cancelAnimationFrame(rafId);
    rafId = 0;
  };

  const tickProgress = () => {
    stopRaf();
    const loop = () => {
      if (a.paused || a.ended || state.isScrubbing) return;
      if (Number.isFinite(a.duration) && a.duration > 0) {
        try {
          setProgressUI(a.currentTime / a.duration, a.currentTime, a.duration);
        } catch (_) {
          /* ignore */
        }
      }
      rafId = window.requestAnimationFrame(loop);
    };
    rafId = window.requestAnimationFrame(loop);
  };

  startProgressAnimation = tickProgress;

  a.addEventListener('play', () => {
    togglePlayChrome(true);
    tickProgress();
  });

  a.addEventListener('pause', () => {
    stopRaf();
    togglePlayChrome(false);
  });

  a.addEventListener('loadedmetadata', () => {
    onTime();
    if (dom.totalTimeEl && Number.isFinite(a.duration))
      dom.totalTimeEl.textContent = formatDuration(a.duration);
  });

  a.addEventListener('ended', () => {
    stopRaf();
    togglePlayChrome(false);
    setProgressUI(0, 0, a.duration || 0);

    if (state.repeatMode === 'one') {
      a.currentTime = 0;
      void a.play().catch(() => {});
      return;
    }
    playNextAutomatic();
  });

  a.addEventListener('error', () => {
    void recoverPreviewThenRetry();
  });

  a.volume = state.volume;
}

/**
 * Tentative unique de rafraîchissement preview après erreur média / URL expirée
 */
async function recoverPreviewThenRetry() {
  if (state.previewRecoverTried) {
    toastPlayerError('Échec de lecture pour ce titre');
    skipAfterBadPreview();
    return;
  }
  state.previewRecoverTried = true;
  const track = currentTrack();
  if (!track || !track.id) {
    toastPlayerError('Lecture impossible');
    skipAfterBadPreview();
    return;
  }
  try {
    const fresh = await fetchTrackById(track.id);
    if (!fresh.preview) {
      toastPlayerError('Pré‑écoute indisponible pour ce titre');
      skipAfterBadPreview();
      return;
    }
    queueReplaceAt(state.currentIndex, fresh);
    await loadIntoAudio(true);
    state.previewRecoverTried = false;
  } catch (e) {
    toastPlayerError((e instanceof Error ? e.message : String(e)) || 'Erreur Deezer');
    skipAfterBadPreview();
  }
}

function skipAfterBadPreview() {
  state.previewRecoverTried = false;
  void playNextForced();
}

function toastPlayerError(msg) {
  /* minimal non-intrusive feedback */
  if (window.console?.warn) console.warn('[VibeTunes]', msg);
  const el = dom.currentArtist;
  const prev = el?.textContent;
  if (el && typeof prev === 'string') {
    el.textContent = msg;
    window.setTimeout(() => {
      const t = currentTrack();
      if (t && el.textContent === msg) el.textContent = t.artistName || '—';
    }, 2200);
  }
}

async function loadIntoAudio(shouldPlay) {
  const a = dom.audio;
  const track = currentTrack();

  state.previewRecoverTried = false;

  if (!track || !track.preview) {
    a.pause();
    a.removeAttribute('src');
    togglePlayChrome(false);
    setProgressUI(0, 0, 0);
    return;
  }

  sameOriginSafeSrc(a, track.preview);
  if (dom.totalTimeEl) {
    const hint = Math.min(Number(track.duration) || 30, 30);
    dom.totalTimeEl.textContent = formatDuration(hint);
  }
  try {
    await a.play();
    if (!shouldPlay) a.pause();
  } catch (_) {
    /* autoplay peut être bloqué */
    togglePlayChrome(false);
  }
}

/** Évite referrer mixte problématique sur certains hébergements */
function sameOriginSafeSrc(audioEl, src) {
  try {
    // Les previews Deezer sont des URLs absolues HTTPS valides.
    audioEl.src = src;
    audioEl.load();
  } catch (_) {
    audioEl.src = src;
    audioEl.load();
  }
}

function seekFromClientX(clientX) {
  const a = dom.audio;
  const bar = dom.progressBar;
  if (!a || !bar || !Number.isFinite(a.duration) || a.duration <= 0) return;

  const rect = bar.getBoundingClientRect();
  const ratio = (clientX - rect.left) / Math.max(rect.width, 1);
  const pct = Math.max(0, Math.min(1, ratio));
  a.currentTime = pct * a.duration;
  setProgressUI(pct, a.currentTime, a.duration);
}

function togglePlayPause() {
  const a = dom.audio;
  const t = currentTrack();
  if (!t || !t.preview) return;

  if (a.paused || a.ended) {
    void a.play().catch(() => togglePlayChrome(false));
  } else {
    a.pause();
  }
}

/** @returns {ReturnType<typeof normalizeTrack>|null} */
function currentTrack() {
  return state.queue[state.currentIndex] || null;
}

// -----------------------------------------------------------------------------
// QUEUE MANAGEMENT
// -----------------------------------------------------------------------------
function persistQueueOptionally() {
  try {
    const compact = state.queue.map(t => ({
      id: t.id,
      title: t.title,
      artistName: t.artistName,
      albumTitle: t.albumTitle,
      cover: t.cover,
      preview: t.preview,
      duration: t.duration,
      deezerLink: t.deezerLink
    }));
    localStorage.setItem(CONFIG.STORAGE.QUEUE, JSON.stringify(compact));
    localStorage.setItem(CONFIG.STORAGE.QUEUE_INDEX, String(state.currentIndex));
  } catch (_) {
    /* stockage indisponible */
  }
}

function restoreQueueOptionally() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE.QUEUE);
    const idxRaw = localStorage.getItem(CONFIG.STORAGE.QUEUE_INDEX);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return;
    state.queue = arr.filter(x => x && x.id);
    const idx = Number.parseInt(idxRaw || '0', 10);
    state.currentIndex = Number.isFinite(idx) ? Math.min(idx, state.queue.length - 1) : 0;
  } catch (_) {
    state.queue = [];
    state.currentIndex = -1;
  }
}

function queueReplaceAt(index, track) {
  if (index < 0 || index >= state.queue.length) return;
  state.queue[index] = track;
}

function addToRecent(track) {
  state.recent = state.recent.filter(t => t.id !== track.id);
  state.recent.unshift(track);
  if (state.recent.length > CONFIG.RECENT_MAX) state.recent.length = CONFIG.RECENT_MAX;
  try {
    localStorage.setItem(
      'vibetunes-recent',
      JSON.stringify(
        state.recent.map(t => ({
          id: t.id,
          title: t.title,
          artistName: t.artistName,
          cover: t.cover,
          preview: t.preview,
          duration: t.duration
        }))
      )
    );
  } catch (_) {
    /* ignore */
  }
}

function restoreRecent() {
  try {
    const raw = localStorage.getItem('vibetunes-recent');
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) state.recent = arr.filter(Boolean);
  } catch (_) {
    state.recent = [];
  }
}

/** @param {ReturnType<typeof normalizeTrack>[]} list */
function setQueueAndPlay(list, startIndex) {
  state.backStack.length = 0;

  const clean = Array.isArray(list) ? list.filter(t => t && t.id) : [];
  state.queue = clean;
  state.currentIndex =
    typeof startIndex === 'number'
      ? Math.max(0, Math.min(startIndex, clean.length - 1))
      : clean.length
        ? 0
        : -1;

  persistQueueOptionally();
  renderQueue();
  refreshNowPlayingChrome();
}

/**
 * @param {number} idx
 * @param {{ recordHistory?: boolean }} [opts]
 */
async function jumpToQueueIndex(idx, opts) {
  if (idx < 0 || idx >= state.queue.length) return;

  const recordHistory = opts?.recordHistory !== false;
  const previous = state.currentIndex;
  if (recordHistory && previous >= 0 && previous !== idx) state.backStack.push(previous);

  state.currentIndex = idx;
  persistQueueOptionally();
  renderQueue();
  refreshNowPlayingChrome();

  const now = currentTrack();
  if (now) addToRecent(now);

  await loadIntoAudio(true);
}

/**
 * Liste contextuelle : clic = lecture depuis l’index
 * @param {ReturnType<typeof normalizeTrack>[]} list
 */
async function playFromList(list, index) {
  setQueueAndPlay(list, index);
  addToRecent(currentTrack());
  await loadIntoAudio(true);
}

async function playNextForced() {
  if (!state.queue.length) return;

  let nextIdx = state.currentIndex + 1;
  if (state.shuffle && state.queue.length > 1) {
    let r = state.currentIndex;
    let guard = 0;
    while (r === state.currentIndex && guard++ < 12) {
      r = Math.floor(Math.random() * state.queue.length);
    }
    nextIdx = r;
  } else if (nextIdx >= state.queue.length) {
    if (state.repeatMode === 'all') nextIdx = 0;
    else {
      dom.audio.pause();
      togglePlayChrome(false);
      return;
    }
  }
  await jumpToQueueIndex(nextIdx, { recordHistory: true });
}

function playNextAutomatic() {
  void playNextForced();
}

async function playPrevious() {
  if (!state.queue.length) return;
  const a = dom.audio;
  if (a.currentTime > 2.5) {
    a.currentTime = 0;
    setProgressUI(0, 0, a.duration || 0);
    return;
  }

  let prevIdx;
  if (state.backStack.length) prevIdx = state.backStack.pop();
  else {
    prevIdx = state.currentIndex - 1;
    if (prevIdx < 0) prevIdx = state.repeatMode === 'all' ? state.queue.length - 1 : 0;
  }

  await jumpToQueueIndex(prevIdx, { recordHistory: false });
}

/** Ajoute à la fin sans changer la lecture en cours */
function enqueueMany(tracks) {
  const add = tracks.filter(t => t && t.id);
  if (!add.length) return;
  state.queue = state.queue.concat(add);
  persistQueueOptionally();
  renderQueue();
}

/** Remplace la file par la playlist et démarre au début */
async function loadPlaylistAsQueue(playlistId) {
  try {
    const tracks = await fetchPlaylistTracks(playlistId);
    const withPreview = tracks.filter(t => t.preview);
    if (!withPreview.length) {
      showSearchMessage('Aucune pré‑écoute dans cette playlist');
      return;
    }
    await playFromList(withPreview, 0);
  } catch (e) {
    showSearchMessage((e instanceof Error ? e.message : String(e)) || 'Erreur playlist');
  }
}

// -----------------------------------------------------------------------------
// UI RENDER
// -----------------------------------------------------------------------------
function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function showSearchMessage(html) {
  const dd = dom.searchDropdown;
  if (!dd) return;
  dd.innerHTML = `<div class="search-empty" role="status">${html}</div>`;
  dd.classList.add('search-dropdown--visible');
  dd.classList.remove('search-dropdown--loading');
}

function renderSearchResults(tracks) {
  const dd = dom.searchDropdown;
  if (!dd) return;

  if (!tracks.length) {
    showSearchMessage('Aucun résultat');
    return;
  }

  const frag = document.createDocumentFragment();
  const title = document.createElement('div');
  title.className = 'search-section-title';
  title.textContent = 'Titres';
  frag.appendChild(title);

  tracks.forEach((t, idx) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-result-row';
    row.setAttribute('role', 'option');

    row.innerHTML = `
      <img src="${escapeAttr(t.cover)}" alt="">
      <div class="search-result-meta">
        <span class="sr-title">${escapeHtml(t.title)}</span>
        <span class="sr-artist">${escapeHtml(t.artistName)}</span>
      </div>
      ${t.preview ? '' : '<span class="search-no-prev">Sans preview</span>'}
    `;

    row.addEventListener('click', async () => {
      dd.classList.remove('search-dropdown--visible');
      if (!t.preview) {
        try {
          const fresh = await fetchTrackById(t.id);
          await playFromList([fresh], 0);
        } catch (_) {
          showSearchMessage('Pré‑écoute indisponible');
        }
        return;
      }
      await playFromList(tracks, idx);
    });

    frag.appendChild(row);
  });

  dd.innerHTML = '';
  dd.appendChild(frag);
  dd.classList.add('search-dropdown--visible');
  dd.classList.remove('search-dropdown--loading');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

/** @param {any[]} playlists */
function renderPlaylistCards(playlists) {
  const grid = dom.playlistsGrid;
  if (!grid) return;

  grid.innerHTML = '';

  playlists.forEach(p => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-img">
        <img src="${escapeAttr(
          p.picture_medium || p.picture_small || CONFIG.PLACEHOLDER_COVER
        )}" alt="">
        <div class="play-overlay"><i class="fas fa-play"></i></div>
      </div>
      <div class="card-info">
        <h4>${escapeHtml(p.title)}</h4>
        <p>${escapeHtml(`${p.nb_tracks || '?'} titres · Deezer`)}</p>
      </div>
    `;

    card.addEventListener('click', () => {
      void loadPlaylistAsQueue(p.id);
    });

    grid.appendChild(card);
  });
}

/** @param {ReturnType<typeof normalizeTrack>[]} tracks */
function renderTopTracks(tracks) {
  const list = dom.topTracksList;
  if (!list) return;

  list.innerHTML = '';

  tracks.forEach((t, idx) => {
    const div = document.createElement('div');
    div.className = 'track-item';
    div.dataset.trackId = String(t.id);

    div.innerHTML = `
      <span class="track-rank">${idx + 1}</span>
      <img class="track-img" src="${escapeAttr(t.cover)}" alt="">
      <div class="track-details">
        <h4>${escapeHtml(t.title)}</h4>
        <p>${escapeHtml(t.artistName)}</p>
      </div>
      <span class="track-album">${escapeHtml(t.albumTitle || '—')}</span>
      <span class="track-duration">${formatDuration(t.duration)}</span>
      <div class="track-actions" aria-hidden="true">
        <i class="far fa-heart" data-action="fav" title="Favori"></i>
        <i class="fas fa-plus" data-action="addq" title="Ajouter à la file"></i>
      </div>
      ${t.preview ? '' : '<span class="track-no-preview" title="Pas de preview">—</span>'}
    `;

    div.addEventListener('click', e => {
      const act = e.target.closest?.('[data-action]');
      if (act) {
        e.stopPropagation();
        if (act.getAttribute('data-action') === 'fav') toggleFavorite(t);
        if (act.getAttribute('data-action') === 'addq') enqueueMany([t]);
        return;
      }
      void playFromList(tracks, idx);
    });

    list.appendChild(div);
  });

  highlightActiveTrackRow();
}

function renderRecent() {
  const grid = dom.recentGrid;
  if (!grid) return;
  if (!state.recent.length) {
    grid.innerHTML = `<div class="search-empty">Vos écoutes récentes apparaîtront ici</div>`;
    return;
  }

  grid.innerHTML = '';
  state.recent.forEach(t => {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.innerHTML = `
      <img src="${escapeAttr(t.cover)}" alt="">
      <div class="recent-info">
        <h4>${escapeHtml(t.title)}</h4>
        <p>${escapeHtml(t.artistName)}</p>
      </div>
    `;
    item.addEventListener('click', () => {
      void playFromList([t], 0);
    });
    grid.appendChild(item);
  });
}

function renderQueue() {
  const ul = dom.queueList;
  if (!ul) return;

  if (!state.queue.length) {
    ul.innerHTML = `<li class="queue-empty">La file est vide</li>`;
    return;
  }

  ul.innerHTML = '';

  state.queue.forEach((t, i) => {
    const li = document.createElement('li');
    li.className =
      i === state.currentIndex ? 'queue-track queue-track--current' : 'queue-track';

    li.innerHTML = `
      <img src="${escapeAttr(t.cover)}" alt="">
      <div>
        <span class="qt-title">${escapeHtml(t.title)}</span>
        <span class="qt-artist">${escapeHtml(t.artistName)}</span>
      </div>
    `;

    li.addEventListener('click', () => {
      void jumpToQueueIndex(i);
    });

    ul.appendChild(li);
  });
}

/** @param {ReturnType<typeof normalizeTrack>} track */
function updateHero(track) {
  state.heroTrack = track;
  if (!track) return;
  if (dom.heroTitle) dom.heroTitle.textContent = track.title;
  if (dom.heroArtist)
    dom.heroArtist.textContent = `${track.artistName} · ${track.albumTitle || 'Deezer'}`;
  if (dom.heroVisualImg) dom.heroVisualImg.src = track.cover || CONFIG.PLACEHOLDER_COVER;
}

function refreshNowPlayingChrome() {
  const t = currentTrack();
  if (!t) {
    if (dom.currentTitle) dom.currentTitle.textContent = '—';
    if (dom.currentArtist) dom.currentArtist.textContent = '—';
    if (dom.currentImg) dom.currentImg.src = CONFIG.PLACEHOLDER_COVER;
    highlightActiveTrackRow();
    updateLikeButton();
    return;
  }

  if (dom.currentTitle) dom.currentTitle.textContent = t.title;
  if (dom.currentArtist) dom.currentArtist.textContent = t.artistName;
  if (dom.currentImg) dom.currentImg.src = t.cover || CONFIG.PLACEHOLDER_COVER;

  highlightActiveTrackRow();
  updateLikeButton();
}

function highlightActiveTrackRow() {
  const id = currentTrack()?.id;
  document.querySelectorAll('.track-item').forEach(el => {
    const tid = Number(el.dataset.trackId);
    el.classList.toggle('track-item--active', !!id && tid === id);
  });
}

function updateLikeButton() {
  const t = currentTrack();
  const on = t && state.favorites.has(t.id);
  if (!dom.likeIcon) return;
  dom.likeIcon.classList.toggle('far', !on);
  dom.likeIcon.classList.toggle('fas', !!on);
  dom.likeBtn?.classList.toggle('active', !!on);
  if (on) dom.likeBtn.style.color = 'var(--primary-color)';
  else dom.likeBtn.style.removeProperty('color');
}

/** @param {ReturnType<typeof normalizeTrack>} track */
function toggleFavorite(track) {
  if (!track?.id) return;
  if (state.favorites.has(track.id)) state.favorites.delete(track.id);
  else state.favorites.add(track.id);
  try {
    localStorage.setItem(
      CONFIG.STORAGE.FAVORITES,
      JSON.stringify(Array.from(state.favorites))
    );
  } catch (_) {
    /* ignore */
  }
  updateLikeButton();
  renderTopTracks(state.chartTracks);
}

function updateShuffleRepeatUI() {
  dom.shuffleBtn?.classList.toggle('active', state.shuffle);
  dom.repeatBtn?.classList.toggle('repeat-mode-one', state.repeatMode === 'one');
  dom.repeatBtn?.classList.toggle('repeat-mode-all', state.repeatMode === 'all');
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------
function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}

function setupSearch() {
  const input = dom.searchInput;
  const dd = dom.searchDropdown;
  if (!input || !dd) return;

  const run = debounce(async () => {
    const q = input.value.trim();
    const myId = ++state.searchAbortId;

    if (!q) {
      dd.classList.remove('search-dropdown--visible', 'search-dropdown--loading');
      dd.innerHTML = '';
      return;
    }

    dd.classList.add('search-dropdown--visible', 'search-dropdown--loading');
    dd.innerHTML = `<div class="search-empty"><i class="fas fa-spinner fa-spin"></i> Recherche…</div>`;

    try {
      const tracks = await fetchSearchTracks(q);
      if (myId !== state.searchAbortId) return;
      state.searchResults = tracks;
      renderSearchResults(tracks);
    } catch (e) {
      if (myId !== state.searchAbortId) return;
      showSearchMessage(escapeHtml((e instanceof Error ? e.message : String(e)) || 'Erreur'));
    }
  }, CONFIG.SEARCH_DEBOUNCE_MS);

  input.addEventListener('input', run);
  input.addEventListener('focus', () => {
    if (input.value.trim() && dd.childElementCount) dd.classList.add('search-dropdown--visible');
  });

  document.addEventListener('click', e => {
    if (!dom.searchWrap?.contains(e.target)) {
      dd.classList.remove('search-dropdown--visible');
    }
  });
}

function setupProgressInteractions() {
  const bar = dom.progressBar;
  const a = dom.audio;
  if (!bar || !a) return;

  const release = ev => {
    try {
      if (typeof ev.pointerId === 'number') bar.releasePointerCapture(ev.pointerId);
    } catch (_) {
      /* ignore */
    }
    state.isScrubbing = false;
    if (Number.isFinite(a.duration) && a.duration > 0) {
      setProgressUI(a.currentTime / a.duration, a.currentTime, a.duration);
    }
    if (!a.paused) {
      togglePlayChrome(true);
      startProgressAnimation();
    }
  };

  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    state.isScrubbing = true;
    seekFromClientX(e.clientX);
    try {
      bar.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  });

  bar.addEventListener('pointermove', e => {
    if (!state.isScrubbing) return;
    seekFromClientX(e.clientX);
  });

  bar.addEventListener('pointerup', release);
  bar.addEventListener('pointercancel', release);

  bar.addEventListener('keydown', e => {
    const a = dom.audio;
    if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
    const step = a.duration * 0.05;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      a.currentTime = Math.min(a.duration, a.currentTime + step);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      a.currentTime = Math.max(0, a.currentTime - step);
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      togglePlayPause();
    }
  });
}

function setupVolume() {
  const bar = dom.volumeBar;
  const fill = dom.volumeFill;
  const icon = dom.volumeIcon;
  if (!bar || !fill) return;

  const apply = ratio => {
    const r = Math.max(0, Math.min(1, ratio));
    state.volume = r;
    fill.style.width = `${r * 100}%`;
    dom.audio.volume = r;
    try {
      localStorage.setItem(CONFIG.STORAGE.VOLUME, String(r));
    } catch (_) {
      /* ignore */
    }

    if (!icon) return;
    if (r === 0) icon.className = 'fas fa-volume-mute';
    else if (r < 0.5) icon.className = 'fas fa-volume-down';
    else icon.className = 'fas fa-volume-up';
  };

  bar.addEventListener('click', e => {
    const rect = bar.getBoundingClientRect();
    apply((e.clientX - rect.left) / Math.max(rect.width, 1));
  });

  const saved = Number.parseFloat(localStorage.getItem(CONFIG.STORAGE.VOLUME) || '');
  if (Number.isFinite(saved)) apply(saved);
  else apply(state.volume);
}

function setupPlayerControls() {
  dom.playPauseBtn?.addEventListener('click', () => togglePlayPause());
  dom.nextBtn?.addEventListener('click', () => void playNextForced());
  dom.prevBtn?.addEventListener('click', () => void playPrevious());

  dom.shuffleBtn?.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    try {
      localStorage.setItem(CONFIG.STORAGE.SHUFFLE, state.shuffle ? '1' : '0');
    } catch (_) {
      /* ignore */
    }
    updateShuffleRepeatUI();
  });

  dom.repeatBtn?.addEventListener('click', () => {
    const order = ['none', 'all', 'one'];
    const i = order.indexOf(state.repeatMode);
    state.repeatMode = order[(i + 1) % order.length];
    try {
      localStorage.setItem(CONFIG.STORAGE.REPEAT, state.repeatMode);
    } catch (_) {
      /* ignore */
    }
    updateShuffleRepeatUI();
  });

  dom.likeBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const t = currentTrack();
    if (t) toggleFavorite(t);
  });
}

function setupQueuePanel() {
  const open = () => {
    dom.queuePanel?.classList.add('queue-panel--open');
    dom.queuePanel?.setAttribute('aria-hidden', 'false');
  };
  const close = () => {
    dom.queuePanel?.classList.remove('queue-panel--open');
    dom.queuePanel?.setAttribute('aria-hidden', 'true');
  };

  dom.queueToggle?.addEventListener('click', open);
  dom.queueClose?.addEventListener('click', close);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
}

function setupHeroActions() {
  dom.heroPlayBtn?.addEventListener('click', async () => {
    const t = state.heroTrack || state.chartTracks[0];
    if (!t) return;
    if (!t.preview) {
      try {
        const fresh = await fetchTrackById(t.id);
        await playFromList([fresh], 0);
      } catch (_) {
        /* ignore */
      }
      return;
    }
    await playFromList(state.chartTracks, Math.max(0, state.chartTracks.indexOf(t)));
  });

  dom.heroQueueBtn?.addEventListener('click', () => {
    const slice = state.chartTracks.slice(0, 12).filter(x => x.preview);
    enqueueMany(slice);
  });
}

/** Ordre du cycle — extensible : ajouter un id + bloc CSS body[data-theme="…"] */
const THEME_IDS = /** @type {const} */ (['dark', 'light', 'orange']);

/**
 * @param {string} themeId
 */
function applyTheme(themeId) {
  const id = THEME_IDS.includes(themeId) ? themeId : 'dark';
  const body = dom.body;
  if (!body) return;

  body.dataset.theme = id;
  try {
    localStorage.setItem(CONFIG.STORAGE.THEME, id);
  } catch (_) {
    /* ignore */
  }

  const iconEl = document.getElementById('theme-toggle-icon');
  if (iconEl) {
    iconEl.className = 'fas ';
    if (id === 'dark') iconEl.classList.add('fa-moon');
    else if (id === 'light') iconEl.classList.add('fa-sun');
    else iconEl.classList.add('fa-fire');
  }

  const labelEl = document.getElementById('theme-toggle-label');
  if (labelEl) {
    labelEl.textContent =
      id === 'dark' ? 'Sombre' : id === 'light' ? 'Clair' : 'Orange premium';
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const c =
      id === 'light' ? '#f4f6f9' : id === 'dark' ? '#0a0a0a' : '#ff2600';
    meta.setAttribute('content', c);
  }
}

function cycleTheme() {
  const cur = dom.body?.dataset.theme || 'dark';
  const i = Math.max(0, THEME_IDS.indexOf(cur));
  applyTheme(THEME_IDS[(i + 1) % THEME_IDS.length]);
}

function setupThemeAndMobile() {
  const themeToggle = dom.themeToggle;

  const saved = localStorage.getItem(CONFIG.STORAGE.THEME);
  if (saved === 'dark' || saved === 'light' || saved === 'orange') applyTheme(saved);
  else applyTheme('dark');

  themeToggle?.addEventListener('click', () => cycleTheme());

  themeToggle?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      cycleTheme();
    }
  });

  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);

  const style = document.createElement('style');
  style.textContent = `
        .sidebar-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);z-index:99;opacity:0;visibility:hidden;transition:.3s;}
        .sidebar-overlay.active{opacity:1;visibility:visible}`;
  document.head.appendChild(style);

  dom.mobileMenuBtn?.addEventListener('click', () => {
    dom.sidebar?.classList.toggle('active');
    overlay.classList.toggle('active');
  });

  overlay.addEventListener('click', () => {
    dom.sidebar?.classList.remove('active');
    overlay.classList.remove('active');
  });
}

function setupGlobalsKeyboard() {
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayPause();
    }
  });
}

function setupNavMenuActive() {
  document.querySelectorAll('.nav-menu ul li').forEach(link => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.nav-menu ul li').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });
}

function setupSearchBarAnimation() {
  const input = dom.searchInput;
  const searchBar = document.querySelector('.search-bar');
  if (!input || !searchBar) return;
  input.addEventListener('focus', () => {
    searchBar.style.maxWidth = '550px';
  });
  input.addEventListener('blur', () => {
    searchBar.style.maxWidth = '450px';
  });
}

// -----------------------------------------------------------------------------
// INIT
// -----------------------------------------------------------------------------
function restorePreferences() {
  try {
    const favRaw = localStorage.getItem(CONFIG.STORAGE.FAVORITES);
    if (favRaw) {
      const arr = JSON.parse(favRaw);
      if (Array.isArray(arr)) state.favorites = new Set(arr.map(Number).filter(Number.isFinite));
    }
  } catch (_) {
    state.favorites = new Set();
  }

  state.shuffle = localStorage.getItem(CONFIG.STORAGE.SHUFFLE) === '1';
  const rep = localStorage.getItem(CONFIG.STORAGE.REPEAT);
  if (rep === 'all' || rep === 'one' || rep === 'none') state.repeatMode = rep;

  restoreRecent();
  restoreQueueOptionally();
}

async function bootstrapContent() {
  dom.topTracksList && (dom.topTracksList.innerHTML = `<div class="search-empty">Chargement…</div>`);
  dom.playlistsGrid && (dom.playlistsGrid.innerHTML = `<div class="search-empty">Chargement…</div>`);

  try {
    const [tracks, playlists] = await Promise.all([fetchChartTracks(), fetchChartPlaylists()]);
    state.chartTracks = tracks;
    state.chartPlaylists = playlists;

    renderTopTracks(tracks);
    renderPlaylistCards(playlists);
    renderRecent();

    const hero = tracks[0] || null;
    updateHero(hero);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)) || 'Impossible de joindre Deezer';
    dom.topTracksList && (dom.topTracksList.innerHTML = `<div class="load-error">${escapeHtml(
      msg
    )}</div>`);
    dom.playlistsGrid && (dom.playlistsGrid.innerHTML = '');
  }

  if (state.queue.length && state.currentIndex >= 0) {
    refreshNowPlayingChrome();
    setProgressUI(0, 0, 0);
    await loadIntoAudio(false);
  } else {
    refreshNowPlayingChrome();
  }

  updateShuffleRepeatUI();
}

function init() {
  cacheDom();
  restorePreferences();
  bindAudioHandlers();
  setupThemeAndMobile();
  setupSearch();
  setupSearchBarAnimation();
  setupProgressInteractions();
  setupVolume();
  setupPlayerControls();
  setupQueuePanel();
  setupHeroActions();
  setupGlobalsKeyboard();
  setupNavMenuActive();

  void bootstrapContent();
  renderQueue();

  // petit hook inutilisé volontairement — réservé extensions
}

document.addEventListener('DOMContentLoaded', init);
