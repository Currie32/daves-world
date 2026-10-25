import { useState, useEffect, useCallback, useRef } from 'react';
import { startAuth, completeAuth, getToken, clearTokens, spGet } from '../lib/spotify';
import { recommendSongs, songKeys } from '../lib/musicRecs';
import { doc, getDoc, setDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSpotifyWebPlayer, embedHeight, isEpisode, RATES } from '../lib/useSpotifyWebPlayer';
import { findEpisodeAudio, forgetEpisodeAudio } from '../lib/podcastFeed';
import PlaylistTab from './BetterSpotifyPlaylist';

// Better Spotify uses its own Spotify app ("music-box"), not the default VITE_SPOTIFY_CLIENT_ID one.
const CLIENT_ID = import.meta.env.VITE_SPOTIFY_BETTER_CLIENT_ID || '';

const RECENT_DAYS = 14;
const LISTENED_DAYS = 30;
const LISTENED_MIN_MS = 20 * 60_000;
const RECS_KEY = 'bs_recs_v7';
const RECS_TTL = 72 * 3600_000;
const MUSIC_RECS_KEY = 'bs_music_recs_v2';
const DISMISSED_KEY = 'bs_music_dismissed_v1';

// ─── Data loading ────────────────────────────────────────────────────────────

async function getFollowedShows(token) {
  const shows = [];
  let path = '/me/shows?limit=50';
  while (path) {
    const data = await spGet(path, token);
    shows.push(...(data.items || []).map(i => i.show).filter(Boolean));
    path = data.next ? data.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return shows;
}

// Run `fn` over items with bounded concurrency to stay under Spotify's rate limit.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Release dates are 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD'; parse as local midnight.
function parseRelease(d) {
  const [y, m = 1, day = 1] = (d || '').split('-').map(Number);
  return y ? new Date(y, m - 1, day) : new Date(0);
}

// Access tokens last an hour; always fetch a current one (refreshing if needed)
// rather than reusing the one the page loaded with.
async function freshToken() {
  const t = await getToken(CLIENT_ID);
  if (!t) throw new Error('Your Spotify session expired — Disconnect and connect again.');
  return t;
}

// "429 ×12 (retry in 30s), 404 ×1" — why show requests failed.
function summarizeErrors(errors) {
  const by = new Map();
  for (const e of errors) {
    const k = e.status || 'network';
    const cur = by.get(k) || { n: 0, msg: e.message, retry: e.retryAfter };
    cur.n++;
    by.set(k, cur);
  }
  return [...by].map(([k, v]) => `${k} ${v.msg}${v.n > 1 ? ` ×${v.n}` : ''}${v.retry ? ` (retry in ${v.retry}s)` : ''}`).join(', ');
}

// Per-show episode cache (localStorage) so a load only asks Spotify about shows
// that changed. /me/shows reports each show's total_episodes, so a new episode
// is detected without fetching. Shows with recent episodes are still refetched
// now and then (and on Refresh) to pick up listening progress.
const EPS_CACHE_KEY = 'bs_show_eps_v1';
const PROGRESS_TTL = 60 * 60_000;          // shows with recent episodes: progress up to 1h old
const IDLE_TTL = 7 * 86_400_000;           // shows with nothing recent: recheck weekly

function readEpsCache() {
  try { return JSON.parse(localStorage.getItem(EPS_CACHE_KEY) || '{}'); } catch { return {}; }
}

// Keep only what the page uses, and only the latest episode + the last LISTENED_DAYS.
function trimEpisodes(items, listenedCutoff) {
  return items
    .map(ep => ({ ...ep, _date: parseRelease(ep.release_date).getTime() }))
    .sort((a, b) => b._date - a._date)
    .filter((ep, i) => i === 0 || ep._date >= listenedCutoff)
    .map(ep => ({
      id: ep.id, name: ep.name, uri: ep.uri, release_date: ep.release_date, _date: ep._date,
      duration_ms: ep.duration_ms, resume_point: ep.resume_point, _progressAt: Date.now(), images: ep.images,
      language: ep.language, languages: ep.languages, description: (ep.description || '').slice(0, 1500),
    }));
}

function needsFetch(show, entry, force) {
  if (!entry || show.total_episodes == null || show.total_episodes !== entry.total) return true;
  const age = Date.now() - entry.at;
  const hasRecent = entry.eps.some(ep => ep._date >= Date.now() - LISTENED_DAYS * 86_400_000);
  if (hasRecent) return force || age > PROGRESS_TTL;
  return age > IDLE_TTL;
}

const SHOWS_CACHE_KEY = 'bs_followed_v1';

// Where you are in each episode, saved by this page's player. The embed player never
// saves progress to Spotify, and the SDK's saves lag, so this fills the gap.
const PROGRESS_KEY = 'bs_ep_progress_v1';
const PROGRESS_KEEP = 300;
const DONE_WITHIN_MS = 60_000;

function readProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); } catch { return {}; }
}

function saveProgress(uri, position, duration) {
  const [, type, id] = uri.split(':');
  if (type !== 'episode' || !id) return;
  const all = readProgress();
  all[id] = { pos: Math.round(position), done: duration - position < DONE_WITHIN_MS, at: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > PROGRESS_KEEP) {
    ids.sort((a, b) => all[a].at - all[b].at).slice(0, ids.length - PROGRESS_KEEP).forEach(k => delete all[k]);
  }
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)); } catch { /* quota */ }
}

// Use the locally saved position if it's newer than what Spotify last told us, or
// further along (Spotify may not know about embed playback at all).
function withLocalProgress(ep, local = readProgress()) {
  const l = local[ep.id];
  if (!l) return ep;
  const r = ep.resume_point || {};
  const newer = l.at > (ep._progressAt || 0);
  const further = !r.fully_played && (l.done || l.pos > (r.resume_position_ms || 0));
  if (!newer && !further) return ep;
  return { ...ep, resume_point: { fully_played: l.done, resume_position_ms: l.done ? 0 : l.pos } };
}

// "Continue listening": in-progress episodes you've listened to in the last
// LISTENING_DAYS. Spotify gives no "last listened" time, so we record when an episode's
// position is seen to move (or use this page's own progress saves). An episode seen for
// the first time only counts from its release date — the one time we know you could
// have listened by — so old half-finished episodes don't show up as recent.
const LISTENING_KEY = 'bs_ep_listening_v2';     // { [episodeId]: { pos, at } }
const LISTENING_DISMISSED_KEY = 'bs_ep_listening_dismissed_v1'; // { [episodeId]: dismissedAt }
const LISTENING_DAYS = 5;
const NOW_PLAYING_EVERY_MS = 60_000;
try { localStorage.removeItem('bs_ep_listening_v1'); } catch { /* ignore */ } // stamped everything "now"
const MOVED_MS = 60_000;                         // ignore position jitter under a minute

function readJsonKey(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}

function inProgress(ep) {
  const r = ep.resume_point;
  return !!r && !r.fully_played && r.resume_position_ms > 0;
}

// Update when each episode's position last moved; returns { [id]: lastListenedAt }.
function trackListening(episodes, local) {
  const seen = readJsonKey(LISTENING_KEY);
  const now = Date.now();
  let changed = false;
  for (const ep of episodes) {
    const r = ep.resume_point;
    const pos = r?.fully_played ? -1 : (r?.resume_position_ms || 0);
    const prev = seen[ep.id];
    if (!prev) {
      seen[ep.id] = { pos, at: pos > 0 ? Math.min(ep._date || 0, now) : 0 };
      changed = true;
    } else if (Math.abs(prev.pos - pos) >= MOVED_MS) {
      seen[ep.id] = { pos, at: now };
      changed = true;
    }
  }
  // Forget entries for episodes no longer cached (they'd be first-seen again if they return).
  const current = new Set(episodes.map(ep => ep.id));
  Object.keys(seen).forEach(id => { if (!current.has(id)) { delete seen[id]; changed = true; } });
  if (changed) { try { localStorage.setItem(LISTENING_KEY, JSON.stringify(seen)); } catch { /* quota */ } }

  const last = {};
  for (const ep of episodes) last[ep.id] = Math.max(seen[ep.id]?.at || 0, local[ep.id]?.at || 0);
  return last;
}

// Ask Spotify what's playing right now (on any device). If it's a followed show's
// episode, stamp it as listened to *now* with its exact position — this is what keeps
// Continue listening ordered by when you actually last listened.
async function syncNowPlaying(token) {
  let d;
  try { d = await spGet('/me/player/currently-playing?additional_types=episode', token); } catch { return false; }
  const ep = d?.currently_playing_type === 'episode' && d.is_playing ? d.item : null;
  if (!ep) return false;
  const cache = readEpsCache();
  const cached = cache[ep.show?.id]?.eps.find(e => e.id === ep.id);
  if (!cached) return false;
  const now = Date.now();
  cached.resume_point = { fully_played: false, resume_position_ms: d.progress_ms || 0 };
  cached._progressAt = now;
  try { localStorage.setItem(EPS_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
  const seen = readJsonKey(LISTENING_KEY);
  seen[ep.id] = { pos: d.progress_ms || 0, at: now };
  try { localStorage.setItem(LISTENING_KEY, JSON.stringify(seen)); } catch { /* quota */ }
  return true;
}

function dismissListening(id) {
  const d = readJsonKey(LISTENING_DISMISSED_KEY);
  d[id] = Date.now();
  const cutoff = Date.now() - 60 * 86_400_000;
  Object.keys(d).forEach(k => { if (d[k] < cutoff) delete d[k]; });
  try { localStorage.setItem(LISTENING_DISMISSED_KEY, JSON.stringify(d)); } catch { /* quota */ }
}

// Re-read resume points for the cached episodes that matter (recent/listened window)
// from /episodes?ids= — up to 50 per request — so progress made anywhere (Spotify app,
// this page) shows on every load, without refetching each show's episode list.
async function refreshResumePoints(token, cache, skipShows, listenedCutoff) {
  const byId = new Map();
  for (const [showId, entry] of Object.entries(cache)) {
    if (skipShows.has(showId)) continue;
    entry.eps.forEach(ep => { if (ep._date >= listenedCutoff) byId.set(ep.id, ep); });
  }
  const ids = [...byId.keys()];
  const batches = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  await mapLimit(batches, 2, async batch => {
    const d = await spGet(`/episodes?ids=${batch.join(',')}`, token);
    const at = Date.now();
    (d.episodes || []).forEach(full => {
      const ep = full && byId.get(full.id);
      if (ep && full.resume_point) { ep.resume_point = full.resume_point; ep._progressAt = at; }
    });
  });
}

function readShowsCache() {
  try { return JSON.parse(localStorage.getItem(SHOWS_CACHE_KEY) || '[]'); } catch { return []; }
}

// Assemble the page's data from the followed shows + whatever episodes are cached.
function buildPodcastData(shows, cache) {
  const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
  // Spotify exposes no podcast listening history, so "listened in the past
  // month" = episodes released in that window that were finished or started.
  const listenedCutoff = Date.now() - LISTENED_DAYS * 86_400_000;
  const recent = [];
  const listened = [];
  const all = [];
  const local = readProgress();
  const showRows = shows.map(show => {
    const eps = (cache[show.id]?.eps || []).map(ep => withLocalProgress(ep, local));
    eps.forEach(ep => all.push({ ...ep, _show: show }));
    eps.filter(ep => ep._date >= cutoff).forEach(ep => recent.push({ ...ep, _show: show }));
    eps.filter(ep => ep._date >= listenedCutoff && (ep.resume_point?.fully_played || ep.resume_point?.resume_position_ms >= LISTENED_MIN_MS))
      .forEach(ep => listened.push({ ...ep, _show: show }));
    return { ...show, _latest: eps[0] || null };
  });
  recent.sort((a, b) => b._date - a._date);
  showRows.sort((a, b) => (b._latest?._date || 0) - (a._latest?._date || 0));

  // Continue listening: in progress, listened within LISTENING_DAYS, not dismissed since.
  const lastListened = trackListening(all, local);
  const dismissed = readJsonKey(LISTENING_DISMISSED_KEY);
  const listenCutoff = Date.now() - LISTENING_DAYS * 86_400_000;
  const listening = all
    .filter(ep => inProgress(ep) && lastListened[ep.id] >= listenCutoff && !(dismissed[ep.id] >= lastListened[ep.id]))
    .map(ep => ({ ...ep, _listenedAt: lastListened[ep.id] }))
    .sort((a, b) => (b._listenedAt - a._listenedAt) || (b._date - a._date));
  const listeningIds = new Set(listening.map(ep => ep.id));

  return { recent: recent.filter(ep => !listeningIds.has(ep.id)), listening, listened, shows: showRows };
}

// Streams: `onUpdate(data)` fires with the saved list straight away, then again
// as each show's new episodes arrive. `data.pending` = shows still loading.
async function loadPodcasts(token, { force = false, onUpdate }) {
  const cache = readEpsCache();
  const saved = readShowsCache();
  if (saved.length) onUpdate({ ...buildPodcastData(saved, cache), pending: null });

  const shows = (await getFollowedShows(token)).map(sh => ({
    id: sh.id, name: sh.name, publisher: sh.publisher, images: sh.images, external_urls: sh.external_urls,
    total_episodes: sh.total_episodes, description: (sh.description || '').slice(0, 500),
  }));
  try { localStorage.setItem(SHOWS_CACHE_KEY, JSON.stringify(shows)); } catch { /* quota */ }

  const listenedCutoff = Date.now() - LISTENED_DAYS * 86_400_000;
  const toFetch = shows.filter(show => needsFetch(show, cache[show.id], force));
  let pending = toFetch.length;
  onUpdate({ ...buildPodcastData(shows, cache), pending, toFetch: toFetch.length });

  // Shows being refetched get fresh resume points anyway; update the rest in bulk.
  try {
    await refreshResumePoints(token, cache, new Set(toFetch.map(sh => sh.id)), listenedCutoff);
    try { localStorage.setItem(EPS_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
  } catch { /* keep the saved positions */ }
  // After the bulk refresh, so the live position wins. Reload the cache it wrote to.
  if (await syncNowPlaying(token)) Object.assign(cache, readEpsCache());
  onUpdate({ ...buildPodcastData(shows, cache), pending, toFetch: toFetch.length });

  const errors = [];
  let failed = 0;
  await mapLimit(toFetch, 3, async show => {
    try {
      const d = await spGet(`/shows/${show.id}/episodes?limit=20`, token);
      cache[show.id] = { total: show.total_episodes, at: Date.now(), eps: trimEpisodes((d.items || []).filter(Boolean), listenedCutoff) };
    } catch (e) {
      errors.push(e); failed++;   // keeps the cached (older) episodes, if any
    }
    try { localStorage.setItem(EPS_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
    pending--;
    onUpdate({ ...buildPodcastData(shows, cache), pending, toFetch: toFetch.length });
  });

  // Forget unfollowed shows.
  const followed = new Set(shows.map(sh => sh.id));
  Object.keys(cache).forEach(id => { if (!followed.has(id)) delete cache[id]; });
  try { localStorage.setItem(EPS_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }

  const final = { ...buildPodcastData(shows, cache), pending: 0 };
  onUpdate(final);
  return { failed, total: shows.length, errorSummary: summarizeErrors(errors) };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function relativeDate(ts) {
  if (!ts) return '—';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - ts) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} wk${days >= 14 ? 's' : ''} ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function duration(ms) {
  const mins = Math.round(ms / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)} hr ${mins % 60} min` : `${mins} min`;
}

function imageUrl(images, minWidth = 64) {
  if (!images?.length) return null;
  const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find(i => (i.width || 0) >= minWidth) || sorted[sorted.length - 1]).url;
}

// ─── Components ──────────────────────────────────────────────────────────────

function EpisodeRow({ ep, onPlay }) {
  const resume = ep.resume_point;
  const played = resume?.fully_played;
  const progress = !played && resume?.resume_position_ms > 0 ? resume.resume_position_ms / ep.duration_ms : 0;
  const remaining = progress ? ep.duration_ms - resume.resume_position_ms : 0;
  return (
    <button style={s.episode(played)} onClick={() => onPlay(ep)} title="Play">
      <img src={imageUrl(ep.images) || imageUrl(ep._show.images)} alt="" style={s.epArt} />
      <div style={s.epBody}>
        <div style={s.epShow}>{ep._show.name}</div>
        <div style={s.epTitle}>{ep.name}</div>
        <div style={s.epMeta}>
          <span>{relativeDate(ep._date)}</span>
          <span>·</span>
          <span>{progress ? `${duration(remaining)} left` : duration(ep.duration_ms)}</span>
          {played && <span style={s.playedBadge}>Played</span>}
        </div>
        {progress > 0 && (
          <div style={s.progressTrack}><div style={{ ...s.progressFill, width: `${Math.min(100, progress * 100)}%` }} /></div>
        )}
      </div>
      <span style={s.playIcon}><PlayIcon /></span>
    </button>
  );
}

function ShowRow({ show, onPlay }) {
  const latest = show._latest;
  return (
    <div style={s.showRow}>
      <a href={show.external_urls?.spotify || `https://open.spotify.com/show/${show.id}`}
        target="_blank" rel="noopener noreferrer" style={s.showLink}>
        <img src={imageUrl(show.images)} alt="" style={s.showArt} />
        <div style={{ minWidth: 0 }}>
          <div style={s.showName}>{show.name}</div>
          {show.publisher && <div style={s.showPublisher}>{show.publisher}</div>}
        </div>
      </a>
      {latest ? (
        <button style={s.latestBtn} onClick={() => onPlay({ ...latest, _show: show })} title={`Play: ${latest.name}`}>
          <span style={s.latestDate}>{relativeDate(latest._date)}</span>
          <span style={s.latestName}>{latest.name}</span>
        </button>
      ) : (
        <span style={s.latestDate}>No episodes</span>
      )}
    </div>
  );
}

// Survives sub-tab switches so a running computation isn't started twice.
let recsInFlight = null;

function readRecsCache(listenedKey) {
  try {
    const c = JSON.parse(localStorage.getItem(RECS_KEY) || 'null');
    if (c && c.key === listenedKey && Date.now() - c.at < RECS_TTL && c.result?.sections?.length) return c.result;
  } catch { /* ignore */ }
  return null;
}

function RecommendedView({ data, onPlay }) {
  const listenedKey = data.listened.map(e => e.id).sort().join(',');
  const [result, setResult] = useState(() => readRecsCache(listenedKey));
  const sections = result?.sections;
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const run = useCallback(async () => {
    setError(''); setResult(null); setProgress('Loading recommendation model…');
    try {
      if (!recsInFlight) {
        recsInFlight = (async () => {
          const [{ recommendEpisodes }, { onModelProgress }] = await Promise.all([
            import('../lib/podcastRecs'), import('../lib/embeddings'),
          ]);
          onModelProgress(p => p.total && setProgress(`Downloading model (first time only)… ${Math.round(100 * p.loaded / p.total)}%`));
          const out = await recommendEpisodes({
            token: await freshToken(), listened: data.listened, followedShows: data.shows, onProgress: setProgress,
          });
          try { localStorage.setItem(RECS_KEY, JSON.stringify({ key: listenedKey, at: Date.now(), result: out })); } catch { /* quota */ }
          return out;
        })().finally(() => { recsInFlight = null; });
      }
      setResult(await recsInFlight);
    } catch (e) {
      setError(e.message || 'Could not build recommendations.');
    } finally {
      setProgress('');
    }
  }, [data, listenedKey]);

  useEffect(() => {
    if (!sections && data.listened.length) run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenedKey]);

  const header = (
    <div style={s.recsHead}>
      <p style={{ ...s.sectionSub, margin: 0 }}>
        Episodes from shows you don’t follow, matched to the guests and topics of episodes you played recently.
      </p>
    </div>
  );

  if (!data.listened.length) {
    return <div style={s.muted}>No listening found in the last {LISTENED_DAYS} days. Play a few episodes from shows you follow, then refresh.</div>;
  }
  if (error) return <>{header}<div style={s.error}>{error} <button style={s.linkBtn} onClick={run}>Retry</button></div></>;
  if (!sections) return <>{header}<div style={s.muted}>{progress || 'Working…'}</div></>;
  return (
    <>
      {header}
      {sections.length === 0 ? (
        <div style={s.muted}>
          Couldn’t find similar episodes this time.
          <DebugSummary debug={result.debug} />
        </div>
      ) : (
        sections.map(({ source, recs }) => (
          <section key={source.id} style={s.recSection}>
            <div style={s.recSectionHead}>
              <span style={s.recSectionLabel}>Because you listened to</span>
              <span style={s.recSectionTitle}>{source.name}</span>
              <span style={s.recSectionShow}>{source.show}</span>
            </div>
            <div style={s.list}>
              {recs.map(ep => <EpisodeRow key={ep.id} ep={ep} onPlay={onPlay} />)}
            </div>
          </section>
        ))
      )}
    </>
  );
}

function DebugSummary({ debug }) {
  if (!debug) return null;
  const rows = [
    ['Listened episodes (last 30 days)', debug.listenedEpisodes],
    ['Source episodes', debug.sources],
    ['Searches', debug.queries ? `${debug.queries.length}: ${debug.queries.join(', ')}` : undefined],
    ['Episodes returned by search', debug.searchResults],
    ['New episodes after filtering', debug.candidates],
    ['Close enough matches', debug.aboveThreshold],
    ['Recommended (unfollowed shows)', debug.recommended],
    ['Spotify errors', debug.errors?.length ? debug.errors.join(' | ') : undefined],
  ].filter(([, v]) => v !== undefined);
  return (
    <dl style={s.debug}>
      {rows.map(([k, v]) => <div key={k} style={{ display: 'flex', gap: 8 }}><dt style={{ fontWeight: 600 }}>{k}:</dt><dd style={{ margin: 0 }}>{v}</dd></div>)}
    </dl>
  );
}

function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function itemInfo(it) {
  if (isEpisode(it)) {
    return { title: it.name, subtitle: it._show?.name, art: imageUrl(it.images) || imageUrl(it._show?.images) };
  }
  return { title: it.name, subtitle: it.artists?.map(a => a.name).join(', '), art: imageUrl(it.album?.images) };
}

// Fixed bottom bar. Feed audio and the SDK engine: our own controls (feed audio adds a
// speed button). Embed engine: Spotify's embed player. Larger buttons on phones.
function PlayerBar({ player, mobile }) {
  const { engine, source, item, queue, state, error, rate, togglePlay, next, prev, seek, skip, setRate, close, embedElRef } = player;
  const [now, setNow] = useState(() => Date.now());
  // Our controls drive feed audio, or Spotify when the SDK engine is playing.
  const live = !!item && state?.uri === item.uri && (source === 'audio' || (source === 'spotify' && engine === 'sdk'));
  const playing = live && !state.paused;
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [playing]);

  // The bar is fixed, so reserve its height at the end of the page to keep content reachable.
  const barRef = useRef(null);
  const [barHeight, setBarHeight] = useState(0);
  const open = !!item;
  useEffect(() => {
    const el = barRef.current;
    if (!open || !el) return;
    const ro = new ResizeObserver(() => setBarHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  if (!item) return null;

  const info = itemInfo(item);
  const openUrl = item.external_urls?.spotify || `https://open.spotify.com/${item.uri.split(':')[1]}/${item.id}`;
  const showEmbed = engine === 'embed' && source === 'spotify';
  const elapsed = state && !state.paused ? Math.max(0, now - state.at) * (state.rate || 1) : 0;
  const position = live ? Math.min(state.duration, state.position + elapsed) : 0;
  const status = source === 'resolving' ? 'Loading…' : engine === 'pending' ? 'Connecting player…' : '';
  const duration = live ? state.duration : item.duration_ms;
  const episode = isEpisode(item);
  const qi = queue ? queue.findIndex(t => t.uri === item.uri) : -1;

  const skipStyle = mobile ? s.mSkipBtn : s.skipBtn;
  const back15 = episode && <button style={skipStyle} onClick={() => skip(-15_000)} aria-label="Back 15 seconds">−15s</button>;
  const fwd15 = episode && <button style={skipStyle} onClick={() => skip(15_000)} aria-label="Forward 15 seconds">+15s</button>;
  const iconSize = mobile ? 22 : 14;
  const prevBtn = qi >= 0 && (
    <button style={{ ...skipStyle, opacity: qi === 0 ? 0.4 : 1 }} onClick={prev} disabled={qi === 0} aria-label="Previous track"><PrevIcon size={iconSize} /></button>
  );
  const nextBtn = qi >= 0 && (
    <button style={{ ...skipStyle, opacity: qi === queue.length - 1 ? 0.4 : 1 }} onClick={next} disabled={qi === queue.length - 1} aria-label="Next track"><NextIcon size={iconSize} /></button>
  );
  const playBtn = (
    <button style={mobile ? s.mPlayBtn : s.bigPlayBtn} onClick={togglePlay} disabled={!live}
      aria-label={playing ? 'Pause' : 'Play'}>
      {!live ? '…' : playing ? <PauseIcon size={mobile ? 26 : 14} /> : <PlayIcon size={mobile ? 26 : 14} />}
    </button>
  );
  const seekRow = (
    <>
      <span style={s.playerTime}>{clock(position)}</span>
      <input type="range" min={0} max={duration || 0} step={1000} value={position} disabled={!live}
        onChange={e => seek(Number(e.target.value))} style={s.seekBar} aria-label="Seek" />
      <span style={s.playerTime}>{clock(duration || 0)}</span>
    </>
  );
  const speedBtn = source === 'audio' && (
    <button style={s.speedBtn} onClick={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length])}
      aria-label={`Playback speed ${rate}×, tap to change`}>
      {rate}×
    </button>
  );
  const openLink = <a href={openUrl} target="_blank" rel="noreferrer" style={s.openLink}>Open in Spotify</a>;
  const closeBtn = <button style={s.closeBtn} onClick={close} aria-label="Close player"><CloseIcon size={mobile ? 20 : 14} /></button>;
  const embedBox = <div ref={embedElRef} style={{ ...s.embedBox, height: embedHeight(item, mobile) }} />;

  // One tree for both layouts, with the embed in the same slot, so rotating a phone
  // (switching layouts) doesn't remount Spotify's iframe and stop playback.
  let main, foot;
  if (mobile) {
    main = showEmbed ? embedBox : (
      <div style={s.mInfo}>
        {info.art && <img src={info.art} alt="" style={s.mArt} />}
        <div style={s.playerText}>
          <div style={s.mTitle}>{info.title}</div>
          <div style={s.mSubtitle}>{info.subtitle}</div>
        </div>
      </div>
    );
    foot = showEmbed
      ? (episode || qi >= 0) && <div style={s.mControls}>{back15}{prevBtn}{nextBtn}{fwd15}</div>
      : (
        <div style={s.mBottom}>
          <div style={s.playerFoot}>
            {status && !live ? <span style={s.playerTime}>{status}</span> : seekRow}
          </div>
          <div style={s.mControls}>{back15}{prevBtn}{playBtn}{nextBtn}{fwd15}</div>
        </div>
      );
  } else {
    main = showEmbed ? embedBox : (
      <div style={s.playerRow}>
        {info.art && <img src={info.art} alt="" style={s.playerArt} />}
        <div style={s.playerText}>
          <div style={s.playerTitle}>{info.title}</div>
          <div style={s.playerSubtitle}>{info.subtitle}</div>
        </div>
        <div style={s.playerControls}>{back15}{prevBtn}{playBtn}{nextBtn}{fwd15}</div>
      </div>
    );
    foot = (
      <div style={s.playerFoot}>
        {showEmbed
          ? <span style={s.embedSkips}>{back15}{fwd15}{prevBtn}{nextBtn}</span>
          : status && !live ? <span style={{ ...s.playerTime, flex: 1 }}>{status}</span> : seekRow}
        {speedBtn}
        {openLink}
        {closeBtn}
      </div>
    );
  }

  return (
    <>
      <div style={{ height: barHeight }} />
      <div ref={barRef} style={mobile ? { ...s.playerBar, ...s.mPlayerBar } : s.playerBar}>
        <div style={mobile ? s.mInner : s.playerInner}>
          {mobile && <div style={s.mHead}>{openLink}<span style={s.mHeadRight}>{speedBtn}{closeBtn}</span></div>}
          {error && <div style={s.playerError}>{error}</div>}
          {main}
          {foot}
        </div>
      </div>
    </>
  );
}

function PodcastsTab({ onPlay }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState('latest');
  const [recsNonce, setRecsNonce] = useState(0);
  const dataRef = useRef(null);

  // Look up feed audio for the episodes you're most likely to play next, so they start
  // without waiting on the lookup (results are cached).
  const listening = data?.listening;
  useEffect(() => {
    listening?.slice(0, 5).forEach(ep => { findEpisodeAudio(ep); });
  }, [listening]);

  // Hide from Continue listening (until you listen to it again); it rejoins the
  // latest list if it's recent.
  const dismissEpisode = useCallback(ep => {
    dismissListening(ep.id);
    setData(prev => {
      if (!prev) return prev;
      const next = {
        ...prev,
        listening: prev.listening.filter(e => e.id !== ep.id),
        recent: ep._date >= Date.now() - RECENT_DAYS * 86_400_000
          ? [...prev.recent, ep].sort((a, b) => b._date - a._date)
          : prev.recent,
      };
      dataRef.current = next;
      return next;
    });
  }, []);

  const load = useCallback(async (force = false) => {
    setLoading(true); setError(''); setNotice('');
    try {
      const update = d => { setData(d); dataRef.current = d; };
      const out = await loadPodcasts(await freshToken(), { force, onUpdate: update });
      if (out.failed) {
        setNotice(`Spotify didn’t return episodes for ${out.failed} of ${out.total} shows (showing their saved episodes where available): ${out.errorSummary}`);
      }
      return true;
    } catch (e) {
      if (dataRef.current) {
        setNotice(`Refresh failed (${e.message || 'network error'}) — showing your saved list.`);
        setData(d => d && { ...d, pending: 0 });
      }
      else setError(e.message || 'Could not load podcasts.');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // While the page is open, check what's playing every minute (and when you come back
  // to the page) so Continue listening stays in last-listened order.
  useEffect(() => {
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== 'visible' || dataRef.current?.pending !== 0) return;
      busy = true;
      try {
        await syncNowPlaying(await freshToken());
        const next = { ...buildPodcastData(readShowsCache(), readEpsCache()), pending: 0 };
        if (dataRef.current?.pending === 0) { dataRef.current = next; setData(next); }
      } catch { /* try again next tick */ }
      busy = false;
    };
    const id = setInterval(tick, NOW_PLAYING_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  // On the Recommended tab, Refresh also discards saved recommendations and reruns them.
  const refresh = async () => {
    const ok = await load(true);
    if (ok && view === 'recs') {
      try { localStorage.removeItem(RECS_KEY); } catch { /* ignore */ }
      setRecsNonce(n => n + 1);
    }
  };

  if (error) return <div style={s.error}>{error} <button style={s.linkBtn} onClick={() => load(true)}>Retry</button></div>;
  if (!data) return <div style={s.muted}>Loading your podcasts…</div>;

  return (
    <>
      <div style={s.subTabBar}>
        <div style={s.subTabs} role="tablist">
          {[['latest', 'Latest episodes', data.recent.length], ['shows', 'Shows', data.shows.length], ['recs', 'Recommended']].map(([id, label, n]) => (
            <button key={id} role="tab" aria-selected={view === id} style={s.subTab(view === id)} onClick={() => setView(id)}>
              {label}{n !== undefined && <span style={s.subTabCount(view === id)}> {n}</span>}
            </button>
          ))}
        </div>
        <button style={s.linkBtn} onClick={refresh} disabled={loading}>
          {!loading ? 'Refresh' : data.pending ? `Updating ${data.toFetch - data.pending}/${data.toFetch} shows…` : 'Refreshing…'}
        </button>
      </div>

      {notice && <div style={{ ...s.error, marginBottom: 12 }}>{notice}</div>}

      {view === 'recs' ? (
        data.pending !== 0
          ? <div style={s.muted}>Finishing loading your podcasts…</div>
          : <RecommendedView key={recsNonce} data={data} onPlay={onPlay} />
      ) : view === 'latest' ? (
        <>
          {data.listening?.length > 0 && (
            <section style={s.recSection}>
              <div style={s.recSectionHead}>
                <span style={s.recSectionTitle}>Continue listening</span>
                <span style={s.sectionSubTight}>Episodes you’ve started — hidden after {LISTENING_DAYS} days without listening.</span>
              </div>
              <div style={s.list}>
                {data.listening.map(ep => (
                  <div key={ep.id} style={s.dismissableRow}>
                    <div style={{ flex: 1, minWidth: 0 }}><EpisodeRow ep={ep} onPlay={onPlay} /></div>
                    <button style={s.rowDismissBtn} onClick={() => dismissEpisode(ep)}
                      title="Remove from Continue listening" aria-label={`Remove ${ep.name} from Continue listening`}>
                      <CloseIcon />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
          {data.listening?.length > 0 && <span style={s.recSectionTitle}>Latest episodes</span>}
          <p style={s.sectionSub}>From shows you follow, released in the last {RECENT_DAYS} days.</p>
          {data.recent.length === 0 ? (
            <div style={s.muted}>{data.pending !== 0 ? 'Loading episodes…' : `No new episodes in the last ${RECENT_DAYS} days.`}</div>
          ) : (
            <div style={s.list}>
              {data.recent.map(ep => <EpisodeRow key={ep.id} ep={ep} onPlay={onPlay} />)}
            </div>
          )}
        </>
      ) : (
        <>
          <p style={s.sectionSub}>Ordered by most recent episode.</p>
          {data.shows.length === 0 ? (
            <div style={s.muted}>{data.pending !== 0 ? 'Loading shows…' : 'You don’t follow any podcasts yet.'}</div>
          ) : (
            <div style={s.showList}>
              {data.shows.map(show => <ShowRow key={show.id} show={show} onPlay={onPlay} />)}
            </div>
          )}
        </>
      )}

    </>
  );
}

// ─── Music ───────────────────────────────────────────────────────────────────

let musicInFlight = null;

function readMusicCache() {
  try {
    const c = JSON.parse(localStorage.getItem(MUSIC_RECS_KEY) || 'null');
    if (c && Date.now() - c.at < RECS_TTL && c.result?.sections?.length) return c.result;
  } catch { /* ignore */ }
  return null;
}

// Songs X'd by the user, kept forever: { ids: [], keys: [] }. Stored in this browser, and
// — when signed in to the site — in Firestore so every device shares one list. (Its own
// doc, because the Recipes page overwrites the whole user_prefs/{uid} doc.)
function readDismissed() {
  try {
    const d = JSON.parse(localStorage.getItem(DISMISSED_KEY) || 'null');
    if (d?.ids && d?.keys) return d;
  } catch { /* ignore */ }
  return { ids: [], keys: [] };
}

function writeDismissed(d) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(d)); } catch { /* quota */ }
}

const dismissedDoc = uid => doc(db, 'user_prefs', uid, 'better_spotify', 'music_dismissed');

// Add ids/keys to the account's list (arrayUnion, so devices never overwrite each other).
async function pushDismissed(uid, ids, keys) {
  const update = {};
  if (ids.length) update.ids = arrayUnion(...ids);
  if (keys.length) update.keys = arrayUnion(...keys);
  if (Object.keys(update).length) await setDoc(dismissedDoc(uid), update, { merge: true });
}

// Merge the account's list into this browser and upload anything only this browser has.
async function syncDismissed(uid) {
  const local = readDismissed();
  const snap = await getDoc(dismissedDoc(uid));
  const remote = { ids: snap.data()?.ids || [], keys: snap.data()?.keys || [] };
  const remoteIds = new Set(remote.ids), remoteKeys = new Set(remote.keys);
  const merged = {
    ids: [...new Set([...local.ids, ...remote.ids])],
    keys: [...new Set([...local.keys, ...remote.keys])],
  };
  writeDismissed(merged);
  await pushDismissed(uid, local.ids.filter(id => !remoteIds.has(id)), local.keys.filter(k => !remoteKeys.has(k)));
  return merged;
}

function withoutDismissed(result, d) {
  if (!result) return result;
  const ids = new Set(d.ids), keys = new Set(d.keys);
  const keep = t => !ids.has(t.id) && !songKeys(t).some(k => keys.has(k));
  return {
    ...result,
    sections: result.sections
      .map(sec => ({ ...sec, recs: sec.recs.filter(keep) }))
      .filter(sec => sec.recs.length),
  };
}

function TrackRow({ track, onPlay, onDismiss }) {
  return (
    <div style={s.trackRow}>
      <button style={s.trackMain} onClick={() => onPlay(track)} title="Play">
        <img src={imageUrl(track.album?.images)} alt="" style={s.trackArt} />
        <div style={s.epBody}>
          <div style={s.trackTitle}>{track.name}</div>
          <div style={s.trackArtist}>{track.artists.map(a => a.name).join(', ')}</div>
          <div style={s.epMeta}>
            <span style={s.trackAlbum}>{track.album?.name}</span>
            <span>·</span>
            <span>{track.album?.release_date?.slice(0, 4)}</span>
          </div>
        </div>
        <span style={s.playIcon}><PlayIcon /></span>
      </button>
      <button style={s.dismissBtn} onClick={() => onDismiss(track)}
        title="Never recommend this song" aria-label={`Never recommend ${track.name}`}>
        <CloseIcon />
      </button>
    </div>
  );
}

// Music: sub-tabs for song recommendations and the playlist generator.
function MusicTab({ view, setView, onPlay, player }) {
  return (
    <>
      <div style={s.subTabBar}>
        <div style={s.subTabs} role="tablist">
          {[['recs', 'Recommended'], ['playlist', 'Playlist']].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} style={s.subTab(view === id)} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {view === 'playlist'
        ? <PlaylistTab getToken={freshToken} player={player} onPlay={onPlay} />
        : <SongRecsView onPlay={onPlay} />}
    </>
  );
}

function SongRecsView({ onPlay }) {
  const [result, setResult] = useState(readMusicCache);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const { user, loading: authLoading } = useAuth();
  const uidRef = useRef(null);
  const resultRef = useRef(result);
  useEffect(() => { resultRef.current = result; }, [result]);

  const run = useCallback(async () => {
    setError(''); setResult(null); setProgress('Starting…');
    try {
      if (!musicInFlight) {
        musicInFlight = (async () => {
          const uid = uidRef.current;
          const dismissed = uid ? await syncDismissed(uid).catch(() => readDismissed()) : readDismissed();
          const out = await recommendSongs({ token: await freshToken(), onProgress: setProgress, dismissed });
          try { localStorage.setItem(MUSIC_RECS_KEY, JSON.stringify({ at: Date.now(), result: out })); } catch { /* quota */ }
          return out;
        })().finally(() => { musicInFlight = null; });
      }
      setResult(await musicInFlight);
    } catch (e) {
      setError(e.message || 'Could not build recommendations.');
    } finally {
      setProgress('');
    }
  }, []);

  // Once sign-in state is known: pull dismissals made on other devices (hiding them from
  // the saved results), then build recommendations if there are none saved.
  useEffect(() => {
    if (authLoading) return;
    uidRef.current = user?.uid || null;
    let cancelled = false;
    (async () => {
      if (user) {
        try {
          const d = await syncDismissed(user.uid);
          if (!cancelled) setResult(prev => withoutDismissed(prev, d));
        } catch { /* offline: use this browser's list */ }
      }
      if (!cancelled && !resultRef.current) run();
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.uid]);

  // Remember the song so it's never recommended again, and drop it from the saved results.
  const dismiss = useCallback(track => {
    const d = readDismissed();
    const keys = songKeys(track);
    d.ids.push(track.id);
    d.keys.push(...keys);
    writeDismissed(d);
    if (uidRef.current) pushDismissed(uidRef.current, [track.id], keys).catch(() => { /* synced next load */ });
    setResult(prev => {
      if (!prev) return prev;
      const next = {
        ...prev,
        sections: prev.sections
          .map(sec => ({ ...sec, recs: sec.recs.filter(t => t.id !== track.id) }))
          .filter(sec => sec.recs.length),
      };
      try {
        const c = JSON.parse(localStorage.getItem(MUSIC_RECS_KEY) || 'null');
        if (c) localStorage.setItem(MUSIC_RECS_KEY, JSON.stringify({ ...c, result: next }));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  const busy = !result && !error;
  const header = (
    <div style={s.subTabBar}>
      <p style={{ ...s.sectionSub, margin: 0, flex: 1 }}>
        New songs, by artists you haven’t played, in the genres you’ve listened to over the last 3 months.
        {!authLoading && !user && ' Songs you X are remembered in this browser only — sign in (bottom of the page) to sync them across devices.'}
      </p>
      <button style={s.linkBtn} onClick={() => { try { localStorage.removeItem(MUSIC_RECS_KEY); } catch { /* ignore */ } run(); }} disabled={busy}>
        {busy ? 'Working…' : 'Refresh'}
      </button>
    </div>
  );

  if (error) return <>{header}<div style={s.error}>{error} <button style={s.linkBtn} onClick={run}>Retry</button></div></>;
  if (!result) return <>{header}<div style={s.muted}>{progress || 'Working…'}</div></>;
  return (
    <>
      {header}
      {result.sections.length === 0 ? (
        <div style={s.muted}>
          Couldn’t find song recommendations this time.
          <MusicDebug debug={result.debug} />
        </div>
      ) : (
        result.sections.map(({ genre, basedOn, recs }) => (
          <section key={genre} style={s.recSection}>
            <div style={s.recSectionHead}>
              <span style={s.recSectionTitle}>{genre}</span>
              <span style={s.recSectionShow}>Because you played {basedOn.join(', ')}</span>
            </div>
            <div style={s.list}>
              {recs.map(t => <TrackRow key={t.id} track={t} onPlay={onPlay} onDismiss={dismiss} />)}
            </div>
          </section>
        ))
      )}
    </>
  );
}

function MusicDebug({ debug }) {
  if (!debug) return null;
  const rows = [
    ['Songs played (last 3 months)', debug.historyTracks],
    ['Artists', debug.artists],
    ['Artists with genres', debug.artistsWithGenres],
    ['Liked songs checked', debug.likedSongs],
    ['Spotify requests (library / artists / searches)', debug.libraryRequests !== undefined ? `${debug.libraryRequests} / ${debug.artistRequests} / ${debug.queries?.length}` : undefined],
    ['iTunes genre lookups', debug.itunesLookups],
    ["Kids' songs dropped", debug.kidsTracksDropped],
    ['Genres', debug.genres?.join(', ')],
    ['Searches', debug.queries?.length],
    ['Songs returned by search', debug.searchResults],
    ['Recommended', debug.recommended],
    ['Errors', debug.errors?.length ? debug.errors.slice(0, 8).join(' | ') : undefined],
  ].filter(([, v]) => v !== undefined && v !== '');
  return (
    <dl style={s.debug}>
      {rows.map(([k, v]) => <div key={k} style={{ display: 'flex', gap: 8 }}><dt style={{ fontWeight: 600 }}>{k}:</dt><dd style={{ margin: 0 }}>{v}</dd></div>)}
    </dl>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

const TABS = [['podcasts', 'Podcasts'], ['music', 'Music']];

export default function BetterSpotify() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState('');
  const [ready, setReady] = useState(false);
  // ?tab= lets links open a specific tab; ?tab=playlist (the old /playlist-generator page)
  // opens Music → Playlist.
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'playlist' ? 'music' : TABS.some(([id]) => id === t) ? t : 'podcasts';
  });
  const [musicView, setMusicView] = useState(() =>
    new URLSearchParams(window.location.search).get('tab') === 'playlist' ? 'playlist' : 'recs');
  const mobile = useIsMobile();
  const player = useSpotifyWebPlayer(freshToken, saveProgress, {
    large: mobile, findAudio: findEpisodeAudio, forgetAudio: forgetEpisodeAudio,
  });
  const play = player.play;
  // Episodes resume from the furthest/most recent known position.
  const onPlay = useCallback((item, queue) => play(isEpisode(item) ? withLocalProgress(item) : item, queue), [play]);

  useEffect(() => {
    (async () => {
      let t;
      try { t = await completeAuth(CLIENT_ID); }
      catch { setAuthError('Could not connect to Spotify. Please try again.'); setReady(true); return; }
      if (t) {
        try { setUser(await spGet('/me', t)); setToken(t); }
        catch (e) {
          clearTokens(CLIENT_ID);
          setAuthError(e.status === 403
            ? `Spotify refused access (403: ${e.message}). This Spotify app is in Development Mode — the account must be added under User Management in the Spotify dashboard.`
            : `Spotify error${e.status ? ` (${e.status})` : ''}: ${e.message}`);
        }
      }
      setReady(true);
    })();
  }, []);

  const header = (
    <div style={s.header}>
      <h1 style={s.title}>Better Spotify</h1>
      <p style={s.subtitle}>Your podcasts and music, sorted the way Spotify won’t.</p>
    </div>
  );

  if (!CLIENT_ID) {
    return (
      <div style={s.page}>
        {header}
        <div style={s.error}><strong>Setup required:</strong> Add <code>VITE_SPOTIFY_BETTER_CLIENT_ID</code> to <code>.env.local</code>.</div>
      </div>
    );
  }

  if (!token) {
    return (
      <div style={s.page}>
        {header}
        {ready && (
          <div style={s.connectWrap}>
            {authError && <div style={s.error}>{authError}</div>}
            <button style={s.connectBtn} onClick={() => startAuth('/better-spotify', CLIENT_ID)}><SpotifyIcon /> Connect with Spotify</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={s.page}>
      {header}

      {user && (
        <div style={s.userBar}>
          {user.images?.[0]?.url && <img src={user.images[0].url} alt="" style={s.avatar} />}
          <span style={s.userName}>{user.display_name}</span>
          <button style={s.disconnectBtn} onClick={() => {
            player.close(); clearTokens(CLIENT_ID); localStorage.removeItem(EPS_CACHE_KEY); localStorage.removeItem(SHOWS_CACHE_KEY); localStorage.removeItem(MUSIC_RECS_KEY); setToken(null); setUser(null);
          }}>Disconnect</button>
        </div>
      )}

      <div style={s.tabs} role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} style={s.tab(tab === id)} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'podcasts' && <PodcastsTab onPlay={onPlay} />}
      {tab === 'music' && <MusicTab view={musicView} setView={setMusicView} onPlay={onPlay} player={player} />}
      <PlayerBar player={player} mobile={mobile} />
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function SpotifyIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.371-.721.49-1.101.241-3.021-1.858-6.832-2.278-11.322-1.237-.43.101-.86-.18-.96-.61-.101-.43.18-.86.61-.96 4.91-1.12 9.122-.641 12.512 1.43.38.241.5.721.261 1.136zm1.47-3.27c-.3.461-.93.6-1.39.3-3.461-2.13-8.732-2.750-12.821-1.51-.521.15-1.061-.15-1.211-.671-.15-.521.15-1.061.671-1.211 4.68-1.42 10.5-.73 14.49 1.72.461.3.6.93.261 1.372zm.13-3.41C15.24 8.4 8.820 8.19 5.16 9.301c-.621.18-1.271-.18-1.450-.8-.181-.62.18-1.271.8-1.45 4.23-1.28 11.26-1.03 15.69 1.75.54.33.71 1.03.38 1.57-.33.541-1.03.71-1.57.38z"/>
    </svg>
  );
}

function CloseIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function PrevIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
  );
}

function NextIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
  );
}

function PauseIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
  );
}

function PlayIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = {
  page: { maxWidth: 760, margin: '0 auto', padding: '56px 20px 96px', fontFamily: 'var(--font-body)' },
  header: { marginBottom: 40, textAlign: 'center' },
  title: {
    fontFamily: 'var(--font-display)', fontSize: 42, fontWeight: 700,
    margin: '0 0 6px', color: 'var(--color-text)', letterSpacing: '-0.01em',
  },
  subtitle: { color: 'var(--color-text-muted)', margin: 0, fontSize: 16, lineHeight: 1.5 },
  connectWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, marginTop: 40 },
  connectBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    background: '#1DB954', color: '#fff', border: 'none', borderRadius: 28,
    padding: '14px 32px', fontSize: 15, fontWeight: 600, cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(29,185,84,0.3)',
  },
  error: {
    background: '#fdf0ec', border: '1px solid #f0c8b8', color: '#8a3b1a',
    borderRadius: 10, padding: '12px 16px', fontSize: 14,
  },
  userBar: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28,
    padding: '10px 16px', background: 'var(--color-surface)',
    border: '1px solid var(--color-border)', borderRadius: 100,
  },
  avatar: { width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' },
  userName: { flex: 1, fontWeight: 500, fontSize: 13, color: 'var(--color-text-muted)' },
  disconnectBtn: {
    background: 'none', border: 'none', padding: '4px 10px', fontSize: 12,
    color: 'var(--color-text-muted)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2,
  },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 32 },
  tab: active => ({
    background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)',
    padding: '10px 18px', fontSize: 15, fontWeight: active ? 600 : 500,
    color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
    borderBottom: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`, marginBottom: -1,
  }),
  subTabBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
  subTabs: { display: 'inline-flex', gap: 4, padding: 4, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 100 },
  subTab: active => ({
    border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)', borderRadius: 100,
    padding: '7px 16px', fontSize: 14, fontWeight: 600,
    background: active ? 'var(--color-accent)' : 'transparent',
    color: active ? '#fff' : 'var(--color-text-muted)',
  }),
  debug: { fontSize: 12, marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'ui-monospace, monospace' },
  recsHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, margin: '4px 0 16px' },
  recSection: { marginBottom: 36 },
  recSectionHead: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12 },
  recSectionLabel: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-muted)' },
  recSectionTitle: { fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: 'var(--color-text)', lineHeight: 1.25 },
  recSectionShow: { fontSize: 13, color: 'var(--color-accent)', fontWeight: 500 },
  subTabCount: active => ({ fontWeight: 500, opacity: active ? 0.85 : 0.7 }),
  sectionSub: { color: 'var(--color-text-muted)', fontSize: 13, margin: '4px 0 16px' },
  sectionSubTight: { color: 'var(--color-text-muted)', fontSize: 13 },
  dismissableRow: { display: 'flex', alignItems: 'center', gap: 4 },
  rowDismissBtn: {
    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)',
    padding: '10px 6px 10px 8px', display: 'flex', alignItems: 'center', flexShrink: 0,
  },
  muted: { color: 'var(--color-text-muted)', fontSize: 14, padding: '16px 0' },
  linkBtn: {
    background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer',
    fontSize: 13, fontWeight: 500, padding: 0,
  },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  episode: played => ({
    display: 'flex', alignItems: 'center', gap: 14, width: '100%', textAlign: 'left',
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderLeft: '4px solid var(--color-accent)', borderRadius: 10, padding: 12,
    cursor: 'pointer', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
    opacity: played ? 0.6 : 1,
  }),
  epArt: { width: 64, height: 64, borderRadius: 8, objectFit: 'cover', flexShrink: 0, background: 'var(--color-border)' },
  epBody: { flex: 1, minWidth: 0 },
  trackRow: {
    display: 'flex', alignItems: 'stretch', background: 'var(--color-surface)',
    border: '1px solid var(--color-border)', borderLeft: '4px solid var(--color-accent)', borderRadius: 10,
  },
  trackMain: {
    display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0, textAlign: 'left',
    background: 'none', border: 'none', padding: '12px 4px 12px 12px',
    cursor: 'pointer', fontFamily: 'var(--font-body)', color: 'var(--color-text)',
  },
  dismissBtn: {
    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)',
    padding: '0 14px 0 10px', display: 'flex', alignItems: 'center', flexShrink: 0,
  },
  trackArt: { width: 56, height: 56, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: 'var(--color-border)' },
  trackTitle: { fontSize: 15, fontWeight: 600, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  trackArtist: { fontSize: 13, color: 'var(--color-text)', margin: '1px 0 3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  trackAlbum: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 },
  epShow: {
    fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: 'var(--color-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  epTitle: {
    fontSize: 15, fontWeight: 600, lineHeight: 1.3, margin: '2px 0 4px',
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  epMeta: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--color-text-muted)', flexWrap: 'wrap' },
  playedBadge: {
    marginLeft: 4, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
    padding: '1px 6px', borderRadius: 4, background: 'var(--color-border)',
  },
  progressTrack: { height: 3, background: 'var(--color-border)', borderRadius: 2, marginTop: 6, maxWidth: 220 },
  progressFill: { height: '100%', background: 'var(--color-accent)', borderRadius: 2 },
  playIcon: {
    width: 34, height: 34, borderRadius: '50%', background: '#1DB954', color: '#fff', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  showList: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, overflow: 'hidden',
  },
  showRow: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
    borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap',
  },
  showLink: {
    display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 220px', minWidth: 0,
    textDecoration: 'none', color: 'var(--color-text)',
  },
  showArt: { width: 44, height: 44, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: 'var(--color-border)' },
  showName: { fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  showPublisher: { fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  latestBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flex: '0 1 240px', minWidth: 0,
    background: 'none', border: 'none', cursor: 'pointer', textAlign: 'right', padding: 0, fontFamily: 'var(--font-body)',
  },
  latestDate: { fontSize: 12, fontWeight: 600, color: 'var(--color-accent)' },
  latestName: {
    fontSize: 12, color: 'var(--color-text-muted)', maxWidth: '100%',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  playerBar: {
    position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1000,
    background: 'var(--color-surface)', borderTop: '1px solid var(--color-border)',
    boxShadow: '0 -6px 20px rgba(0,0,0,0.08)',
    padding: '10px 16px calc(10px + env(safe-area-inset-bottom, 0px))',
  },
  playerInner: { maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 6 },
  playerError: { fontSize: 12, color: '#8a3b1a' },
  playerRow: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 },
  playerArt: { width: 44, height: 44, borderRadius: 6, objectFit: 'cover', flexShrink: 0 },
  playerText: { flex: 1, minWidth: 0 },
  playerTitle: { fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  playerSubtitle: { fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  playerControls: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  bigPlayBtn: {
    width: 40, height: 40, borderRadius: '50%', border: 'none', background: '#1DB954', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  },
  skipBtn: {
    background: 'none', border: '1px solid var(--color-border)', borderRadius: 100, padding: '4px 8px',
    fontSize: 12, fontWeight: 600, cursor: 'pointer', color: 'var(--color-text)', fontFamily: 'var(--font-body)',
  },
  embedSkips: { flex: 1, display: 'flex', gap: 6 },
  playerFoot: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 },
  playerTime: { color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 },
  seekBar: { flex: 1, minWidth: 0, accentColor: '#1DB954' },
  openLink: { color: 'var(--color-accent)', fontWeight: 600, textDecoration: 'none', flexShrink: 0 },
  closeBtn: {
    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)',
    padding: 4, display: 'flex', alignItems: 'center', flexShrink: 0,
  },
  embedBox: { borderRadius: 12, overflow: 'hidden' },
  // Phone layout: a tall panel, about half the screen.
  mPlayerBar: {
    borderRadius: '18px 18px 0 0',
    padding: '10px 18px calc(14px + env(safe-area-inset-bottom, 0px))',
  },
  mInner: { display: 'flex', flexDirection: 'column', gap: 10 },
  mBottom: { display: 'flex', flexDirection: 'column', gap: 10 },
  mHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 14 },
  mHeadRight: { display: 'flex', alignItems: 'center', gap: 12 },
  speedBtn: {
    minWidth: 52, background: 'none', border: '1px solid var(--color-border)', borderRadius: 100, padding: '5px 10px',
    fontSize: 13, fontWeight: 700, cursor: 'pointer', color: 'var(--color-text)', fontFamily: 'var(--font-body)',
    fontVariantNumeric: 'tabular-nums', flexShrink: 0,
  },
  mInfo: { display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 },
  mArt: { width: 72, height: 72, borderRadius: 10, objectFit: 'cover', flexShrink: 0 },
  mTitle: { fontSize: 16, fontWeight: 600, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  mSubtitle: { fontSize: 14, color: 'var(--color-text-muted)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  mControls: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20 },
  mPlayBtn: {
    width: 64, height: 64, borderRadius: '50%', border: 'none', background: '#1DB954', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
  },
  mSkipBtn: {
    width: 52, height: 52, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
    fontSize: 16, fontWeight: 600, color: 'var(--color-text)', fontFamily: 'var(--font-body)', padding: 0,
  },
};
