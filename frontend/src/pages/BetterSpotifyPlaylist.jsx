// Playlist tab of Better Spotify (formerly the standalone Playlist Generator page):
// generates a playlist from seed artists/genres + mood and plays it in the page's player.
import { useState, useEffect, useRef, useCallback } from 'react';
import { spGet } from '../lib/spotify';

// ─── Spotify API ─────────────────────────────────────────────────────────────

async function searchArtists(q, token) {
  if (!q.trim()) return [];
  const data = await spGet(`/search?type=artist&limit=6&q=${encodeURIComponent(q)}`, token);
  return data.artists?.items || [];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Feedback persistence ────────────────────────────────────────────────────

const FEEDBACK_KEY = 'sp_feedback';

function loadFeedback() {
  try {
    return JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '{}');
  } catch { return {}; }
}

function saveFeedback(fb) {
  localStorage.setItem(FEEDBACK_KEY, JSON.stringify(fb));
}

// fb shape: { [trackId]: { v: 1|-1, artist: "Name", artistId: "id" } }
function setTrackFeedback(trackId, value, artistName, artistId) {
  const fb = loadFeedback();
  if (value === 0) {
    delete fb[trackId];
  } else {
    fb[trackId] = { v: value, artist: artistName, artistId };
  }
  saveFeedback(fb);
  return fb;
}

function getFeedbackStats() {
  const fb = loadFeedback();
  // Count likes/dislikes per artist
  const artistScores = new Map(); // artistId → net score
  const dislikedTrackIds = new Set();
  for (const [trackId, { v, artistId }] of Object.entries(fb)) {
    if (v === -1) dislikedTrackIds.add(trackId);
    const current = artistScores.get(artistId) || 0;
    artistScores.set(artistId, current + v);
  }
  return { artistScores, dislikedTrackIds };
}

// ─── Concurrency utility ─────────────────────────────────────────────────────

async function batchedAll(tasks, concurrency = 5) {
  const results = [];
  let i = 0;
  while (i < tasks.length) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn => fn()));
    results.push(...batchResults);
    i += concurrency;
  }
  return results;
}

// ─── Track gathering (weighted scoring) ──────────────────────────────────────

const MOOD_KEYWORDS = {
  energetic: 'upbeat energetic',
  chill: 'chill ambient relaxing',
  melancholic: 'sad melancholic emotional',
  focused: 'instrumental focus study',
  romantic: 'romantic love',
  angry: 'angry aggressive intense',
  happy: 'happy uplifting feel good',
  dark: 'dark brooding atmospheric',
  dreamy: 'dreamy ethereal hazy',
  groovy: 'groovy funky rhythmic',
};

const KIDS_PATTERNS = /\b(nursery|lullab|toddler|kindergarten|kids\s?song|children'?s|baby\s?shark|cocomelon|little\s?baby|kidz\s?bop)\b/i;

function isKidsContent(track) {
  const title = track.name || '';
  const album = track.album?.name || '';
  const artists = (track.artists || []).map(a => a.name).join(' ');
  const text = `${title} ${album} ${artists}`;
  return KIDS_PATTERNS.test(text);
}

async function gatherTracks({ seedArtists, genres, mood, discovery, count, token, onProgress }) {
  // trackId → { track, score, sources: Set<source> }
  const pool = new Map();
  // Exclude seed artists' own tracks — we want new music
  const excludedArtistIds = new Set(seedArtists.map(a => a.id));
  const errors = [];

  // Discovery slider controls how many search variations we run per seed
  // Familiar (0): 2 searches, Adventurous (100): 6 searches
  const searchDepth = Math.round(2 + (discovery / 100) * 4);

  function isExcludedArtist(track) {
    return (track.artists || []).some(a => excludedArtistIds.has(a.id));
  }

  // Apply feedback: exclude disliked tracks, boost/penalize by artist history
  const { artistScores: fbArtistScores, dislikedTrackIds } = getFeedbackStats();

  function addToPool(track, score, source, provenance) {
    if (!track?.id || !track?.uri) return;
    if (isExcludedArtist(track)) return;
    if (isKidsContent(track)) return;
    if (dislikedTrackIds.has(track.id)) return;
    // Adjust score based on artist feedback history
    const primaryArtistId = track.artists?.[0]?.id;
    if (primaryArtistId && fbArtistScores.has(primaryArtistId)) {
      const net = fbArtistScores.get(primaryArtistId);
      score *= Math.max(0.1, 1 + net * 0.2); // likes boost, dislikes penalize
    }
    if (pool.has(track.id)) {
      const entry = pool.get(track.id);
      entry.score += score;
      entry.sources.add(source);
    } else {
      pool.set(track.id, { track, score, provenance, sources: new Set([source]) });
    }
  }

  async function searchAndAdd(query, score, source, provenance) {
    // Use random offsets to sample different parts of the result set each time
    const startOffset = Math.floor(Math.random() * 50) * 10; // 0–490 in steps of 10
    for (let i = 0; i < 3; i++) {
      const offset = startOffset + i * 10;
      try {
        const data = await spGet(`/search?q=${encodeURIComponent(query)}&type=track&limit=10&offset=${offset}`, token);
        const items = data.tracks?.items || [];
        items.forEach(t => addToPool(t, score - i * 0.01, source, provenance));
        if (items.length < 10) break;
      } catch { break; }
    }
  }

  // Search variation strategies for artist-based discovery
  // Each adds a different angle to find music *like* the seed artist
  const artistSearchStrategies = [
    (name) => ({ q: `artist:${name}`, prov: `fans of ${name}` }),                // co-artist collaborations
    (name) => ({ q: `${name}`, prov: `related to ${name}` }),                     // broad name search finds similar
    (name, mood) => mood ? { q: `${name} ${MOOD_KEYWORDS[mood]}`, prov: `${name} + ${mood}` } : null,
    (name) => ({ q: `${name} similar`, prov: `similar to ${name}` }),
    (name) => ({ q: `${name} fans also like`, prov: `fans of ${name}` }),
    (name) => ({ q: `${name} inspired`, prov: `inspired by ${name}` }),
  ];

  // Phase 1: Artist-based search discovery
  if (seedArtists.length > 0) {
    onProgress?.('Finding music like your artists...');

    // Get seed artists' genres from their Spotify profile to enhance searches
    const artistGenres = new Map();
    const genreFetchTasks = seedArtists.map(seed => async () => {
      try {
        const data = await spGet(`/artists/${seed.id}`, token);
        if (data.genres?.length > 0) artistGenres.set(seed.id, data.genres);
      } catch { /* artist detail fetch is best-effort */ }
    });
    await batchedAll(genreFetchTasks, 5);

    const searchTasks = [];
    for (const seed of seedArtists) {
      // Run searchDepth strategies per artist, randomly picked for variety
      const strategies = shuffle([...artistSearchStrategies]).slice(0, searchDepth);
      for (const strategyFn of strategies) {
        const strategy = strategyFn(seed.name, mood);
        if (!strategy) continue;
        searchTasks.push(() => searchAndAdd(strategy.q, 2, seed.name, strategy.prov));
      }

      // Also search using the artist's own Spotify genres (high-quality signal)
      const seedGenres = artistGenres.get(seed.id) || [];
      for (const g of seedGenres.slice(0, 2)) {
        searchTasks.push(() => searchAndAdd(g, 1.5, seed.name, `${seed.name}'s genre: ${g}`));
      }
    }
    await batchedAll(searchTasks, 5);
  }

  // Phase 2: Genre-based search (multiple varied queries per genre)
  if (genres.length > 0) {
    onProgress?.('Searching genres...');
    const genreModifiers = [
      'new', 'best', 'underground', 'latest', 'classic', 'emerging',
      'essential', 'fresh', 'deep cuts', 'hidden gems', 'rising',
      'overlooked', 'acclaimed', 'vibrant', 'raw', 'authentic',
    ];
    const genreTasks = [];
    for (const genre of genres) {
      // Base genre search
      genreTasks.push(() => searchAndAdd(genre, 1.5, `genre:${genre}`, `genre: ${genre}`));
      // Genre with "genre:" prefix
      genreTasks.push(() => searchAndAdd(`genre:${genre}`, 1.5, `genre:${genre}`, `genre: ${genre}`));
      // Genre + mood
      if (mood && MOOD_KEYWORDS[mood]) {
        genreTasks.push(() => searchAndAdd(`${genre} ${MOOD_KEYWORDS[mood]}`, 1.5, `genre:${genre}`, `genre: ${genre} + ${mood}`));
      }
      // Pick 3 random modifiers for variety each generation
      const picked = shuffle([...genreModifiers]).slice(0, 3);
      for (const mod of picked) {
        genreTasks.push(() => searchAndAdd(`${genre} ${mod}`, 1, `genre:${genre}`, `genre: ${genre}`));
      }
    }
    await batchedAll(genreTasks, 5);
  }

  // Phase 3: Multi-path overlap bonus
  onProgress?.('Scoring tracks...');
  for (const entry of pool.values()) {
    const paths = entry.sources.size;
    if (paths > 1) {
      entry.score *= 1 + 0.3 * (paths - 1);
    }
  }

  // Phase 4: Mood supplementary search (only if not already folded into genre search)
  if (mood && MOOD_KEYWORDS[mood] && genres.length === 0) {
    onProgress?.('Adding mood flavour...');
    await searchAndAdd(MOOD_KEYWORDS[mood], 0.5, '_mood', `mood: ${mood}`);
  }

  // Phase 5: Final selection
  onProgress?.('Picking the best tracks...');
  const entries = [...pool.values()];
  entries.sort((a, b) => b.score - a.score);

  // Diversity cap: max 3 tracks per artist
  const artistCount = new Map();
  const selected = [];
  for (const entry of entries) {
    const primaryArtist = entry.track.artists?.[0]?.name || 'Unknown';
    const currentCount = artistCount.get(primaryArtist) || 0;
    if (currentCount >= 3) continue;
    artistCount.set(primaryArtist, currentCount + 1);
    selected.push(entry);
    if (selected.length >= count * 2) break; // gather extra for tier shuffling
  }

  // Light shuffle within score tiers for variety
  const tierSize = 5;
  const shuffled = [];
  for (let i = 0; i < selected.length; i += tierSize) {
    shuffled.push(...shuffle(selected.slice(i, i + tierSize)));
  }

  console.log(`[playlist-gen] pool: ${pool.size} tracks, errors: ${errors.length}`, errors);

  if (shuffled.length === 0) {
    throw new Error(
      errors.length > 0
        ? `Spotify API errors: ${errors[0]}`
        : 'No tracks found. Try adding more artists or genres.'
    );
  }

  return shuffled.slice(0, count).map(e => ({ ...e.track, _provenance: e.provenance }));
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = {
  // ── Form card ──
  card: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: 16, padding: '32px 28px', marginBottom: 24,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  section: { marginBottom: 24 },
  sectionLast: { marginBottom: 0 },
  label: {
    display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)',
    marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em',
  },
  labelMuted: { color: 'var(--color-text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 },
  sectionDivider: {
    border: 'none', borderTop: '1px solid var(--color-border)', margin: '24px 0',
  },
  // ── Inputs ──
  input: {
    width: '100%', padding: '10px 14px', border: '1px solid var(--color-border)',
    borderRadius: 10, fontSize: 14, fontFamily: 'var(--font-body)',
    background: 'var(--color-bg)', color: 'var(--color-text)', outline: 'none',
    transition: 'border-color 0.15s',
    boxSizing: 'border-box',
  },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.12)', zIndex: 100,
    maxHeight: 260, overflowY: 'auto',
  },
  dropdownItem: (hi) => ({
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
    cursor: 'pointer', background: hi ? 'var(--color-bg)' : 'transparent',
    transition: 'background 0.1s',
  }),
  artistImg: {
    width: 32, height: 32, borderRadius: '50%', objectFit: 'cover',
    background: 'var(--color-border)', flexShrink: 0,
  },
  // ── Chips ──
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    background: 'var(--color-accent)', color: '#fff',
    borderRadius: 100, padding: '5px 14px 5px 14px', fontSize: 12, fontWeight: 500,
  },
  chipRemove: {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
    cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1,
    marginLeft: 2,
  },
  // ── Mood pills ──
  pill: (on) => ({
    padding: '7px 18px', borderRadius: 100, cursor: 'pointer', fontFamily: 'var(--font-body)',
    fontSize: 13, fontWeight: 500, transition: 'all 0.15s',
    border: `1.5px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`,
    background: on ? 'var(--color-accent)' : 'transparent',
    color: on ? '#fff' : 'var(--color-text)',
  }),
  // ── Sliders ──
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 },
  sliderRow: { display: 'flex', alignItems: 'center', gap: 12 },
  slider: { flex: 1, accentColor: 'var(--color-accent)', height: 4 },
  sliderVal: { minWidth: 24, textAlign: 'right', fontSize: 14, fontWeight: 600, color: 'var(--color-text)' },
  sliderLabels: {
    display: 'flex', justifyContent: 'space-between',
    fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4, letterSpacing: '0.02em',
  },
  // ── Generate button ──
  generateBtn: {
    width: '100%', padding: '15px', background: 'var(--color-accent)', color: '#fff',
    border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'var(--font-body)',
    boxShadow: '0 2px 8px rgba(192,98,47,0.25)',
    transition: 'transform 0.1s, box-shadow 0.15s',
  },
  // ── Error ──
  error: {
    color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca',
    borderRadius: 10, padding: '12px 16px', fontSize: 13, marginTop: 16, lineHeight: 1.5,
  },
  // ── Results ──
  result: {
    marginTop: 32, background: 'var(--color-surface)',
    border: '1px solid var(--color-border)', borderRadius: 16,
    overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  resultHeader: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '20px 24px 16px',
  },
  resultTitle: { fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, margin: 0 },
  playAllBtn: {
    marginLeft: 'auto', background: 'var(--color-accent)', color: '#fff', border: 'none',
    borderRadius: 100, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'var(--font-body)',
  },
  trackCount: {
    fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0,
    fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em',
  },
  // ── Track list ──
  trackList: { listStyle: 'none', margin: 0, padding: '4px 0', display: 'flex', flexDirection: 'column', gap: 0 },
  track: (active) => ({
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 24px', cursor: 'pointer',
    background: active ? 'var(--color-bg)' : 'transparent',
    transition: 'background 0.1s',
  }),
  trackNum: {
    width: 24, textAlign: 'right', fontSize: 12, color: 'var(--color-text-muted)',
    flexShrink: 0, fontVariantNumeric: 'tabular-nums',
  },
  trackThumb: {
    width: 44, height: 44, borderRadius: 6, objectFit: 'cover',
    flexShrink: 0, background: 'var(--color-border)',
  },
  trackInfo: { flex: 1, minWidth: 0 },
  trackName: (active) => ({
    fontSize: 14, fontWeight: active ? 600 : 500,
    color: active ? 'var(--color-accent)' : 'var(--color-text)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  }),
  trackArtist: {
    fontSize: 12, color: 'var(--color-text-muted)', marginTop: 1, whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis',
  },
  // ── Feedback ──
  spotifyLink: { color: '#1DB954', opacity: 0.7, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '4px', transition: 'opacity 0.15s' },
  feedbackBtns: { display: 'flex', gap: 2, flexShrink: 0 },
  fbBtn: (active, color) => ({
    background: 'none', border: 'none', cursor: 'pointer',
    padding: '4px 6px', fontSize: 20, fontWeight: 700, lineHeight: 1,
    borderRadius: 6, color: color, opacity: active ? 1 : 0.2,
    transition: 'opacity 0.15s, transform 0.1s',
  }),
  // ── Misc ──
  divider: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '28px 0' },
  progressMsg: {
    textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13,
    marginTop: 16, fontStyle: 'italic',
  },
};

// ─── ArtistSearch ─────────────────────────────────────────────────────────────

function ArtistSearch({ getToken, selected, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [hi, setHi] = useState(-1);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!query.trim()) return; // cleared in onQueryChange
    timer.current = setTimeout(async () => {
      try { const r = await searchArtists(query, await getToken()); setResults(r); setOpen(r.length > 0); setHi(-1); }
      catch { setResults([]); }
    }, 300);
  }, [query, getToken]);

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  function onKey(e) {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, results.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    if (e.key === 'Enter' && hi >= 0) pick(results[hi]);
    if (e.key === 'Escape') setOpen(false);
  }

  function onQueryChange(e) {
    setQuery(e.target.value);
    if (!e.target.value.trim()) { setResults([]); setOpen(false); }
  }

  function pick(a) {
    if (!selected.find(x => x.id === a.id)) onAdd(a);
    setQuery(''); setOpen(false); setResults([]);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input style={s.input} placeholder="Search for artists to add..." value={query}
        onChange={onQueryChange} onKeyDown={onKey}
        onFocus={() => results.length > 0 && setOpen(true)} />
      {open && (
        <div style={s.dropdown}>
          {results.map((a, i) => (
            <div key={a.id} style={s.dropdownItem(i === hi)}
              onMouseDown={() => pick(a)} onMouseEnter={() => setHi(i)}>
              {a.images?.[2]?.url ? <img src={a.images[2].url} alt="" style={s.artistImg} /> : <div style={s.artistImg} />}
              <span style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</span>
            </div>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div style={s.chips}>
          {selected.map(a => (
            <span key={a.id} style={s.chip}>
              {a.name}
              <button style={s.chipRemove} onClick={() => onRemove(a.id)}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── GenreSearch ──────────────────────────────────────────────────────────────

function GenreSearch({ selected, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(-1);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const filtered = query.trim()
    ? GENRES.filter(g => g.includes(query.toLowerCase()) && !selected.includes(g))
    : GENRES.filter(g => !selected.includes(g));

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  function onKey(e) {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, filtered.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    if (e.key === 'Enter' && hi >= 0) pick(filtered[hi]);
    if (e.key === 'Escape') setOpen(false);
  }

  function pick(g) {
    onAdd(g);
    setQuery(''); setOpen(false); setHi(-1);
  }

  function handleChange(e) {
    const v = e.target.value;
    setQuery(v);
    const matches = v.trim()
      ? GENRES.filter(g => g.includes(v.toLowerCase()) && !selected.includes(g))
      : GENRES.filter(g => !selected.includes(g));
    setOpen(matches.length > 0);
    setHi(-1);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input style={s.input} placeholder="Search for genres..." value={query}
        onChange={handleChange} onKeyDown={onKey}
        onFocus={() => filtered.length > 0 && setOpen(true)} />
      {open && filtered.length > 0 && (
        <div style={s.dropdown}>
          {filtered.map((g, i) => (
            <div key={g} style={s.dropdownItem(i === hi)}
              onMouseDown={() => pick(g)} onMouseEnter={() => setHi(i)}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{g}</span>
            </div>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div style={s.chips}>
          {selected.map(g => (
            <span key={g} style={s.chip}>
              {g}
              <button style={s.chipRemove} onClick={() => onRemove(g)}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GENRES = [
  'acoustic', 'afrobeat', 'alt-rock', 'alternative', 'ambient',
  'bluegrass', 'blues', 'bossa nova', 'classical', 'country',
  'dance', 'disco', 'drum and bass', 'dub', 'dubstep',
  'edm', 'electronic', 'emo', 'experimental', 'folk',
  'funk', 'garage', 'gospel', 'goth', 'grunge',
  'hard rock', 'hardcore', 'hip-hop', 'house', 'indie',
  'indie pop', 'industrial', 'j-pop', 'jazz', 'k-pop',
  'latin', 'lo-fi', 'metal', 'new wave', 'opera',
  'pop', 'post-punk', 'progressive rock', 'psychedelic', 'punk',
  'r&b', 'reggae', 'reggaeton', 'rock', 'shoegaze',
  'singer-songwriter', 'ska', 'soul', 'synth-pop', 'techno',
  'trance', 'trap', 'trip-hop', 'world',
];

const MOODS = [
  { label: 'Energetic', value: 'energetic' },
  { label: 'Chill', value: 'chill' },
  { label: 'Happy', value: 'happy' },
  { label: 'Melancholic', value: 'melancholic' },
  { label: 'Focused', value: 'focused' },
  { label: 'Romantic', value: 'romantic' },
  { label: 'Angry', value: 'angry' },
  { label: 'Dark', value: 'dark' },
  { label: 'Dreamy', value: 'dreamy' },
  { label: 'Groovy', value: 'groovy' },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

// The last generated playlist (and the settings that made it) survive tab switches and reloads.
const SAVED_KEY = 'bs_playlist_v1';

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || {}; } catch { return {}; }
}

// Keep only what the list and player use; full track objects are large.
function trimTrack(t) {
  return {
    id: t.id, uri: t.uri, name: t.name, duration_ms: t.duration_ms,
    artists: (t.artists || []).map(a => ({ id: a.id, name: a.name })),
    album: { images: t.album?.images || [] },
    external_urls: t.external_urls,
  };
}

// getToken: async () => a current access token. player: Better Spotify's useSpotifyWebPlayer.
// onPlay(track, queue): plays track, then carries on through queue.
export default function PlaylistTab({ getToken, player, onPlay }) {
  const [saved] = useState(loadSaved);
  const [artists, setArtists] = useState(saved.artists || []);
  const [genres, setGenres] = useState(saved.genres || []);
  const [mood, setMood] = useState(saved.mood || null);
  const [discovery, setDiscovery] = useState(saved.discovery ?? 50);
  const [count, setCount] = useState(saved.count ?? 20);

  const [generating, setGenerating] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [genError, setGenError] = useState('');
  const [tracks, setTracks] = useState(saved.tracks || []);
  const [feedback, setFeedback] = useState(loadFeedback);

  useEffect(() => {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify({
        artists: artists.map(a => ({ id: a.id, name: a.name })),
        genres, mood, discovery, count, tracks,
      }));
    } catch { /* storage full or unavailable */ }
  }, [artists, genres, mood, discovery, count, tracks]);

  const generate = useCallback(async () => {
    if (artists.length === 0 && genres.length === 0) {
      setGenError('Select at least one artist or genre to get started.');
      return;
    }
    setGenError(''); setGenerating(true); setProgressMsg('');
    try {
      const chosen = await gatherTracks({
        seedArtists: artists, genres, mood, discovery, count, token: await getToken(),
        onProgress: setProgressMsg,
      });
      if (chosen.length === 0) {
        setGenError('No tracks found. Try adding more artists or adjusting the discovery slider.');
        return;
      }
      setTracks(chosen.map(trimTrack));
    } catch (e) {
      setGenError(e.message || 'Something went wrong. Please try again.');
    } finally {
      setGenerating(false);
      setProgressMsg('');
    }
  }, [getToken, artists, genres, mood, discovery, count]);

  function handleFeedback(track, value) {
    const artistName = track.artists?.[0]?.name || '';
    const artistId = track.artists?.[0]?.id || '';
    const current = feedback[track.id]?.v || 0;
    // Toggle off if same value clicked again
    const newValue = current === value ? 0 : value;
    const updated = setTrackFeedback(track.id, newValue, artistName, artistId);
    setFeedback({ ...updated });
  }

  const activeUri = player.item?.uri;

  return (
    <div>
      {/* ── Seeds card ── */}
      <div style={s.card}>
        <div style={s.section}>
          <label style={s.label}>Artists</label>
          <ArtistSearch getToken={getToken} selected={artists}
            onAdd={a => setArtists(p => [...p, a])}
            onRemove={id => setArtists(p => p.filter(a => a.id !== id))} />
        </div>

        <hr style={s.sectionDivider} />

        <div style={s.sectionLast}>
          <label style={s.label}>Genres</label>
          <GenreSearch selected={genres}
            onAdd={g => setGenres(p => [...p, g])}
            onRemove={g => setGenres(p => p.filter(x => x !== g))} />
        </div>
      </div>

      {/* ── Tuning card ── */}
      <div style={s.card}>
        <div style={s.section}>
          <label style={s.label}>Mood</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {MOODS.map(m => (
              <button key={m.value} style={s.pill(mood === m.value)}
                onClick={() => setMood(prev => prev === m.value ? null : m.value)}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <hr style={s.sectionDivider} />

        <div style={{ ...s.row2, ...s.sectionLast }}>
          <div>
            <label style={s.label}>Discovery</label>
            <div style={s.sliderRow}>
              <input type="range" min={0} max={100} step={1} value={discovery}
                onChange={e => setDiscovery(Number(e.target.value))} style={s.slider} />
            </div>
            <div style={s.sliderLabels}>
              <span>Familiar</span>
              <span>Adventurous</span>
            </div>
          </div>
          <div>
            <label style={s.label}>Songs</label>
            <div style={s.sliderRow}>
              <input type="range" min={5} max={50} step={5} value={count}
                onChange={e => setCount(Number(e.target.value))} style={s.slider} />
              <span style={s.sliderVal}>{count}</span>
            </div>
          </div>
        </div>
      </div>

      <button
        style={{ ...s.generateBtn, opacity: generating ? 0.6 : 1, cursor: generating ? 'default' : 'pointer' }}
        onClick={generate} disabled={generating}>
        {generating ? 'Generating...' : 'Generate Playlist'}
      </button>

      {generating && progressMsg && <p style={s.progressMsg}>{progressMsg}</p>}
      {genError && <div style={s.error}>{genError}</div>}

      {tracks.length > 0 && (
        <div style={s.result}>
          <div style={s.resultHeader}>
            <h2 style={s.resultTitle}>Your Playlist</h2>
            <button style={s.playAllBtn} onClick={() => onPlay(tracks[0], tracks)}>▶ Play all</button>
            <span style={s.trackCount}>{tracks.length} tracks</span>
          </div>

          <ul style={s.trackList}>
            {tracks.map((t, i) => {
              const active = t.uri === activeUri;
              return (
                <li key={t.id} style={s.track(active)}
                  onClick={() => { if (active) player.togglePlay(); else onPlay(t, tracks); }}>
                  <span style={s.trackNum}>{i + 1}</span>
                  {t.album?.images?.[2]?.url && <img src={t.album.images[2].url} alt="" style={s.trackThumb} />}
                  <div style={s.trackInfo}>
                    <div style={s.trackName(active)}>{t.name}</div>
                    <div style={s.trackArtist}>{t.artists?.map(a => a.name).join(', ')}</div>
                  </div>
                  <a href={t.external_urls?.spotify} target="_blank" rel="noopener noreferrer"
                    style={s.spotifyLink} title="Open in Spotify"
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
                    onMouseLeave={(e) => e.currentTarget.style.opacity = 0.7}>
                    <SpotifyIcon size={18} />
                  </a>
                  <div style={s.feedbackBtns}>
                    <button style={s.fbBtn(feedback[t.id]?.v === 1, '#22c55e')}
                      title="More like this"
                      onClick={(e) => { e.stopPropagation(); handleFeedback(t, 1); }}>
                      +
                    </button>
                    <button style={s.fbBtn(feedback[t.id]?.v === -1, '#ef4444')}
                      title="Less like this"
                      onClick={(e) => { e.stopPropagation(); handleFeedback(t, -1); }}>
                      &minus;
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function SpotifyIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.371-.721.49-1.101.241-3.021-1.858-6.832-2.278-11.322-1.237-.43.101-.86-.18-.96-.61-.101-.43.18-.86.61-.96 4.91-1.12 9.122-.641 12.512 1.43.38.241.5.721.261 1.136zm1.47-3.27c-.3.461-.93.6-1.39.3-3.461-2.13-8.732-2.75-12.821-1.51-.521.15-1.061-.15-1.211-.671-.15-.521.15-1.061.671-1.211 4.68-1.42 10.5-.73 14.49 1.72.461.3.6.93.261 1.372zm.13-3.41C15.24 8.4 8.82 8.19 5.16 9.301c-.621.18-1.271-.18-1.45-.8-.181-.62.18-1.271.8-1.45 4.23-1.28 11.26-1.03 15.69 1.75.54.33.71 1.03.38 1.57-.33.541-1.03.71-1.57.38z"/>
    </svg>
  );
}
