import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Spotify PKCE helpers ────────────────────────────────────────────────────

const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID || '';
const REDIRECT_URI = `${window.location.origin}/playlist-generator`;
const SCOPES = 'streaming user-read-email playlist-modify-public playlist-modify-private';

function randomBytes(len) {
  return crypto.getRandomValues(new Uint8Array(len));
}
function base64url(buf) {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(plain) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
  return new Uint8Array(digest);
}
async function startPKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(await sha256(verifier));
  sessionStorage.setItem('pkce_verifier', verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI,
    scope: SCOPES, code_challenge_method: 'S256', code_challenge: challenge,
    show_dialog: 'true',
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}
async function exchangeCode(code) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: REDIRECT_URI, client_id: CLIENT_ID,
      code_verifier: sessionStorage.getItem('pkce_verifier'),
    }),
  });
  if (!res.ok) throw new Error('Token exchange failed');
  return res.json();
}
async function doRefresh(refresh) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID }),
  });
  if (!res.ok) throw new Error('Refresh failed');
  const data = await res.json();
  return data;
}
function saveTokens({ access_token, refresh_token, expires_in }) {
  localStorage.setItem('sp_access', access_token);
  if (refresh_token) localStorage.setItem('sp_refresh', refresh_token);
  localStorage.setItem('sp_exp', String(Date.now() + expires_in * 1000 - 60_000));
  localStorage.setItem('sp_scopes', SCOPES);
}
async function getToken() {
  // Force re-auth if scopes have changed
  const storedScopes = localStorage.getItem('sp_scopes');
  if (storedScopes && storedScopes !== SCOPES) {
    clearTokens();
    return null;
  }
  const access = localStorage.getItem('sp_access');
  const exp = Number(localStorage.getItem('sp_exp') || 0);
  if (access && Date.now() < exp) return access;
  const refresh = localStorage.getItem('sp_refresh');
  if (!refresh) return null;
  const data = await doRefresh(refresh);
  saveTokens(data);
  return data.access_token;
}
function clearTokens() {
  ['sp_access', 'sp_refresh', 'sp_exp', 'sp_scopes'].forEach(k => localStorage.removeItem(k));
  sessionStorage.removeItem('pkce_verifier');
}

// ─── Spotify API ─────────────────────────────────────────────────────────────

async function spGet(path, token) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || res.statusText);
  }
  return res.json();
}

async function searchArtists(q, token) {
  if (!q.trim()) return [];
  const data = await spGet(`/search?type=artist&limit=6&q=${encodeURIComponent(q)}`, token);
  return data.artists?.items || [];
}
async function getMe(token) { return spGet('/me', token); }

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
    // Paginate to get more results (Dev Mode caps at 10 per request)
    for (let offset = 0; offset < 30; offset += 10) {
      try {
        const data = await spGet(`/search?q=${encodeURIComponent(query)}&type=track&limit=10&offset=${offset}`, token);
        const items = data.tracks?.items || [];
        items.forEach(t => addToPool(t, score - offset * 0.01, source, provenance));
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
      // Run searchDepth strategies per artist
      const strategies = artistSearchStrategies.slice(0, searchDepth);
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
      // Genre + varied descriptors for more diversity
      genreTasks.push(() => searchAndAdd(`${genre} new`, 1, `genre:${genre}`, `genre: ${genre}`));
      genreTasks.push(() => searchAndAdd(`${genre} best`, 1, `genre:${genre}`, `genre: ${genre}`));
      genreTasks.push(() => searchAndAdd(`${genre} underground`, 0.8, `genre:${genre}`, `genre: ${genre}`));
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

// ─── Spotify Web Playback SDK ─────────────────────────────────────────────────

function useSpotifyPlayer(token) {
  const [player, setPlayer] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [playerState, setPlayerState] = useState(null); // { paused, position, duration, track_name }
  const onTrackEndRef = useRef(null);
  const lastTrackUriRef = useRef(null);

  useEffect(() => {
    if (!token) return;

    // Load SDK script if not already loaded
    if (!window.Spotify && !document.getElementById('spotify-sdk')) {
      const script = document.createElement('script');
      script.id = 'spotify-sdk';
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      document.body.appendChild(script);
    }

    let p = null;
    const onReady = () => {
      p = new window.Spotify.Player({
        name: 'Playlist Generator',
        getOAuthToken: cb => cb(token),
        volume: 0.5,
      });

      p.addListener('ready', ({ device_id }) => {
        setDeviceId(device_id);
      });

      p.addListener('player_state_changed', state => {
        if (!state) return;
        const currentUri = state.track_window?.current_track?.uri;
        setPlayerState({
          paused: state.paused,
          position: state.position,
          duration: state.duration,
          trackUri: currentUri,
        });
        // Detect track end: paused, position 0, and we were playing something
        if (state.paused && state.position === 0 && lastTrackUriRef.current && currentUri === lastTrackUriRef.current) {
          onTrackEndRef.current?.();
        }
        if (!state.paused) {
          lastTrackUriRef.current = currentUri;
        }
      });

      p.addListener('initialization_error', ({ message }) => console.error('[player] init error:', message));
      p.addListener('authentication_error', ({ message }) => console.error('[player] auth error:', message));
      p.addListener('account_error', ({ message }) => console.error('[player] account error:', message));

      p.connect();
      setPlayer(p);
    };

    if (window.Spotify) {
      onReady();
    } else {
      window.onSpotifyWebPlaybackSDKReady = onReady;
    }

    return () => {
      if (p) { p.disconnect(); setPlayer(null); setDeviceId(null); }
    };
  }, [token]);

  const play = useCallback(async (uri) => {
    if (!deviceId || !token) return;
    lastTrackUriRef.current = uri;
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [uri] }),
    });
  }, [deviceId, token]);

  const togglePlay = useCallback(() => {
    if (player) player.togglePlay();
  }, [player]);

  return { deviceId, playerState, play, togglePlay, onTrackEndRef };
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = {
  page: {
    maxWidth: 720, margin: '0 auto', padding: '56px 28px 96px',
    fontFamily: 'var(--font-body)',
  },
  // ── Header ──
  header: { marginBottom: 48, textAlign: 'center' },
  title: {
    fontFamily: 'var(--font-display)', fontSize: 42, fontWeight: 700,
    margin: '0 0 6px', color: 'var(--color-text)', letterSpacing: '-0.01em',
  },
  subtitle: { color: 'var(--color-text-muted)', margin: 0, fontSize: 16, lineHeight: 1.5 },
  // ── Connect ──
  connectWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, marginTop: 40 },
  connectBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    background: '#1DB954', color: '#fff', border: 'none', borderRadius: 28,
    padding: '14px 32px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(29,185,84,0.3)', transition: 'transform 0.1s, box-shadow 0.15s',
  },
  // ── User bar ──
  userBar: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 36,
    padding: '10px 16px', background: 'var(--color-surface)',
    border: '1px solid var(--color-border)', borderRadius: 100,
  },
  avatar: { width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' },
  userName: { flex: 1, fontWeight: 500, fontSize: 13, color: 'var(--color-text-muted)' },
  disconnectBtn: {
    background: 'none', border: 'none', borderRadius: 6,
    padding: '4px 10px', fontSize: 12, color: 'var(--color-text-muted)', cursor: 'pointer',
    textDecoration: 'underline', textUnderlineOffset: 2,
  },
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
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px 24px 16px',
  },
  resultTitle: { fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, margin: 0 },
  // ── Player bar ──
  playerBar: {
    display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px',
    background: 'var(--color-bg)', borderTop: '1px solid var(--color-border)',
    borderBottom: '1px solid var(--color-border)',
  },
  playBtn: {
    width: 40, height: 40, borderRadius: '50%', border: 'none',
    background: 'var(--color-accent)', color: '#fff', fontSize: 16,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, boxShadow: '0 2px 6px rgba(192,98,47,0.25)',
    transition: 'transform 0.1s',
  },
  playerTrackInfo: { flex: 1, minWidth: 0 },
  playerTrackName: {
    fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--color-text)',
  },
  playerArtist: {
    fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1,
  },
  playerCounter: {
    fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0,
    fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em',
  },
  playerWaiting: {
    fontSize: 13, color: 'var(--color-text-muted)', fontStyle: 'italic',
    padding: '14px 24px', margin: 0, borderBottom: '1px solid var(--color-border)',
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

function ArtistSearch({ token, selected, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [hi, setHi] = useState(-1);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!query.trim()) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try { const r = await searchArtists(query, token); setResults(r); setOpen(r.length > 0); setHi(-1); }
      catch { setResults([]); }
    }, 300);
  }, [query, token]);

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

  function pick(a) {
    if (!selected.find(x => x.id === a.id)) onAdd(a);
    setQuery(''); setOpen(false); setResults([]);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input style={s.input} placeholder="Search for artists to add..." value={query}
        onChange={e => setQuery(e.target.value)} onKeyDown={onKey}
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

export default function PlaylistGenerator() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState('');

  const [artists, setArtists] = useState([]);
  const [genres, setGenres] = useState([]);
  const [mood, setMood] = useState(null);
  const [discovery, setDiscovery] = useState(50);
  const [count, setCount] = useState(20);

  const [generating, setGenerating] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [genError, setGenError] = useState('');
  const [tracks, setTracks] = useState([]);
  const [activeTrackIdx, setActiveTrackIdx] = useState(0);
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [feedback, setFeedback] = useState(loadFeedback);

  const { deviceId, playerState, play, togglePlay, onTrackEndRef } = useSpotifyPlayer(token);

  const activeTrack = tracks[activeTrackIdx] || null;

  // Auto-advance to next track when current one ends
  useEffect(() => {
    onTrackEndRef.current = () => {
      setActiveTrackIdx(prev => {
        const next = prev + 1;
        if (next < tracks.length) return next;
        return prev;
      });
    };
  }, [tracks.length, onTrackEndRef]);

  // Play track when user-initiated index change occurs (only after playback has started)
  const prevIdxRef = useRef(-1);
  useEffect(() => {
    if (!playbackStarted || !deviceId || !activeTrack) return;
    if (activeTrackIdx !== prevIdxRef.current) {
      play(activeTrack.uri);
      prevIdxRef.current = activeTrackIdx;
    }
  }, [activeTrackIdx, playbackStarted, deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  function startPlaying(idx) {
    const i = idx ?? activeTrackIdx;
    setActiveTrackIdx(i);
    setPlaybackStarted(true);
    const t = tracks[i];
    if (t && deviceId) play(t.uri);
  }

  useEffect(() => {
    async function init() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        window.history.replaceState({}, '', window.location.pathname);
        try {
          const d = await exchangeCode(code);
          saveTokens(d);
          sessionStorage.removeItem('pkce_verifier');
        }
        catch { setAuthError('Could not connect to Spotify. Please try again.'); return; }
      }
      const t = await getToken();
      if (!t) return;
      setToken(t);
      try {
        const me = await getMe(t);
        setUser(me);
      } catch { clearTokens(); }
    }
    init();
  }, []);

  const generate = useCallback(async () => {
    if (!token) return;
    if (artists.length === 0 && genres.length === 0) {
      setGenError('Select at least one artist or genre to get started.');
      return;
    }
    setGenError(''); setGenerating(true); setTracks([]); setActiveTrackIdx(0); setPlaybackStarted(false); setProgressMsg('');
    try {
      const chosen = await gatherTracks({
        seedArtists: artists, genres, mood, discovery, count, token,
        onProgress: setProgressMsg,
      });
      if (chosen.length === 0) {
        setGenError('No tracks found. Try adding more artists or adjusting the discovery slider.');
        return;
      }
      setTracks(chosen);
    } catch (e) {
      setGenError(e.message || 'Something went wrong. Please try again.');
    } finally {
      setGenerating(false);
      setProgressMsg('');
    }
  }, [token, artists, genres, mood, discovery, count]);

  function handleFeedback(track, value) {
    const artistName = track.artists?.[0]?.name || '';
    const artistId = track.artists?.[0]?.id || '';
    const current = feedback[track.id]?.v || 0;
    // Toggle off if same value clicked again
    const newValue = current === value ? 0 : value;
    const updated = setTrackFeedback(track.id, newValue, artistName, artistId);
    setFeedback({ ...updated });
  }

  if (!token) {
    if (!CLIENT_ID) {
      return (
        <div style={s.page}>
          <div style={s.header}><h1 style={s.title}>Playlist Generator</h1></div>
          <div style={s.error}><strong>Setup required:</strong> Add <code>VITE_SPOTIFY_CLIENT_ID</code> to <code>.env.local</code>.</div>
        </div>
      );
    }
    return (
      <div style={s.page}>
        <div style={s.header}>
          <h1 style={s.title}>Playlist Generator</h1>
          <p style={s.subtitle}>Discover new music based on your taste.</p>
        </div>
        <div style={s.connectWrap}>
          {authError && <div style={s.error}>{authError}</div>}
          <button style={s.connectBtn} onClick={startPKCE}><SpotifyIcon /> Connect with Spotify</button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Playlist Generator</h1>
        <p style={s.subtitle}>Discover new music from artists and genres.</p>
      </div>

      {user && (
        <div style={s.userBar}>
          {user.images?.[0]?.url && <img src={user.images[0].url} alt="" style={s.avatar} />}
          <span style={s.userName}>{user.display_name}</span>
          <button style={s.disconnectBtn} onClick={() => { clearTokens(); setToken(null); setUser(null); }}>Disconnect</button>
        </div>
      )}

      {/* ── Seeds card ── */}
      <div style={s.card}>
        <div style={s.section}>
          <label style={s.label}>Artists</label>
          <ArtistSearch token={token} selected={artists}
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
            <span style={s.playerCounter}>{tracks.length} tracks</span>
          </div>

          {activeTrack && deviceId ? (
            <div style={s.playerBar}>
              <button style={s.playBtn} onClick={() => playbackStarted ? togglePlay() : startPlaying()}>
                {playbackStarted && playerState?.paused === false ? '\u23F8' : '\u25B6'}
              </button>
              <div style={s.playerTrackInfo}>
                <div style={s.playerTrackName}>{activeTrack.name}</div>
                <div style={s.playerArtist}>{activeTrack.artists?.map(a => a.name).join(', ')}</div>
              </div>
              <span style={s.playerCounter}>
                {activeTrackIdx + 1} / {tracks.length}
              </span>
            </div>
          ) : !deviceId ? (
            <p style={s.playerWaiting}>Connecting to Spotify...</p>
          ) : null}

          <ul style={s.trackList}>
            {tracks.map((t, i) => {
              const active = i === activeTrackIdx;
              return (
                <li key={t.id} style={s.track(active)}
                  onClick={() => {
                    if (i === activeTrackIdx && playbackStarted) { togglePlay(); }
                    else { startPlaying(i); }
                  }}>
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
