# OSRS TCG Wiki Tracker

Chrome extension that shows your public OSRS TCG collection status while browsing the Old School RuneScape Wiki.

It adds status badges to item and NPC pages, and annotates matching links on quest and guide pages. Card-backed statuses link to the matching card search in your OSRS TCG collection.

## Install in Chrome

This project is currently distributed as an unpacked extension rather than through the Chrome Web Store.

### Download

Either clone this repository:

```bash
git clone https://github.com/gfxhlab/osrs-tcg-wiki-tracker.git
```

Or use **Code → Download ZIP** on GitHub and extract the ZIP.

### Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the downloaded or cloned repository directory—the folder containing `manifest.json`.
5. Open the extension popup and enter your public RuneScape username (RSN). It defaults to `FoilsGold`.
6. Open or reload an OSRS Wiki item page, such as `https://oldschool.runescape.wiki/w/Excalibur`.

### Update

To update a cloned installation, pull the latest changes, then open `chrome://extensions` and click the extension's **Reload** button. For a ZIP installation, download and extract the latest version, remove the old unpacked folder, and load the new folder through **Load unpacked**.

## Requirements

- Google Chrome or another Chromium-based browser that supports Manifest V3.
- A public OSRS TCG collection associated with your RSN. No login or private collection access is required.

## Privacy

The extension stores your RSN, refresh preference, and cached public collection/catalog data in the browser's local extension storage. It requests public data from `api.osrs-tcg.net`, reads matching OSRS Wiki pages, and does not send collection data to a separate project server.

## Respectful API usage

The extension is designed to minimize requests to the OSRS TCG API:

- It checks the small player-stats endpoint on a scheduled interval, defaulting to every 15 minutes. Users can choose 20 or 30 minutes instead.
- Browsing between Wiki pages does not fetch the player collection again. Pages use the cached snapshot held by the extension.
- The full player collection is fetched only when the stats response changes or the user changes RSN.
- `ETag`/`If-None-Match` headers allow the API to return `304 Not Modified` when data has not changed, avoiding an unchanged response body.
- The card catalog is cached locally and refreshed at most every 30 minutes.
- Wiki redirect and infobox lookups are cached locally for seven days, so repeated links do not cause repeated Wiki requests.
- The extension uses public read-only endpoints and does not submit, modify, or delete collection data.

## Features

- Shows owned, locked, and no-card statuses on supported Wiki pages.
- Shows copies, foil/non-foil finish, and variant information when available.
- Annotates matching item and NPC links inside quests and guides.
- Refreshes public collection data every 15, 20, or 30 minutes; the default is 15 minutes.
- Caches unchanged API responses and Wiki redirect lookups to reduce requests.

## Data flow

- Player stats: `GET https://api.osrs-tcg.net/api/v1/players/{rsn}/stats`
- Player collection: `GET https://api.osrs-tcg.net/api/v1/players/{rsn}`
- Catalog: `GET https://api.osrs-tcg.net/api/v1/catalog/cards/live`
- The small stats response is checked on a timer and when **Refresh now** is pressed.
- Automatic refresh defaults to every 15 minutes; available intervals are 15, 20, and 30 minutes.
- The full collection is downloaded only when the stats change.
- `ETag`/`If-None-Match` avoids downloading unchanged stats.
- Wiki redirect resolutions are cached for seven days, including non-redirect results, and capped at 2,000 entries.
- Clicking a card-backed page status opens the player's collection and fills its client-side card search; variants search by their variant name.
- API requests run in the extension service worker, not in the Wiki page.

## Current scope

The prototype decorates individual item/NPC pages and annotates matching links inside Wiki article content, including quest and guide pages. It matches Wiki page names, unambiguous catalog display-name aliases, and API-provided card variants, uses `(kind, id)` to distinguish items from NPCs with the same name, and batch-resolves Wiki redirects and item/NPC/monster infoboxes through MediaWiki so aliases such as pluralized item names and no-card NPCs work too.
