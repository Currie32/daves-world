// In-page Spotify playback, so tracks/episodes play here instead of in the Spotify app.
// Two engines:
//  - 'sdk':   Web Playback SDK — the page becomes a Spotify Connect device and plays in
//             full. Needs Premium and a browser Spotify supports (not iOS).
//  - 'embed': Spotify iFrame embed — fallback everywhere else. Podcast episodes play in
//             full; songs play in full only when this browser is logged in to
//             open.spotify.com, otherwise as 30-second previews.
import { useState, useEffect, useRef, useCallback } from 'react';

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';
const EMBED_SRC = 'https://open.spotify.com/embed/iframe-api/v1';
const SDK_TIMEOUT_MS = 10_000;
const PROGRESS_EVERY_MS = 5_000;
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SDK_SUPPORTED = !IS_IOS && !!navigator.requestMediaKeySystemAccess;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let sdkPromise = null;
function loadSdk() {
  if (window.Spotify) return Promise.resolve(window.Spotify);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const prev = window.onSpotifyWebPlaybackSDKReady;
      window.onSpotifyWebPlaybackSDKReady = () => { prev?.(); resolve(window.Spotify); };
      if (!document.getElementById('spotify-sdk')) {
        const script = document.createElement('script');
        script.id = 'spotify-sdk';
        script.src = SDK_SRC;
        script.async = true;
        script.onerror = () => { sdkPromise = null; reject(new Error('SDK failed to load')); };
        document.body.appendChild(script);
      }
    });
  }
  return sdkPromise;
}

let embedPromise = null;
function loadEmbedApi() {
  if (!embedPromise) {
    embedPromise = new Promise((resolve, reject) => {
      window.onSpotifyIframeApiReady = api => resolve(api);
      const script = document.createElement('script');
      script.src = EMBED_SRC;
      script.async = true;
      script.onerror = () => { embedPromise = null; reject(new Error('Could not load the Spotify player.')); };
      document.body.appendChild(script);
    });
  }
  return embedPromise;
}

function resumeMs(item) {
  const r = item.resume_point;
  return r && !r.fully_played && r.resume_position_ms > 0 ? r.resume_position_ms : 0;
}

// Cached episodes don't keep `type`, so go by the URI.
export function isEpisode(item) {
  return !!item?.uri?.startsWith('spotify:episode:');
}

export function embedHeight(item) {
  return isEpisode(item) ? 152 : 80;
}

// getAccessToken: stable async () => token | null, called whenever a fresh token is needed.
// play(item, queue?): with a queue (array of tracks containing item), playback carries on
// through the rest of the queue and next()/prev() step through it.
// onProgress(uri, positionMs, durationMs): called every few seconds while playing and on
// pause/close/page hide, so the page can remember where you are (the embed player doesn't
// save progress to your Spotify account, and the SDK's saves take a while to show up).
export function useSpotifyWebPlayer(getAccessToken, onProgress) {
  const [engine, setEngine] = useState(SDK_SUPPORTED ? 'pending' : 'embed');
  const [item, setItem] = useState(null);
  const [queue, setQueue] = useState(null);
  const queueRef = useRef(null);
  const [state, setState] = useState(null); // sdk only: { paused, position, duration, at, uri }
  const stateRef = useRef(null);
  useEffect(() => { stateRef.current = state; }, [state]);
  const [error, setError] = useState('');

  const engineRef = useRef(engine);
  const playerRef = useRef(null);
  const deviceRef = useRef(null);
  const decided = useRef(null);
  const controllerRef = useRef(null);
  const embedElRef = useRef(null);
  const pendingSeek = useRef(0);
  const embedPos = useRef(null); // last embed playback_update: { position, duration, paused, at }
  const itemRef = useRef(null);
  const onProgressRef = useRef(onProgress);
  const lastReport = useRef({ uri: null, at: 0, paused: null });
  useEffect(() => { onProgressRef.current = onProgress; });
  useEffect(() => { itemRef.current = item; }, [item]);

  // Throttled: always on a pause/resume change or `force`, otherwise every few seconds.
  // Ignores the first second (players report 0 before jumping to the resume point).
  const report = useCallback((uri, position, duration, paused, force = false) => {
    if (!uri || !(duration > 0) || position < 1000 || pendingSeek.current) return;
    const last = lastReport.current;
    const now = Date.now();
    if (!force && last.uri === uri && last.paused === paused && now - last.at < PROGRESS_EVERY_MS) return;
    lastReport.current = { uri, at: now, paused };
    onProgressRef.current?.(uri, position, duration);
  }, []);

  const switchToEmbed = useCallback(() => {
    playerRef.current?.disconnect();
    playerRef.current = null;
    deviceRef.current = null;
    engineRef.current = 'embed';
    setEngine('embed');
  }, []);

  // Try the SDK; fall back to the embed on any error or if it isn't ready in time.
  useEffect(() => {
    if (!SDK_SUPPORTED) { decided.current = Promise.resolve('embed'); return; }
    let cancelled = false;
    let resolveDecision;
    decided.current = new Promise(r => { resolveDecision = r; });
    const decide = eng => {
      if (!resolveDecision) return;
      resolveDecision(eng);
      resolveDecision = null;
      clearTimeout(timer);
      if (eng === 'embed') switchToEmbed();
      else { engineRef.current = 'sdk'; setEngine('sdk'); }
    };
    const timer = setTimeout(() => decide('embed'), SDK_TIMEOUT_MS);

    loadSdk().then(Spotify => {
      if (cancelled) return;
      const p = new Spotify.Player({
        name: "Dave's World",
        getOAuthToken: cb => { getAccessToken().then(t => t && cb(t)); },
        volume: 0.8,
      });
      playerRef.current = p;
      p.addListener('ready', ({ device_id }) => { deviceRef.current = device_id; decide('sdk'); });
      p.addListener('not_ready', () => { deviceRef.current = null; });
      // account_error = not Premium. Any of these means the SDK can't play here,
      // whether it happens before or after 'ready'.
      ['initialization_error', 'authentication_error', 'account_error'].forEach(ev =>
        p.addListener(ev, ({ message }) => {
          console.warn(`[player] ${ev}:`, message);
          if (resolveDecision) decide('embed'); else switchToEmbed();
        }));
      p.addListener('player_state_changed', st => {
        if (!st) { setState(null); return; }
        const uri = st.track_window?.current_track?.uri;
        setState({ paused: st.paused, position: st.position, duration: st.duration, at: Date.now(), uri });
        // Spotify advanced through the queue on its own: follow it.
        const q = queueRef.current?.find(t => t.uri === uri);
        if (q && itemRef.current?.uri !== uri) setItem(q);
        report(uri, st.position, st.duration, st.paused);
      });
      p.connect();
    }).catch(() => decide('embed'));

    // Phones drop the connection when the screen locks; reconnect on return.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && playerRef.current && !deviceRef.current) playerRef.current.connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    // player_state_changed only fires on changes, so poll for position while playing.
    const poll = setInterval(async () => {
      const st = await playerRef.current?.getCurrentState?.();
      if (st && !st.paused) report(st.track_window?.current_track?.uri, st.position, st.duration, st.paused);
    }, PROGRESS_EVERY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      playerRef.current?.disconnect();
      playerRef.current = null;
      deviceRef.current = null;
      controllerRef.current?.destroy?.();
      controllerRef.current = null;
    };
  }, [switchToEmbed, getAccessToken, report]);

  // Embed only: move to the next/previous queue item (the effect below loads it).
  const advance = useCallback(step => {
    const q = queueRef.current;
    const i = q ? q.findIndex(t => t.uri === itemRef.current?.uri) : -1;
    if (i >= 0 && q[i + step]) setItem(q[i + step]);
  }, []);

  // Embed engine: create the controller once its element is mounted, then load each item.
  useEffect(() => {
    if (engine !== 'embed' || !item) return;
    let cancelled = false;
    pendingSeek.current = resumeMs(item);
    embedPos.current = null;
    (async () => {
      let api;
      try { api = await loadEmbedApi(); } catch (e) { if (!cancelled) setError(e.message); return; }
      if (cancelled || !embedElRef.current) return;
      const height = embedHeight(item);
      if (controllerRef.current) {
        const iframe = embedElRef.current.querySelector('iframe');
        if (iframe) iframe.height = String(height);
        controllerRef.current.loadUri(item.uri);
        controllerRef.current.play();
        return;
      }
      const el = document.createElement('div');
      embedElRef.current.replaceChildren(el);
      let wasPaused = true;
      api.createController(el, { uri: item.uri, width: '100%', height }, c => {
        if (cancelled) { c.destroy?.(); return; }
        controllerRef.current = c;
        c.addListener('ready', () => c.play());
        c.addListener('playback_update', e => {
          const { isPaused, position, duration } = e.data || {};
          embedPos.current = { position, duration, paused: isPaused, at: Date.now() };
          // Jump to the episode's resume point once it has started playing.
          if (pendingSeek.current && !isPaused && duration > 0) {
            const to = pendingSeek.current;
            pendingSeek.current = 0;
            if (position < to - 5000) { c.seek(to / 1000); return; }
          }
          report(e.data?.playingURI || itemRef.current?.uri, position, duration, isPaused);
          // The embed plays one item at a time, so advance through the queue ourselves.
          if (!wasPaused && isPaused && duration > 0 && position >= duration - 1500) advance(1);
          wasPaused = isPaused;
        });
      });
    })();
    return () => { cancelled = true; };
  }, [engine, item, report, advance]);

  const playSdk = useCallback(async it => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!deviceRef.current) {
        await playerRef.current?.connect();
        for (let i = 0; i < 20 && !deviceRef.current; i++) await sleep(250);
        if (!deviceRef.current) break;
      }
      const token = await getAccessToken();
      if (!token) { setError('Spotify session expired — reconnect.'); return; }
      const q = queueRef.current;
      const body = q ? { uris: q.map(t => t.uri), offset: { uri: it.uri } } : { uris: [it.uri] };
      const pos = resumeMs(it);
      if (pos) body.position_ms = pos;
      const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceRef.current}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return;
      if (res.status === 403) break; // Premium required — use the embed instead.
      if (res.status === 404) { deviceRef.current = null; continue; } // device went away; reconnect
      const err = await res.json().catch(() => ({}));
      setError(`Couldn't start playback: ${err?.error?.message || res.statusText}`);
      return;
    }
    switchToEmbed();
  }, [switchToEmbed, getAccessToken]);

  const play = useCallback(async (it, q = null) => {
    setError('');
    queueRef.current = q;
    setQueue(q);
    // Must run inside the click so mobile/Safari allow audio to start.
    playerRef.current?.activateElement?.();
    setItem(it);
    const eng = engineRef.current === 'pending' ? await decided.current : engineRef.current;
    if (eng === 'sdk') await playSdk(it);
    // 'embed' is handled by the effect above once `item` renders.
  }, [playSdk]);

  const togglePlay = useCallback(() => {
    if (engineRef.current === 'sdk') playerRef.current?.togglePlay();
    else controllerRef.current?.togglePlay?.();
  }, []);

  // Step through the queue (no-op without one).
  const step = useCallback(dir => {
    const q = queueRef.current;
    const i = q ? q.findIndex(t => t.uri === itemRef.current?.uri) : -1;
    if (i >= 0 && q[i + dir]) play(q[i + dir], q);
  }, [play]);
  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);
  const seek = useCallback(ms => { playerRef.current?.seek(Math.max(0, ms)); }, []);

  // Jump forward/back by deltaMs from the current position, on either engine.
  const skip = useCallback(async deltaMs => {
    if (engineRef.current === 'sdk') {
      const st = await playerRef.current?.getCurrentState();
      if (st) playerRef.current.seek(Math.min(st.duration, Math.max(0, st.position + deltaMs)));
      return;
    }
    const c = controllerRef.current, p = embedPos.current;
    if (!c || !p) return;
    const now = p.paused ? p.position : p.position + (Date.now() - p.at);
    const to = Math.min(p.duration || Infinity, Math.max(0, now + deltaMs));
    embedPos.current = { ...p, position: to, at: Date.now() };
    c.seek(to / 1000);
  }, []);

  // Save the latest known position (on close, and when the page is hidden or unloaded).
  const flush = useCallback(() => {
    const it = itemRef.current;
    if (!it) return;
    if (engineRef.current === 'sdk') {
      const st = stateRef.current;
      if (st?.uri === it.uri) {
        report(st.uri, st.paused ? st.position : st.position + (Date.now() - st.at), st.duration, st.paused, true);
      }
    } else {
      const p = embedPos.current;
      if (p) report(it.uri, p.paused ? p.position : p.position + (Date.now() - p.at), p.duration, p.paused, true);
    }
  }, [report]);

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, [flush]);

  const close = useCallback(() => {
    flush();
    if (engineRef.current === 'sdk') playerRef.current?.pause();
    controllerRef.current?.destroy?.();
    controllerRef.current = null;
    embedPos.current = null;
    setItem(null);
    setState(null);
    queueRef.current = null;
    setQueue(null);
    setError('');
  }, [flush]);

  return { engine, item, queue, state, error, play, togglePlay, next, prev, seek, skip, close, embedElRef };
}
