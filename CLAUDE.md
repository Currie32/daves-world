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
| `/cookbooks` | Cookbooks.jsx | Cookbook browser, recipe search, web recipe import |
| `/playlist-generator` | PlaylistGenerator.jsx | Spotify music discovery with playback + feedback |
| `/recommendations` | Recommendations.jsx | Curated recommendations with map + admin CRUD |
| `/weather-forecast` | WeatherForecast.jsx | Ensemble weather forecast with uncertainty viz |
| `/movie-finder` | MovieFinder.jsx | Movie discovery by mood/taste with streaming availability |
| `/trail-poster` | TrailPoster.jsx | Trail poster maker with MapLibre GL, contour lines, export |
| `/book-finder` | BookFinder.jsx | Book recommendations from seed books via Google Books API |
| `/sp500-pe` | SP500PE.jsx | Historical S&P 500 P/E, CAPE, and earnings growth charts |
| `/events` | Events.jsx | Metro Vancouver events browser: search, map, calendar |
| `/mortgage-calculator` | MortgageCalculator.jsx | Customizable mortgage payoff calculator with charts |
| `/better-spotify` | BetterSpotify.jsx | Spotify podcasts: latest episodes (14 days), followed shows by latest release, embedding-based recommendations; Music tab placeholder |

## Design System

- **Colors**: `--color-bg: #faf8f5`, `--color-accent: #c0622f`, `--color-surface: #ffffff`, `--color-border: #e8e2da`, `--color-text: #1a1a1a`, `--color-text-muted: #6b6b6b`
- **Fonts**: Playfair Display (headings), DM Sans (body)
- **Card pattern**: white background, 1px border, 4px accent left border, 10-12px border-radius, hover lift + shadow
- **Styling**: Inline styles with CSS custom properties. Tailwind is installed but not heavily used.

## Environment Variables (`frontend/.env.local`)

- `VITE_FIREBASE_*` — Firebase config
- `VITE_SPOTIFY_CLIENT_ID` — Spotify PKCE auth (Playlist Generator)
- `VITE_SPOTIFY_BETTER_CLIENT_ID` — separate Spotify app ("music-box") for Better Spotify; its redirect URIs are registered there
- `VITE_GOOGLE_MAPS_API_KEY` — Google Places autocomplete
- `VITE_ADMIN_UID` — Firebase UID for admin-only features
- `VITE_TMDB_API_KEY` — TMDB API key for movie discovery
- `VITE_MAPTILER_API_KEY` — MapTiler API key for contour tiles (Trail Poster)
- `VITE_GOOGLE_BOOKS_API_KEY` — Google Books API key for Book Finder

## External Services

- **Firebase**: Firestore (recommendations, website_recipes), Hosting, Cloud Functions
- **Spotify**: PKCE OAuth (shared in `lib/spotify.js`; tokens stored per client ID; each page's URL must be a registered redirect URI on its Spotify app), Web API (search, artists, `/me/shows`, `/shows/{id}/episodes`, player), Web Playback SDK (requires Premium)
- **Google Places API**: Address autocomplete in Recommendations
- **Open-Meteo**: Ensemble weather forecast API (no auth needed)
- **Leaflet/OpenStreetMap**: Map display in Recommendations
- **TMDB**: Movie database API (discover, recommendations, watch providers)
- **MapLibre GL + OpenFreeMap**: Vector tile map rendering for Trail Poster (no API key needed)
- **MapTiler**: Contour tile source for elevation lines in Trail Poster (free tier, requires API key)
- **Google Books API**: Search and volume lookups for Book Finder
- **Hugging Face (transformers.js)**: `Xenova/all-MiniLM-L6-v2` sentence embeddings run in-browser in a Web Worker (`lib/embedWorker.js`) for Better Spotify podcast recommendations; model downloaded from the HF hub on first use, no key
- **multpl.com**: Scraped server-side (BeautifulSoup, Cloud Function `fetch_pe_data`) for S&P 500 P/E and CAPE data
- **Metro Vancouver municipal/tourism event sources**: Scraped server-side (`.ics` feeds, "The Events Calendar" REST API, JSON-LD) for Events — Coquitlam, Port Moody, Port Coquitlam, Tourism Coquitlam, Destination Vancouver, Metro Vancouver Regional Parks, Tourism Burnaby, New Westminster
- **Google Geocoding API**: Server-side geocoding of event addresses without lat/lng (Events)

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
