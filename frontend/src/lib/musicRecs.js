// Song recommendations for Better Spotify, grouped by genre.
//
// Spotify has no listening-history or recommendations API for songs, so:
//   1. "Played in the last 3 months" = recently played (last 50 plays) + top
//      tracks (short_term ≈ last 4 weeks) + liked songs added in the window.
//   2. Each artist's Spotify genres (or Apple's iTunes genre as a fallback) are
//      folded into broad buckets; children's music is dropped entirely.
//   3. For each top bucket, Spotify track search with `genre:"…"` over the
//      bucket's most common micro-genres finds songs by artists you haven't played.
import { spGet } from './spotify';

const HISTORY_DAYS = 90;
const MAX_GENRES = 6;
const SONGS_PER_GENRE = 8;
const MICRO_GENRES_PER_BUCKET = 3;
const ITUNES_LOOKUPS = 20;            // iTunes allows ~20 requests/minute
const ITUNES_CACHE_KEY = 'bs_itunes_genre_v1';
const MAX_LIBRARY = 5000;             // liked songs checked for "already have it"
// Saved between runs to keep request counts (and Spotify 429s) down.
const LIBRARY_CACHE_KEY = 'bs_liked_v1';
const LIBRARY_TTL = 7 * 86_400_000;    // full re-read weekly (catches un-likes)
const GENRE_CACHE_KEY = 'bs_artist_genres_v1';
const GENRE_TTL = 30 * 86_400_000;

// Order matters: each genre string goes to the first bucket that matches it.
const BUCKETS = [
  ['Kids', /child|kid|toddler|lullab|nursery|kinder|preschool/i],
  ['Hip-Hop & Rap', /hip ?hop|rap|trap|drill|grime|boom bap/i],
  ['R&B & Soul', /r&b|rnb|soul|funk|motown|quiet storm/i],
  ['Metal', /metal|djent|deathcore/i],
  ['Punk & Emo', /punk|emo|hardcore|screamo/i],
  ['Country', /country|americana|bluegrass|honky/i],
  ['Latin', /latin|reggaeton|salsa|bachata|cumbia|corrido|mexican|urbano|sertanejo|mpb/i],
  ['K-Pop & J-Pop', /k-pop|j-pop|j-rock|anime|korean|japanese|c-pop|mandopop/i],
  ['Jazz', /jazz|bossa|swing|bebop/i],
  ['Classical & Soundtrack', /classical|orchestr|soundtrack|score|baroque|opera|compositional|neoclassical|piano/i],
  ['Reggae', /reggae|dancehall|ska|dub\b/i],
  ['Blues', /blues/i],
  ['Christian & Gospel', /christian|gospel|worship|ccm/i],
  ['Folk & Singer-Songwriter', /folk|singer|songwriter|acoustic/i],
  ['Electronic & Dance', /electro|house|techno|edm|trance|dubstep|drum and bass|dnb|garage|ambient|downtempo|synth|^dance$|breakbeat|idm|chillwave/i],
  ['Indie & Alternative', /indie|alt|shoegaze|dream pop|bedroom|lo-fi|new wave|post-/i],
  ['Rock', /rock|grunge|britpop/i],
  ['Pop', /pop/i],
];
const KIDS = 'Kids';

// Searched when a bucket has no Spotify micro-genres (iTunes-only genres).
const BUCKET_QUERIES = {
  'Hip-Hop & Rap': ['hip hop', 'rap'], 'R&B & Soul': ['r&b', 'soul'], Metal: ['metal'],
  'Punk & Emo': ['punk', 'emo'], Country: ['country'], Latin: ['latin', 'reggaeton'],
  'K-Pop & J-Pop': ['k-pop', 'j-pop'], Jazz: ['jazz'], 'Classical & Soundtrack': ['classical', 'soundtrack'],
  Reggae: ['reggae'], Blues: ['blues'], 'Christian & Gospel': ['worship', 'gospel'],
  'Folk & Singer-Songwriter': ['folk', 'singer-songwriter'], 'Electronic & Dance': ['electronic', 'house'],
  'Indie & Alternative': ['indie', 'alternative'], Rock: ['rock'], Pop: ['pop'],
};

// Kids' content that slips past genre tags (names are checked on track, artist and album).
const KIDS_NAMES = /baby shark|nursery rhyme|lullab|cocomelon|pinkfong|super simple songs|little baby bum|sesame street|the wiggles|raffi|disney junior|paw patrol|bluey|mother goose|kiboomers|blippi|ms\.? rachel|songs for (kids|children|toddlers)|(kids|children'?s|toddler) songs|for (kids|toddlers|children)\b|preschool|wheels on the bus|twinkle,? twinkle/i;

function bucketOf(genre) {
  return BUCKETS.find(([, re]) => re.test(genre))?.[0] || null;
}

// An artist's bucket is the one most of its genres fall into (ties → BUCKETS order).
function artistBucket(genres) {
  const votes = new Map();
  for (const g of genres) {
    const b = bucketOf(g);
    if (b === KIDS) return KIDS;
    if (b) votes.set(b, (votes.get(b) || 0) + 1);
  }
  let best = null;
  for (const [name] of BUCKETS) {
    if ((votes.get(name) || 0) > (votes.get(best) || 0)) best = name;
  }
  return best;
}

// "Same song" key per credited artist: title without "(feat. …)", "[Live]",
// " - Remastered 2011" etc., so album/single/remaster versions all match.
export function songKeys(t) {
  const norm = x => (x || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[([].*?[)\]]/g, ' ').replace(/\s+-\s+.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const title = norm(t.name);
  return (t.artists || []).map(a => `${title}|${norm(a.name)}`);
}

function isKidsTrack(t) {
  return [t.name, t.album?.name, ...(t.artists || []).map(a => a.name)].some(n => n && KIDS_NAMES.test(n));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Listening history ───────────────────────────────────────────────────────

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

// Only the fields recommendations use, so the saved library stays small.
const compactLiked = i => ({
  added_at: i.added_at,
  track: {
    id: i.track.id, name: i.track.name, type: i.track.type,
    artists: (i.track.artists || []).map(a => ({ id: a.id, name: a.name })),
    album: { name: i.track.album?.name },
  },
});

// Every liked song (newest first), capped at MAX_LIBRARY. Uses the saved copy
// plus the first page when only new likes were added (1 request instead of ~100).
async function loadLibrary(token, debug) {
  const first = await spGet('/me/tracks?limit=50', token);
  const firstItems = (first.items || []).filter(i => i.track);
  const cached = readJson(LIBRARY_CACHE_KEY, null);
  if (cached && Date.now() - cached.at < LIBRARY_TTL) {
    const k = cached.items.length ? firstItems.findIndex(i => i.track.id === cached.items[0].track.id) : -1;
    if (k >= 0 && first.total === cached.total + k) {
      const items = [...firstItems.slice(0, k).map(compactLiked), ...cached.items];
      if (k) writeJson(LIBRARY_CACHE_KEY, { ...cached, total: first.total, items });
      debug.libraryRequests = 1;
      return items;
    }
  }
  const offsets = [];
  for (let o = 50; o < Math.min(first.total || 0, MAX_LIBRARY); o += 50) offsets.push(o);
  const pages = await mapLimit(offsets, 3, o => spGet(`/me/tracks?limit=50&offset=${o}`, token));
  const items = [first, ...pages].flatMap(p => p?.items || []).filter(i => i.track).map(compactLiked);
  if (!pages.includes(null)) writeJson(LIBRARY_CACHE_KEY, { at: Date.now(), total: first.total, items });
  debug.libraryRequests = 1 + offsets.length;
  return items;
}

async function loadHistory(token, library, errors) {
  const cutoff = Date.now() - HISTORY_DAYS * 86_400_000;
  const plays = new Map();   // track id → { track, weight }
  const add = (track, weight) => {
    if (!track?.id || track.type !== 'track') return;
    const cur = plays.get(track.id);
    if (cur) cur.weight += weight; else plays.set(track.id, { track, weight });
  };
  const safe = (label, p) => p.catch(e => { errors.push(`${label}: ${e.status || ''} ${e.message}`); return null; });

  const [recent, top] = await Promise.all([
    safe('recently played', spGet('/me/player/recently-played?limit=50', token)),
    safe('top tracks', spGet('/me/top/tracks?time_range=short_term&limit=50', token)),
  ]);

  (recent?.items || []).forEach(i => { if (new Date(i.played_at).getTime() >= cutoff) add(i.track, 1); });
  (top?.items || []).forEach((t, i) => add(t, 3 + (50 - i) / 25));   // higher rank → more weight
  library.forEach(i => { if (new Date(i.added_at).getTime() >= cutoff) add(i.track, 1); });
  return [...plays.values()];
}

// ─── Genres ──────────────────────────────────────────────────────────────────

function readItunesCache() {
  try { return JSON.parse(localStorage.getItem(ITUNES_CACHE_KEY) || '{}'); } catch { return {}; }
}

async function itunesGenre(name) {
  const res = await fetch(`https://itunes.apple.com/search?${new URLSearchParams({ term: name, entity: 'musicArtist', limit: '5' })}`);
  if (!res.ok) { const e = new Error(`iTunes ${res.status}`); e.status = res.status; throw e; }
  const { results = [] } = await res.json();
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = results.find(r => norm(r.artistName) === norm(name)) || results[0];
  return hit?.primaryGenreName || '';
}

// Returns Map(artist id → { name, genres: string[], bucket }).
async function loadArtistGenres(token, artists, debug) {
  const info = new Map();
  const saved = readJson(GENRE_CACHE_KEY, {});
  const stale = a => !saved[a.id] || Date.now() - saved[a.id].at > GENRE_TTL;
  const toFetch = artists.filter(stale);
  debug.artistRequests = toFetch.length;
  await mapLimit(toFetch, 3, async a => {
    try {
      const full = await spGet(`/artists/${a.id}`, token);
      saved[a.id] = { g: full.genres || [], at: Date.now() };
    } catch (e) {
      debug.errors.push(`artist ${a.name}: ${e.status || ''} ${e.message}`);
    }
  });
  writeJson(GENRE_CACHE_KEY, saved);
  for (const a of artists) info.set(a.id, { name: a.name, genres: [...(saved[a.id]?.g || [])] });

  // Fall back to iTunes for artists Spotify has no genres for, most-played first.
  const cache = readItunesCache();
  const missing = artists.filter(a => !info.get(a.id).genres.length);
  let lookups = 0;
  for (const a of missing) {
    if (!(a.name in cache)) {
      if (lookups >= ITUNES_LOOKUPS) continue;
      lookups++;
      try { cache[a.name] = await itunesGenre(a.name); }
      catch (e) { debug.errors.push(`iTunes: ${e.message}`); break; }
    }
    if (cache[a.name]) { info.get(a.id).genres = [cache[a.name]]; info.get(a.id).itunes = true; }
  }
  try { localStorage.setItem(ITUNES_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
  debug.itunesLookups = lookups;

  for (const v of info.values()) v.bucket = artistBucket(v.genres);
  return info;
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function searchTracks(token, q, offset, debug) {
  debug.queries.push(q);
  const params = new URLSearchParams({ q, type: 'track', limit: '10', offset: String(offset), market: 'from_token' });
  try {
    const data = await spGet(`/search?${params}`, token);
    return (data.tracks?.items || []).filter(Boolean);
  } catch (e) {
    debug.errors.push(`search "${q}": ${e.status || ''} ${e.message}`);
    return [];
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

// `dismissed`: { ids: [], keys: [] } of songs the user X'd — never recommended again.
export async function recommendSongs({ token, onProgress, dismissed = { ids: [], keys: [] } }) {
  const debug = { errors: [], queries: [] };

  onProgress?.('Reading your liked songs and listening history…');
  const library = await loadLibrary(token, debug).catch(e => { debug.errors.push(`liked songs: ${e.status || ''} ${e.message}`); return []; });
  debug.likedSongs = library.length;
  const history = (await loadHistory(token, library, debug.errors)).filter(p => !isKidsTrack(p.track));
  debug.historyTracks = history.length;
  if (!history.length) return { sections: [], debug };

  // Artist weights (a track's weight is split across its credited artists).
  const artistWeight = new Map();
  for (const { track, weight } of history) {
    for (const a of track.artists || []) {
      if (!a.id) continue;
      const cur = artistWeight.get(a.id) || { id: a.id, name: a.name, weight: 0 };
      cur.weight += weight / track.artists.length;
      artistWeight.set(a.id, cur);
    }
  }
  const artists = [...artistWeight.values()].sort((a, b) => b.weight - a.weight);
  debug.artists = artists.length;

  onProgress?.(`Looking up genres for ${artists.length} artists…`);
  const info = await loadArtistGenres(token, artists, debug);
  debug.artistsWithGenres = [...info.values()].filter(v => v.genres.length).length;

  // Kids artists are excluded from everything below, including their tracks' co-artists.
  const kidsArtists = new Set([...info].filter(([, v]) => v.bucket === KIDS).map(([id]) => id));
  const adultHistory = history.filter(p => !(p.track.artists || []).some(a => kidsArtists.has(a.id)));
  debug.kidsTracksDropped = history.length - adultHistory.length;

  // Bucket weights + the micro-genres and artists behind each bucket.
  const buckets = new Map();
  for (const a of artists) {
    const v = info.get(a.id);
    if (!v.bucket || v.bucket === KIDS) continue;
    const b = buckets.get(v.bucket) || { name: v.bucket, weight: 0, artists: [], micro: new Map() };
    b.weight += a.weight;
    b.artists.push(a.name);
    if (!v.itunes) {
      v.genres.filter(g => bucketOf(g) === v.bucket)
        .forEach(g => b.micro.set(g, (b.micro.get(g) || 0) + a.weight));
    }
    buckets.set(v.bucket, b);
  }
  const top = [...buckets.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_GENRES);
  debug.genres = top.map(b => b.name);
  if (!top.length) return { sections: [], debug };

  // Songs never to recommend: anything played or liked (any version), or dismissed.
  const knownTracks = new Set([...history.map(p => p.track.id), ...library.map(i => i.track.id), ...dismissed.ids]);
  const knownSongs = new Set([...history.map(p => p.track), ...library.map(i => i.track)].flatMap(songKeys));
  dismissed.keys.forEach(k => knownSongs.add(k));
  const knownArtists = new Set(artists.map(a => a.id));

  onProgress?.(`Searching ${top.map(b => b.name).join(', ')}…`);
  const thisYear = new Date().getFullYear();
  const queryPlan = top.flatMap(b => {
    const micro = [...b.micro].sort((x, y) => y[1] - x[1]).slice(0, MICRO_GENRES_PER_BUCKET).map(([g]) => g);
    const genres = micro.length ? micro : BUCKET_QUERIES[b.name] || [];
    // Each genre: one recent-years search and one all-time search, at random offsets for variety.
    return genres.flatMap(g => [
      { bucket: b.name, q: `genre:"${g}" year:${thisYear - 2}-${thisYear}`, offset: Math.floor(Math.random() * 5) * 10 },
      { bucket: b.name, q: `genre:"${g}"`, offset: Math.floor(Math.random() * 10) * 10 },
    ]);
  });
  const results = await mapLimit(queryPlan, 3, p => searchTracks(token, p.q, p.offset, debug));
  debug.searchResults = results.reduce((n, r) => n + (r?.length || 0), 0);

  // Candidates per bucket, scored by how many searches surfaced them.
  const perBucket = new Map(top.map(b => [b.name, new Map()]));
  queryPlan.forEach((p, i) => {
    for (const t of results[i] || []) {
      if (knownTracks.has(t.id) || isKidsTrack(t)) continue;
      if ((t.artists || []).some(a => knownArtists.has(a.id) || kidsArtists.has(a.id))) continue;
      if (songKeys(t).some(k => knownSongs.has(k))) continue;
      const m = perBucket.get(p.bucket);
      const cur = m.get(t.id) || { track: t, hits: 0 };
      cur.hits++;
      m.set(t.id, cur);
    }
  });

  // One song per artist across the whole page; a song lands in the first (strongest) bucket that found it.
  const usedArtists = new Set();
  const usedTracks = new Set();
  const usedTitles = new Set();
  const sections = [];
  for (const b of top) {
    const ranked = shuffle([...perBucket.get(b.name).values()]).sort((x, y) => y.hits - x.hits);
    const recs = [];
    for (const { track } of ranked) {
      const artistId = track.artists?.[0]?.id;
      const titleKey = songKeys(track)[0];
      if (usedTracks.has(track.id) || usedArtists.has(artistId) || usedTitles.has(titleKey)) continue;
      usedTracks.add(track.id); usedArtists.add(artistId); usedTitles.add(titleKey);
      recs.push(track);
      if (recs.length >= SONGS_PER_GENRE) break;
    }
    if (recs.length) sections.push({ genre: b.name, basedOn: b.artists.slice(0, 4), recs });
  }
  debug.recommended = sections.reduce((n, s) => n + s.recs.length, 0);
  return { sections, debug };
}
