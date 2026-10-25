// Finds a podcast episode's audio file in the show's public RSS feed (via the
// podcast_episode_audio Cloud Function), so Better Spotify can play it in a plain
// <audio> element — playback speed and lock-screen controls — instead of through Spotify.
// Results are cached per episode; "not found" is retried after a few days.
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from './firebase';

const CACHE_KEY = 'bs_feed_audio_v1';
const MISS_RETRY_MS = 3 * 86_400_000;
const MAX_ENTRIES = 300;
const TIMEOUT_MS = 15_000;

let callable = null;
const inFlight = new Map();

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
}

function writeEntry(id, entry) {
  const cache = readCache();
  if (entry) cache[id] = entry; else delete cache[id];
  const ids = Object.keys(cache);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => cache[a].at - cache[b].at).slice(0, ids.length - MAX_ENTRIES).forEach(k => delete cache[k]);
  }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* storage full */ }
}

// Resolves to the episode's audio URL, or null (no feed, no match, or the lookup failed).
export function findEpisodeAudio(ep) {
  const show = ep?._show;
  if (!ep?.id || !show?.name) return Promise.resolve(null);
  const hit = readCache()[ep.id];
  if (hit?.url) return Promise.resolve(hit.url);
  if (hit && Date.now() - hit.at < MISS_RETRY_MS) return Promise.resolve(null);
  if (inFlight.has(ep.id)) return inFlight.get(ep.id);

  callable ??= httpsCallable(getFunctions(app, 'us-west1'), 'podcast_episode_audio', { timeout: TIMEOUT_MS });
  const p = callable({
    show: show.name, publisher: show.publisher || '', title: ep.name,
    releaseDate: ep.release_date || '', durationMs: ep.duration_ms || 0,
  })
    .then(res => {
      const url = res.data?.url || null;
      writeEntry(ep.id, url ? { url, at: Date.now() } : { at: Date.now() });
      return url;
    })
    .catch(() => null) // network/timeout: not cached, so the next play tries again
    .finally(() => inFlight.delete(ep.id));
  inFlight.set(ep.id, p);
  return p;
}

// The cached file stopped working (moved or removed): look it up again next time.
export function forgetEpisodeAudio(ep) {
  if (ep?.id) writeEntry(ep.id, null);
}
