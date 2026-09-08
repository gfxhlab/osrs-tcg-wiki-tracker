const API_BASE = 'https://api.osrs-tcg.net/api/v1';
const DEFAULT_SETTINGS = {
  album: 'FoilsGold',
  collectionMode: 'individual',
  refreshMinutes: 15,
};

const STORAGE_KEYS = {
  settings: 'settings',
  album: 'albumData',
  albumEtag: 'albumEtag',
  albumFetchedAt: 'albumFetchedAt',
  albumStats: 'albumStats',
  albumStatsEtag: 'albumStatsEtag',
  catalog: 'catalogData',
  catalogEtag: 'catalogEtag',
  catalogFetchedAt: 'catalogFetchedAt',
};

const CATALOG_MAX_AGE_MS = 30 * 60 * 1000;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await scheduleRefresh();
  refreshCollection().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSettings();
  await scheduleRefresh();
  refreshCollection().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'album-refresh') {
    refreshCollection().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_STATE':
        sendResponse(await getSnapshot());
        break;
      case 'REFRESH':
        sendResponse(await refreshCollection());
        break;
      case 'GET_SETTINGS':
        sendResponse({ settings: await getSettings() });
        break;
      case 'SAVE_SETTINGS':
        sendResponse({ settings: await saveSettings(message.settings || {}) });
        break;
      case 'OPEN_ALBUM_SEARCH':
        sendResponse(await openAlbumSearch(message.album, message.query));
        break;
      default:
        sendResponse({ error: 'Unknown message' });
    }
  })().catch((error) => {
    sendResponse({ error: error.message || String(error) });
  });
  return true;
});

async function ensureSettings() {
  const current = await getSettings();
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: normalizeSettings(current),
  });
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return normalizeSettings(stored[STORAGE_KEYS.settings]);
}

// Serialize settings changes and refreshes so an old request cannot overwrite a new mode.
let collectionQueue = Promise.resolve();
function enqueueCollection(operation) {
  const result = collectionQueue.then(operation);
  collectionQueue = result.catch(() => {});
  return result;
}

function saveSettings(next) {
  return enqueueCollection(() => saveSettingsNow(next));
}

async function saveSettingsNow(next) {
  const settings = normalizeSettings(next);
  const previous = await getSettings();
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  if (settings.refreshMinutes !== previous.refreshMinutes) {
    await scheduleRefresh();
  }
  if (settings.album !== previous.album || settings.collectionMode !== previous.collectionMode) {
    await chrome.storage.local.remove([
      STORAGE_KEYS.album,
      STORAGE_KEYS.albumEtag,
      STORAGE_KEYS.albumFetchedAt,
      STORAGE_KEYS.albumStats,
      STORAGE_KEYS.albumStatsEtag,
    ]);
  }
  return settings;
}

function normalizeSettings(settings) {
  const album = String(settings?.album || DEFAULT_SETTINGS.album)
    .trim()
    .replace(/^@/, '');
  const parsedMinutes = Number(settings?.refreshMinutes);
  const refreshMinutes = Number.isFinite(parsedMinutes)
    ? Math.min(30, Math.max(15, Math.round(parsedMinutes)))
    : DEFAULT_SETTINGS.refreshMinutes;
  return {
    album: album || DEFAULT_SETTINGS.album,
    collectionMode: settings?.collectionMode === 'group' ? 'group' : 'individual',
    refreshMinutes,
  };
}

async function scheduleRefresh() {
  const settings = await getSettings();
  await chrome.alarms.clear('album-refresh');
  chrome.alarms.create('album-refresh', {
    delayInMinutes: 0.5,
    periodInMinutes: settings.refreshMinutes,
  });
}

function getSnapshot() {
  return enqueueCollection(getSnapshotNow);
}

async function getSnapshotNow() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.album,
    STORAGE_KEYS.catalog,
    STORAGE_KEYS.albumFetchedAt,
  ]);
  const album = stored[STORAGE_KEYS.album] || null;
  const catalog = stored[STORAGE_KEYS.catalog] || null;
  if (!album || !catalog) {
    return refreshCollectionNow();
  }
  return {
    ok: true,
    settings: normalizeSettings(stored[STORAGE_KEYS.settings]),
    album: normalizeCollection(album, normalizeSettings(stored[STORAGE_KEYS.settings]).collectionMode),
    catalog,
    fetchedAt: stored[STORAGE_KEYS.albumFetchedAt] || null,
  };
}

function refreshCollection() {
  return enqueueCollection(refreshCollectionNow);
}

function normalizeCollection(data, mode) {
  const collection = mode === 'group' ? data?.group : data;
  if (!collection || !Array.isArray(collection.cardEntries)) {
    throw new Error(mode === 'group'
      ? 'Group collection unavailable: expected group.cardEntries. Check that this player belongs to a public group.'
      : 'Invalid player collection response: expected cardEntries.');
  }
  return collection;
}

async function refreshCollectionNow() {
  const settings = await getSettings();
  const now = Date.now();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.album,
    STORAGE_KEYS.albumEtag,
    STORAGE_KEYS.albumFetchedAt,
    STORAGE_KEYS.catalog,
    STORAGE_KEYS.catalogEtag,
    STORAGE_KEYS.catalogFetchedAt,
    STORAGE_KEYS.albumStats,
    STORAGE_KEYS.albumStatsEtag,
  ]);

  const isGroup = settings.collectionMode === 'group';
  // Individual stats cannot detect changes to another group member's cards.
  const statsResult = isGroup ? { data: null, etag: null } : await fetchCachedJson(
    `${API_BASE}/players/${encodeURIComponent(settings.album)}/stats`,
    stored[STORAGE_KEYS.albumStats],
    stored[STORAGE_KEYS.albumStatsEtag],
  );
  const statsChanged = isGroup || !stored[STORAGE_KEYS.album]
    || JSON.stringify(statsResult.data) !== JSON.stringify(stored[STORAGE_KEYS.albumStats]);

  let albumResult = {
    data: stored[STORAGE_KEYS.album],
    etag: stored[STORAGE_KEYS.albumEtag],
  };
  let albumFetchedAt = null;
  if (statsChanged) {
    const url = isGroup
      ? `https://osrs-tcg.net/api/v1/players/${encodeURIComponent(settings.album)}/group`
      : `${API_BASE}/players/${encodeURIComponent(settings.album)}`;
    albumResult = await fetchCachedJson(
      url, stored[STORAGE_KEYS.album], stored[STORAGE_KEYS.albumEtag],
    );
    albumFetchedAt = now;
  }
  const album = normalizeCollection(albumResult.data, settings.collectionMode);

  let catalogResult;
  const catalogIsFresh = stored[STORAGE_KEYS.catalog]
    && now - Number(stored[STORAGE_KEYS.catalogFetchedAt] || 0) < CATALOG_MAX_AGE_MS;
  if (catalogIsFresh) {
    catalogResult = {
      data: stored[STORAGE_KEYS.catalog],
      etag: stored[STORAGE_KEYS.catalogEtag],
    };
  } else {
    catalogResult = await fetchCachedJson(
      `${API_BASE}/catalog/cards/live`,
      stored[STORAGE_KEYS.catalog],
      stored[STORAGE_KEYS.catalogEtag],
    );
  }

  const values = {
    [STORAGE_KEYS.album]: albumResult.data,
    [STORAGE_KEYS.albumEtag]: albumResult.etag || null,
    [STORAGE_KEYS.albumFetchedAt]: albumFetchedAt || stored[STORAGE_KEYS.albumFetchedAt] || now,
    [STORAGE_KEYS.albumStats]: statsResult.data,
    [STORAGE_KEYS.albumStatsEtag]: statsResult.etag || null,
    [STORAGE_KEYS.catalog]: catalogResult.data,
    [STORAGE_KEYS.catalogEtag]: catalogResult.etag || null,
    [STORAGE_KEYS.catalogFetchedAt]: catalogIsFresh
      ? stored[STORAGE_KEYS.catalogFetchedAt]
      : now,
  };
  await chrome.storage.local.set(values);

  const snapshot = {
    ok: true,
    settings,
    album,
    stats: isGroup ? album.stats : statsResult.data,
    catalog: catalogResult.data,
    fetchedAt: albumFetchedAt || stored[STORAGE_KEYS.albumFetchedAt] || now,
  };
  await broadcastSnapshot(snapshot);
  return snapshot;
}

async function fetchCachedJson(url, cachedData, etag) {
  const headers = {};
  if (etag) {
    headers['If-None-Match'] = etag;
  }
  const response = await fetch(url, { headers, cache: 'no-store' });
  if (response.status === 304) {
    if (!cachedData) {
      throw new Error(`API returned 304 without cached data for ${url}`);
    }
    return { data: cachedData, etag };
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = body?.error?.message || body?.error || detail;
    } catch (_) {
      // Keep the HTTP status as the useful error.
    }
    throw new Error(detail);
  }
  return {
    data: await response.json(),
    etag: response.headers.get('ETag') || null,
  };
}

async function broadcastSnapshot(snapshot) {
  const tabs = await chrome.tabs.query({
    url: ['https://oldschool.runescape.wiki/w/*'],
  });
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'COLLECTION_UPDATED',
        snapshot,
      });
    } catch (_) {
      // A tab may not have a content script yet.
    }
  }));
}

async function openAlbumSearch(album, query) {
  const safeAlbum = String(album || '').trim().replace(/^@/, '');
  const searchQuery = String(query || '').trim();
  if (!safeAlbum || !searchQuery) {
    return { ok: false, error: 'Card search requires an RSN and card name.' };
  }

  const tab = await chrome.tabs.create({
    url: `https://osrs-tcg.net/album/${encodeURIComponent(safeAlbum)}`,
  });
  if (tab.id) scheduleAlbumSearch(tab.id, searchQuery);
  return { ok: true, tabId: tab.id };
}

function scheduleAlbumSearch(tabId, query) {
  let attempts = 0;
  const tryFill = async () => {
    attempts += 1;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: fillAlbumSearch,
        args: [query],
      });
      if (results?.[0]?.result) return;
    } catch (_) {
      // The tab may still be loading or briefly show the site's challenge page.
    }
    if (attempts < 30) setTimeout(tryFill, 500);
  };
  tryFill();
}

function fillAlbumSearch(query) {
  const input = document.querySelector(
    '.album-toolbar__search input[type="search"], .album-mobile-search input[type="search"], input[type="search"][placeholder="Search"]',
  );
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(input, query);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.focus();
  return true;
}
