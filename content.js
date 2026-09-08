let snapshot = null;
let renderTimer = null;
let renderGeneration = 0;
const REDIRECT_CACHE_KEY = 'wikiRedirectCache';
const REDIRECT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const redirectMemoryCache = new Map();
const CARD_TEMPLATE_NAMES = new Set([
  'template:infobox item',
  'template:infobox npc',
  'template:infobox monster',
]);

start();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'COLLECTION_UPDATED') {
    snapshot = message.snapshot;
    renderStatus();
  }
});

const pageObserver = new MutationObserver((records) => {
  const pageChanged = records.some((record) => {
    return [...record.addedNodes, ...record.removedNodes].some((node) => !isExtensionNode(node));
  });
  if (!pageChanged) return;
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderStatus, 150);
});
pageObserver.observe(document.documentElement, { childList: true, subtree: true });

async function start() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response?.ok) {
      snapshot = response;
      renderStatus();
    }
  } catch (_) {
    // The page remains usable if the extension service worker is unavailable.
  }
}

function renderStatus() {
  const generation = ++renderGeneration;
  removePageStatus();
  if (!snapshot?.album || !snapshot?.catalog) return;

  const owned = new Map(getOwnedEntries(snapshot.album).map((entry) => [entry.key, entry]));
  const statusIndex = buildStatusIndex(snapshot.catalog, owned);
  const page = getPageIdentity();
  let entries = statusIndex.get(page.wikiPage) || [];
  if (page.id !== null) {
    const idMatches = entries.filter((entry) => entry.id === page.id);
    if (idMatches.length) entries = idMatches;
  }
  if (entries.length) {
    renderPageStatus(summarizeEntries(entries, owned, page.wikiPage));
  } else if (hasCardInfobox()) {
    renderPageStatus(createNoCardStatus());
  }
  annotateWikiLinks(statusIndex, owned, generation);
}

function hasCardInfobox() {
  return Boolean(getCardInfobox());
}

function getCardInfobox() {
  return document.querySelector(
    'table.infobox-item, table.infobox-npc, table.infobox-monster',
  );
}

function createNoCardStatus() {
  return {
    state: 'owned',
    label: 'No card',
    detail: 'No OSRS TCG card',
    copyCount: 0,
    finish: '—',
    variantOf: null,
    hasCard: false,
    title: 'OSRS TCG: No card exists for this item or NPC',
  };
}

function removePageStatus() {
  document.querySelectorAll(
    '#osrs-tcg-status, #osrs-tcg-infobox-row, .osrs-tcg-infobox-detail-row',
  ).forEach((node) => node.remove());
}

function isExtensionNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return true;
  return Boolean(
    node.id?.startsWith('osrs-tcg-')
    || node.classList?.contains('osrs-tcg-link-status')
    || node.classList?.contains('osrs-tcg-infobox-detail-row')
    || node.closest?.('#osrs-tcg-status, #osrs-tcg-infobox-row, .osrs-tcg-link-status'),
  );
}

function getPageIdentity() {
  const configuredName = window.mw?.config?.get?.('wgPageName');
  const title = configuredName
    || document.querySelector('.mw-page-title-main')?.textContent
    || document.title.replace(/\s+-\s+OSRS Wiki$/, '');
  const wikiPage = normalizeWikiPage(title);
  const id = extractInfoboxId();
  return { wikiPage, id };
}

function extractInfoboxId() {
  const infobox = document.querySelector('table.infobox-item, table.infobox-npc, table.infobox');
  if (!infobox) return null;
  for (const row of infobox.querySelectorAll('tr')) {
    const label = row.querySelector('th')?.textContent?.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!label || !/^(item|npc)?\s*id$/.test(label)) continue;
    const value = row.querySelector('td')?.textContent?.match(/\d+/)?.[0];
    if (value) return Number(value);
  }
  return null;
}

function getCatalogEntries(catalog) {
  const entries = [];
  for (const [kindList, kind] of [['items', 'item'], ['npcs', 'npc']]) {
    for (const raw of catalog?.[kindList] || []) {
      const id = Number(raw.id);
      const wikiPage = normalizeWikiPage(raw.wiki?.page);
      if (!Number.isFinite(id) || !wikiPage) continue;
      entries.push({
        key: `${kind}:${id}`,
        kind,
        id,
        name: raw.name || '',
        wikiPage,
        variantNames: (raw.tcg?.variants || [])
          .map((variant) => variant.name)
          .filter(Boolean),
      });
    }
  }
  return entries;
}

function buildStatusIndex(catalog, owned) {
  const index = new Map();
  const entries = getCatalogEntries(catalog).map((entry) => ({
      ...entry,
      owned: owned.get(entry.key) || null,
    }));

  for (const entry of entries) {
    if (!index.has(entry.wikiPage)) index.set(entry.wikiPage, []);
    index.get(entry.wikiPage).push(entry);
  }

  // Some catalog cards use a disambiguated Wiki page or group variants under
  // one card while article links use the variant's normal name. For example,
  // the Sheep card links to "Sheep (penguins)" while quest pages link to
  // "Sheep", and Blue logs is a variant of the Logs card. Only add
  // unambiguous aliases so duplicate item/NPC names cannot produce a false
  // status.
  const aliases = new Map();
  for (const entry of entries) {
    const aliasNames = [entry.name, ...entry.variantNames];
    for (const name of aliasNames) {
      const alias = normalizeWikiPage(name);
      if (!alias || alias === entry.wikiPage) continue;
      const candidates = aliases.get(alias) || new Map();
      candidates.set(entry.key, entry);
      aliases.set(alias, candidates);
    }
  }
  for (const [alias, candidates] of aliases) {
    if (candidates.size === 1 && !index.has(alias)) {
      index.set(alias, [...candidates.values()]);
    }
  }
  return index;
}

function summarizeEntries(entries, owned, wikiPage = null) {
  const ownedEntries = entries.filter((entry) => owned.has(entry.key));
  const foilCount = ownedEntries.reduce((count, entry) => {
    return count + countFoils(owned.get(entry.key));
  }, 0);
  const totalCopies = ownedEntries.reduce((count, entry) => {
    return count + countCopies(owned.get(entry.key));
  }, 0);
  const nonFoilCount = Math.max(0, totalCopies - foilCount);
  const variantOf = getVariantSource(entries, wikiPage);
  const searchName = getSearchName(entries, wikiPage);
  const state = ownedEntries.length === entries.length ? 'owned' : 'missing';
  const label = entries.length === 1
    ? (state === 'owned' ? 'Unlocked' : 'Locked')
    : `${ownedEntries.length}/${entries.length} cards owned`;
  const detail = [
    `${totalCopies || 0} ${totalCopies === 1 ? 'copy' : 'copies'}`,
    foilCount ? `${foilCount} foil` : null,
    nonFoilCount ? `${nonFoilCount} non-foil` : null,
    variantOf ? `variant of ${variantOf}` : null,
  ].filter(Boolean).join(' · ');
  return {
    state,
    label,
    detail,
    copyCount: totalCopies,
    finish: formatFinish(foilCount, nonFoilCount),
    variantOf,
    searchName,
    title: `OSRS TCG: ${label}${detail ? ` (${detail})` : ''}`,
  };
}

function formatFinish(foilCount, nonFoilCount) {
  if (foilCount && nonFoilCount) return `${foilCount} foil · ${nonFoilCount} non-foil`;
  if (foilCount) return foilCount === 1 ? 'Foil' : `${foilCount} foil`;
  if (nonFoilCount) return nonFoilCount === 1 ? 'Non-foil' : `${nonFoilCount} non-foil`;
  return '—';
}

function getVariantSource(entries, wikiPage) {
  if (!wikiPage) return null;
  const sources = new Set();
  for (const entry of entries) {
    if (wikiPage === entry.wikiPage) continue;
    if (entry.variantNames.some((name) => normalizeWikiPage(name) === wikiPage)) {
      sources.add(entry.name);
    }
  }
  return sources.size === 1 ? [...sources][0] : null;
}

function getSearchName(entries, wikiPage) {
  if (!entries.length) return null;
  if (entries.length > 1) return wikiPage || null;
  const entry = entries[0];
  const variantName = entry.variantNames.find((name) => normalizeWikiPage(name) === wikiPage);
  return variantName || entry.name || null;
}

function renderPageStatus(status) {
  const badge = document.createElement('a');
  badge.id = 'osrs-tcg-status';
  badge.className = `osrs-tcg-status osrs-tcg-status--${status.state}`;
  if (status.searchName) {
    badge.href = `https://osrs-tcg.net/album/${encodeURIComponent(snapshot.settings.album)}`;
    badge.target = '_blank';
    badge.rel = 'noopener noreferrer';
    badge.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      chrome.runtime.sendMessage({
        type: 'OPEN_ALBUM_SEARCH',
        album: snapshot.settings.album,
        query: status.searchName,
      }).catch(() => window.open(badge.href, '_blank', 'noopener,noreferrer'));
    });
  } else {
    badge.setAttribute('aria-disabled', 'true');
  }
  badge.title = status.title;
  const indicator = document.createElement('span');
  indicator.className = 'osrs-tcg-status-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.textContent = status.state === 'owned' ? '✓' : '×';
  badge.append(indicator, document.createTextNode(`OSRS TCG - ${status.label}`));

  const heading = document.querySelector('#firstHeading');
  if (heading) heading.insertAdjacentElement('afterend', badge);

  const infobox = getCardInfobox();
  if (infobox?.tBodies[0]) {
    const totalColumns = getInfoboxColumnCount(infobox);
    const labelColumns = Math.round(totalColumns / 3);
    const rows = [];
    const header = document.createElement('tr');
    header.id = 'osrs-tcg-infobox-row';
    header.innerHTML = `<th colspan="${totalColumns}" class="infobox-subheader">OSRS TCG</th>`;
    rows.push(header);

    addInfoboxDetailRow(rows, 'Status', status.label, status.state, labelColumns, totalColumns);
    if (status.hasCard !== false) {
      addInfoboxDetailRow(rows, 'Copies', String(status.copyCount), null, labelColumns, totalColumns);
      addInfoboxDetailRow(rows, 'Finish', status.finish, null, labelColumns, totalColumns);
      if (status.variantOf) {
        addInfoboxDetailRow(rows, 'Variant of', status.variantOf, null, labelColumns, totalColumns);
      }
    }

    const fragment = document.createDocumentFragment();
    rows.forEach((row) => fragment.append(row));
    infobox.tBodies[0].append(fragment);
  }
}

function addInfoboxDetailRow(rows, label, value, state, labelColumns, totalColumns) {
  const row = document.createElement('tr');
  row.className = 'osrs-tcg-infobox-detail-row';
  row.innerHTML = `<th colspan="${labelColumns}">${label}</th><td colspan="${totalColumns - labelColumns}"></td>`;
  const valueElement = document.createElement('span');
  valueElement.className = state ? `osrs-tcg-infobox-value osrs-tcg-infobox-value--${state}` : 'osrs-tcg-infobox-value';
  valueElement.textContent = value;
  row.querySelector('td').append(valueElement);
  rows.push(row);
}

function getInfoboxColumnCount(infobox) {
  let columns = 20;
  for (const cell of infobox.querySelectorAll('[colspan]')) {
    const colspan = Number(cell.getAttribute('colspan'));
    if (Number.isFinite(colspan)) columns = Math.max(columns, colspan);
  }
  return columns;
}

async function annotateWikiLinks(statusIndex, owned, generation) {
  const root = document.querySelector('#mw-content-text .mw-parser-output');
  if (!root) return;

  const links = [...root.querySelectorAll('a[href^="/w/"]')]
    .filter((link) => !link.closest('#osrs-tcg-status, #osrs-tcg-infobox-row'));
  const redirectLinks = [];
  const statuses = new Map();
  for (const link of links) {
    const wikiPage = getLinkedWikiPage(link);
    if (!wikiPage) continue;
    const entries = statusIndex.get(wikiPage);
    if (entries?.length) {
      statuses.set(link, summarizeEntries(entries, owned, wikiPage));
    } else if (isResolvableArticleLink(wikiPage)) {
      redirectLinks.push({ link, wikiPage });
    }
  }

  for (const [link, status] of statuses) addLinkMarker(link, status);

  if (redirectLinks.length) {
    const resolution = await resolveWikiLinks(redirectLinks.map((item) => item.wikiPage));
    if (generation !== renderGeneration) return;

    for (const { link, wikiPage } of redirectLinks) {
      const resolvedPage = resolution.redirects.get(wikiPage);
      const entries = resolvedPage ? statusIndex.get(resolvedPage) : null;
      if (entries?.length) {
        statuses.set(link, summarizeEntries(entries, owned, resolvedPage));
      } else if (resolution.cardLike.has(wikiPage)) {
        statuses.set(link, createNoCardStatus());
      }
    }
  }

  for (const link of links) {
    const status = statuses.get(link);
    if (status) addLinkMarker(link, status);
    else removeLinkMarker(link);
  }
  root.querySelectorAll('.osrs-tcg-link-status').forEach((marker) => {
    if (!links.includes(marker.previousElementSibling)) marker.remove();
  });
}

function addLinkMarker(link, status) {
  let marker = link.nextElementSibling;
  if (!marker?.classList.contains('osrs-tcg-link-status')) {
    marker = document.createElement('span');
    link.insertAdjacentElement('afterend', marker);
  }
  marker.className = `osrs-tcg-link-status osrs-tcg-link-status--${status.state}`;
  marker.title = status.title;
  marker.setAttribute('aria-label', status.title);
  marker.textContent = status.state === 'owned' ? '✓' : '×';
  link.setAttribute('data-osrs-tcg-annotated', 'true');
}

function removeLinkMarker(link) {
  const marker = link.nextElementSibling;
  if (marker?.classList.contains('osrs-tcg-link-status')) marker.remove();
  link.removeAttribute('data-osrs-tcg-annotated');
}

async function resolveWikiLinks(titles) {
  const uniqueTitles = [...new Set(titles)];
  const now = Date.now();
  const redirects = new Map();
  const cardLike = new Set();
  const missingTitles = [];
  let storedCache = {};

  try {
    const stored = await chrome.storage.local.get(REDIRECT_CACHE_KEY);
    storedCache = stored[REDIRECT_CACHE_KEY] || {};
  } catch (_) {
    // In-memory caching still prevents repeated lookups in this page.
  }

  for (const title of uniqueTitles) {
    const cached = redirectMemoryCache.get(title) || storedCache[title];
    if (cached && now - Number(cached.savedAt || 0) < REDIRECT_CACHE_TTL_MS) {
      if (cached.target) redirects.set(title, cached.target);
      if (cached.cardLike === true) cardLike.add(title);
      if (typeof cached.cardLike !== 'boolean') missingTitles.push(title);
    } else {
      missingTitles.push(title);
    }
  }

  for (const batch of chunk(missingTitles, 40)) {
    const params = new URLSearchParams({
      action: 'query',
      titles: batch.join('|'),
      redirects: '1',
      prop: 'templates',
      tltemplates: 'Template:Infobox Item|Template:Infobox NPC|Template:Infobox Monster',
      tllimit: 'max',
      format: 'json',
      formatversion: '2',
    });
    try {
      const response = await fetch(`/api.php?${params.toString()}`, {
        credentials: 'same-origin',
        cache: 'force-cache',
      });
      if (!response.ok) continue;
      const data = await response.json();
      const batchRedirects = new Map();
      for (const redirect of data?.query?.redirects || []) {
        batchRedirects.set(normalizeWikiPage(redirect.from), normalizeWikiPage(redirect.to));
      }
      const pageCardLike = new Map();
      for (const page of data?.query?.pages || []) {
        const pageTitle = normalizeWikiPage(page.title);
        const hasCardTemplate = (page.templates || []).some((template) => {
          return CARD_TEMPLATE_NAMES.has(normalizeWikiPage(template.title));
        });
        pageCardLike.set(pageTitle, hasCardTemplate);
      }
      for (const title of batch) {
        const target = batchRedirects.get(title) || null;
        const pageTitle = target || title;
        const isCardLike = pageCardLike.get(pageTitle) === true;
        const cacheEntry = { target, cardLike: isCardLike, savedAt: now };
        redirectMemoryCache.set(title, cacheEntry);
        storedCache[title] = cacheEntry;
        if (target) redirects.set(title, target);
        if (isCardLike) cardLike.add(title);
      }
    } catch (_) {
      // Direct catalog matches remain usable if redirect lookup fails.
    }
  }

  try {
    const entries = Object.entries(storedCache)
      .filter(([, entry]) => entry && Number.isFinite(Number(entry.savedAt)))
      .sort(([, a], [, b]) => Number(b.savedAt) - Number(a.savedAt))
      .slice(0, 2000);
    await chrome.storage.local.set({
      [REDIRECT_CACHE_KEY]: Object.fromEntries(entries),
    });
  } catch (_) {
    // The in-memory cache remains useful if storage is unavailable.
  }
  return { redirects, cardLike };
}

function isResolvableArticleLink(wikiPage) {
  return !/^(file|category|special|template|help|mediawiki|user|talk|portal):/i.test(wikiPage);
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function getLinkedWikiPage(link) {
  const title = link.getAttribute('title');
  if (title) return normalizeWikiPage(title.split('#')[0]);
  try {
    const url = new URL(link.href, location.origin);
    return normalizeWikiPage(url.pathname.replace(/^\/w\//, '').split('#')[0]);
  } catch (_) {
    return null;
  }
}

function getOwnedEntries(album) {
  return (album?.cardEntries || []).map((raw) => {
    const kind = normalizeKind(raw.kind);
    const id = Number(raw.id);
    return {
      key: Number.isFinite(id) ? `${kind}:${id}` : `name:${normalizeName(raw.cardName || raw.name)}`,
      copies: raw.variants || [],
    };
  });
}

function countCopies(entry) {
  return Math.max(1, entry?.copies?.length || 0);
}

function countFoils(entry) {
  return (entry?.copies || []).filter((copy) => copy.foil === true).length;
}

function normalizeKind(kind) {
  const value = String(kind || '').toLowerCase();
  return value === 'items' ? 'item' : value === 'npcs' ? 'npc' : value || 'item';
}

function normalizeWikiPage(value) {
  let text = String(value || '').trim();
  try {
    text = decodeURIComponent(text);
  } catch (_) {
    // Keep the original title if it contains a malformed escape.
  }
  return text.replaceAll('_', ' ').replace(/\s+/g, ' ').toLowerCase();
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
