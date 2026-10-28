# Dave's World

Personal website built with React 19 + Vite, hosted on Firebase (Firestore + Hosting + Cloud Functions).

## Project Structure

```
frontend/
  src/
    pages/           # Page components (one per route)
    components/      # Shared UI: Layout, PageHeader, SearchInput, TagPill, StarRating, AdminGate, EmptyState
    hooks/           # useAuth.js (returns {user, loading, isAdmin})
    lib/             # firebase.js, fuzzySearch.js (Fuse.js wrapper)
    data/            # projects.json, cookbooks-index.json
    index.css        # CSS custom properties (theme)
    App.jsx          # Router setup (BrowserRouter + Layout wrapper)
functions/           # Python Cloud Functions (recipe scraper)
firestore.rules      # Firestore security rules
```

## Pages

| Route | File | Description |
|---|---|---|
| `/` | Home.jsx | Landing page with project cards |
| `/recipes` | Cookbooks.jsx | Recipe/cookbook browser, recipe search, web recipe import |
| `/recommendations` | Recommendations.jsx | Curated recommendations with map + admin CRUD |
| `/weather` | Weather.jsx | Ensemble forecast with uncertainty viz, plus History tab (`components/WeatherHistory.jsx`: past month/year temp and precipitation vs 1991-2020 normals); `/weather-forecast` redirects here |
| `/movie-finder` | MovieFinder.jsx | Movie discovery by mood/taste with streaming availability |
| `/trail-poster` | TrailPoster.jsx | Trail poster maker with MapLibre GL, contour lines, export |
| `/book-finder` | BookFinder.jsx | Book recommendations from seed books via Google Books API |
| `/sp500-pe` | SP500PE.jsx | Historical S&P 500 P/E, CAPE, and earnings growth charts |
| `/events` | Events.jsx | Metro Vancouver events browser: search, map, calendar |
| `/mortgage-calculator` | MortgageCalculator.jsx | Customizable mortgage payoff calculator with charts |
| `/city-walk-planner` | CityWalkPlanner.jsx | Optimized walking route planner with Google Maps export |
| `/price-tracker` | PriceTracker.jsx | Tracks product/category prices across retailers, emails on price drops |
| `/better-spotify` | BetterSpotify.jsx | Spotify podcasts: continue listening, latest episodes (14 days), followed shows by latest release, embedding-based recommendations; Music tab: song recs grouped by genre from last-3-months listening (kids' music excluded) and the Playlist sub-tab (20 auto-picked new songs: unheard songs by your most-listened artists plus a few new artists, `buildPlaylist` in `lib/musicRecs.js`; `/playlist-generator` redirects there); hearts save/remove songs in your Spotify Liked Songs; episode rows show a one-line description preview with Show more; in-page player with play queue (`lib/useSpotifyWebPlayer.js`); podcast episodes play from the show's public RSS feed when found (`lib/podcastFeed.js`), with playback speed and lock-screen controls, else through Spotify |
| `/city-walk-planner` | CityWalkPlanner.jsx | Optimized walking/transit route builder with Google Maps export |
| `/sites-and-bites` | SitesAndBites.jsx | Curated must-see guide per destination (eat/drink/cafes/museums/attractions/outdoors) with area overview and area-coloured Leaflet map; admin generates via Claude (areas, then parallel per-category calls, verified with Places and streamed live into Firestore), everyone can view; Must-see needs Claude's pick plus high Google rating, Kid-friendly filter |

## Design System

- **Colors**: `--color-bg: #faf8f5`, `--color-accent: #c0622f`, `--color-surface: #ffffff`, `--color-border: #e8e2da`, `--color-text: #1a1a1a`, `--color-text-muted: #6b6b6b`
- **Fonts**: Playfair Display (headings), DM Sans (body)
- **Card pattern**: white background, 1px border, 4px accent left border, 10-12px border-radius, hover lift + shadow
- **Styling**: Inline styles with CSS custom properties. Tailwind is installed but not heavily used.

## Environment Variables (`frontend/.env.local`)

- `VITE_FIREBASE_*` — Firebase config
- `VITE_SPOTIFY_CLIENT_ID` — default Spotify app in `lib/spotify.js` (was used by the Playlist Generator page; no page uses it now)
- `VITE_SPOTIFY_BETTER_CLIENT_ID` — separate Spotify app ("music-box") for Better Spotify; its redirect URIs are registered there
- `VITE_GOOGLE_MAPS_API_KEY` — Google Places autocomplete
- `VITE_ADMIN_UID` — Firebase UID for admin-only features
- `VITE_TMDB_API_KEY` — TMDB API key for movie discovery
- `VITE_MAPTILER_API_KEY` — MapTiler API key for contour tiles (Trail Poster)
- `VITE_GOOGLE_BOOKS_API_KEY` — Google Books API key for Book Finder

## Environment Variables (`functions/.env`, server-side only)

- `GOOGLE_MAPS_API_KEY` — used by the Places/Geocoding/Routes proxies
- `SCRAPERAPI_KEY` — routes price-tracker fetches through ScraperAPI for retailers that block direct requests (MEC, Canadian Tire, Amazon.ca, SportChek, Atmosphere, Walmart.ca)
- `RESEND_API_KEY`, `PRICE_ALERT_FROM`, `PRICE_ALERT_TO` — price-drop email delivery via Resend
- `ANTHROPIC_API_KEY` — Claude API for Sites and Bites guide generation (`generate_destination`); optional `SITES_BITES_MODEL` overrides the model
- `TAVILY_API_KEY` — web search for the Price Tracker's "Find retailer pages" button
- `PODCAST_PROXY_SECRET` — signs `podcast_audio_proxy` links (Better Spotify feed player); any random string

## External Services

- **Firebase**: Firestore (recommendations, website_recipes), Hosting, Cloud Functions
- **Spotify**: PKCE OAuth (shared in `lib/spotify.js`; tokens stored per client ID; each page's URL must be a registered redirect URI on its Spotify app), Web API (search, artists, `/me/shows`, `/shows/{id}/episodes`, player), Web Playback SDK (requires Premium; not on iOS), iFrame embed API (Better Spotify fallback player)
- **Google Places API**: Address autocomplete in Recommendations
- **Open-Meteo**: Ensemble forecast API plus the archive API (history and 1991-2020 normals; no auth needed)
- **Leaflet/OpenStreetMap**: Map display in Recommendations
- **TMDB**: Movie database API (discover, recommendations, watch providers)
- **MapLibre GL + OpenFreeMap**: Vector tile map rendering for Trail Poster (no API key needed)
- **MapTiler**: Contour tile source for elevation lines in Trail Poster (free tier, requires API key)
- **Google Books API**: Search and volume lookups for Book Finder
- **iTunes Search API**: No-key, CORS-enabled artist genre fallback for Better Spotify song recs when Spotify returns no artist genres (~20 req/min; cached in localStorage); also used server-side to find podcast RSS feeds
- **Podcast RSS feeds**: Better Spotify's feed player. Cloud Function `podcast_episode_audio` finds the show's feed (iTunes) and matches the episode (title, or date + length) to its audio URL; `podcast_audio_proxy` streams audio that is only served over http (e.g. the BBC) via signed links (`PODCAST_PROXY_SECRET` in `functions/.env`)
- **Hugging Face (transformers.js)**: `Xenova/all-MiniLM-L6-v2` sentence embeddings run in-browser in a Web Worker (`lib/embedWorker.js`) for Better Spotify podcast recommendations; model downloaded from the HF hub on first use, no key
- **multpl.com**: Scraped server-side (BeautifulSoup, Cloud Function `fetch_pe_data`) for S&P 500 P/E and CAPE data
- **Metro Vancouver municipal/tourism event sources**: Scraped server-side (`.ics` feeds, "The Events Calendar" REST API, JSON-LD, Port Moody "Events at a Glance" page, Port Coquitlam Drupal calendar view, Destination Vancouver's public Sanity CMS query) for Events — Coquitlam, Port Moody (calendar + signature events), Port Coquitlam, Tourism Coquitlam, Destination Vancouver, Metro Vancouver Regional Parks, Tourism Burnaby, New Westminster
- **Google Geocoding API**: Server-side geocoding of event addresses without lat/lng (Events)
- **ScraperAPI**: Proxy for scraping retailer pages that block direct server-side requests (Price Tracker)
- **Resend**: Transactional email API for price-drop alerts (Price Tracker)
- **Tavily**: Web search API for the Price Tracker's retailer-discovery button (Google Custom Search is closed to new signups; Brave dropped its no-card free tier)
- **Google Routes API**: Server-side walking/transit directions with waypoint optimization (`walk_directions` Cloud Function, City Walk Planner) — must be enabled both as a GCP project API and in the Maps API key's own API restrictions
- **Claude API**: Sites and Bites guide generation (`generate_destination`, streamed JSON Lines)
- **Places API (New) Text Search**: verifies and geolocates Sites and Bites places (Enterprise tier fields)
- **Places API (New) Nearby Search**: Server-side POI discovery by category (`nearby_places` Cloud Function, City Walk Planner)

## Commands

```bash
cd frontend && npm run dev      # Dev server (127.0.0.1:5173)
cd frontend && npm run build    # Production build
firebase deploy                 # Deploy everything (from project root)
firebase deploy --only hosting  # Deploy just the frontend
firebase deploy --only firestore:rules  # Deploy security rules
```

## Spotify Dev Mode Limitations

The Spotify app is in Development Mode, which means:
- Search API `limit` capped at 10 per request
- `/artists/{id}/related-artists` returns 403
- `/artists/{id}/top-tracks` returns 403
- Workaround: search-based discovery with multiple query strategies and random offsets

## Git Hooks

Lob work hooks at `~/Lob/git-hooks/` require `/dev/tty` and block non-interactive commits/pushes. Bypass with:
```bash
git -c core.hooksPath=/dev/null commit -m "message"
git -c core.hooksPath=/dev/null push
```

## Pre-Commit Instructions

Before committing changes to GitHub, **always update the project reference files** in the Claude memory directory (`~/.claude/projects/-Users-davidcurie-Projects/memory/`):

1. **Update `pages-reference.md`** if any page was modified — reflect the current state of the code, not what it used to be.
2. **Create new reference files** if a new page or major feature was added.
3. **Update `MEMORY.md`** if project structure, env vars, commands, or conventions changed.
4. **Update this `CLAUDE.md`** file if routes, services, or project-level details changed.

These files are used for context in future sessions. Keep them accurate and concise.
