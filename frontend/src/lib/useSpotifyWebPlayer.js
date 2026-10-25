// In-page playback, so tracks/episodes play here instead of in the Spotify app.
// Each item plays from one of two sources:
//  - 'audio':   podcast episodes whose audio file was found in the show's public feed
//               (options.findAudio) play in a plain <audio> element: playback speed,
//               lock-screen controls, same behaviour on every browser.
//  - 'spotify': everything else, through one of two engines:
//     - 'sdk':   Web Playback SDK — the page becomes a Spotify Connect device and plays in
//                full. Needs Premium and a browser Spotify supports (not iOS).
//     - 'embed': Spotify iFrame embed — fallback everywhere else. Podcast episodes play in
//                full; songs play in full only when this browser is logged in to
//                open.spotify.com, otherwise as 30-second previews.
import { useState, useEffect, useRef, useCallback } from 'react';

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';
const EMBED_SRC = 'https://open.spotify.com/embed/iframe-api/v1';
const SDK_TIMEOUT_MS = 10_000;
const PROGRESS_EVERY_MS = 5_000;
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SDK_SUPPORTED = !IS_IOS && !!navigator.requestMediaKeySystemAccess;

// Playback speeds for feed audio, in the order the speed button cycles through.
export const RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];
const RATE_KEY = 'bs_play_rate';
// An empty WAV, played inside the click so the browser lets this <audio> element start
// the real file afterwards (finding it is async, and mobile browsers only allow audio
// to start from a tap).
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readRate() {
  try {
    const r = Number(localStorage.getItem(RATE_KEY));
    return RATES.includes(r) ? r : 1;
  } catch { return 1; }
}

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

// large (phones): the 152px embed for songs too, which has a bigger play button than the 80px one.
export function embedHeight(item, large = false) {
  if (large) return 152;
  return isEpisode(item) ? 152 : 80;
}

// Title/artist/artwork for the lock screen.
function mediaInfo(item) {
  const images = item.images?.length ? item.images : item._show?.images?.length ? item._show.images : item.album?.images || [];
  return {
    title: item.name || '',
    artist: item._show?.name || item.artists?.map(a => a.name).join(', ') || '',
    artwork: images.filter(i => i?.url).map(i => ({ src: i.url, ...(i.width ? { sizes: `${i.width}x${i.height}` } : {}) })),
  };
}

// getAccessToken: stable async () => token | null, called whenever a fresh token is needed.
// onProgress(uri, positionMs, durationMs): called every few seconds while playing and on
// pause/close/page hide, so the page can remember where you are (the embed and feed audio
// don't save progress to your Spotify account, and the SDK's saves take a while to show up).
// options.large: use the bigger embed (see embedHeight).
// options.findAudio(item) => Promise<url | null>: an episode's audio file, to play it as
// feed audio; options.forgetAudio(item): that URL failed to play.
// play(item, queue?): with a queue (array of tracks containing item), playback carries on
// through the rest of the queue and next()/prev() step through it.
export function useSpotifyWebPlayer(getAccessToken, onProgress, { large = false, findAudio = null, forgetAudio = null } = {}) {
  const [engine, setEngine] = useState(SDK_SUPPORTED ? 'pending' : 'embed');
  const [item, setItem] = useState(null);
  const [queue, setQueue] = useState(null);
  const [source, setSource] = useState(null); // current item: 'resolving' | 'audio' | 'spotify'
  const [rate, setRateState] = useState(readRate);
  // sdk/audio: { paused, position, duration, at, uri, rate }
  const [state, setState] = useState(null);
  const [error, setError] = useState('');

  const stateRef = useRef(null);
  const engineRef = useRef(engine);
  const playerRef = useRef(null);
  const deviceRef = useRef(null);
  const decided = useRef(null);
  const controllerRef = useRef(null);
  const embedElRef = useRef(null);
  const pendingSeek = useRef(0);
  const embedPos = useRef(null); // last embed playback_update: { position, duration, paused, at }
  const itemRef = useRef(null);
  const queueRef = useRef(null);
  const sourceRef = useRef(null);
  const audioRef = useRef(null);
  const audioSeek = useRef(0);
  const rateRef = useRef(rate);
  const playToken = useRef(0);
  const fallbackRef = useRef(null);
  const onProgressRef = useRef(onProgress);
  const findAudioRef = useRef(findAudio);
  const forgetAudioRef = useRef(forgetAudio);
  const lastReport = useRef({ uri: null, at: 0, paused: null });
  const largeRef = useRef(large);
  useEffect(() => {
    onProgressRef.current = onProgress;
    findAudioRef.current = findAudio;
    forgetAudioRef.current = forgetAudio;
  });
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { itemRef.current = item; }, [item]);
  // Resize a live embed when switching between phone and wider layouts.
  useEffect(() => {
    largeRef.current = large;
    const iframe = embedElRef.current?.querySelector('iframe');
    if (iframe && itemRef.current) iframe.height = String(embedHeight(itemRef.current, large));
  }, [large]);

  const changeSource = useCallback(src => { sourceRef.current = src; setSource(src); }, []);

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
        if (sourceRef.current === 'audio') return; // feed audio owns the state
        if (!st) { setState(null); return; }
        const uri = st.track_window?.current_track?.uri;
        setState({ paused: st.paused, position: st.position, duration: st.duration, at: Date.now(), uri, rate: 1 });
        report(uri, st.position, st.duration, st.paused);
        // Spotify advanced through the queue on its own: follow it.
        const q = queueRef.current?.find(t => t.uri === uri);
        if (q && itemRef.current?.uri !== uri) setItem(q);
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
      if (sourceRef.current === 'audio') return;
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

  // Feed audio: one <audio> element for the page's lifetime.
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;
    const live = () => sourceRef.current === 'audio' && audio.src && audio.src !== SILENCE;
    const sync = () => {
      if (!live()) return;
      const uri = itemRef.current?.uri;
      const duration = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
      const position = audio.currentTime * 1000;
      setState({ paused: audio.paused, position, duration, at: Date.now(), uri, rate: audio.playbackRate });
      report(uri, position, duration, audio.paused);
    };
    const onMeta = () => {
      if (!live()) return;
      if (audioSeek.current) { audio.currentTime = audioSeek.current / 1000; audioSeek.current = 0; }
      audio.playbackRate = rateRef.current;
      sync();
    };
    const onError = () => { if (live()) fallbackRef.current?.(); };
    const events = ['play', 'pause', 'timeupdate', 'seeked', 'ended', 'ratechange', 'durationchange'];
    events.forEach(e => audio.addEventListener(e, sync));
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('error', onError);
    return () => {
      events.forEach(e => audio.removeEventListener(e, sync));
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('error', onError);
      audio.pause();
      audio.removeAttribute('src');
      audioRef.current = null;
    };
  }, [report]);

  // Embed only: move to the next/previous queue item (the effect below loads it).
  const advance = useCallback(step => {
    const q = queueRef.current;
    const i = q ? q.findIndex(t => t.uri === itemRef.current?.uri) : -1;
    if (i >= 0 && q[i + step]) setItem(q[i + step]);
  }, []);

  // Embed engine: create the controller once its element is mounted, then load each item.
  useEffect(() => {
    if (engine !== 'embed' || !item || source !== 'spotify') return;
    let cancelled = false;
    pendingSeek.current = resumeMs(item);
    embedPos.current = null;
    (async () => {
      let api;
      try { api = await loadEmbedApi(); } catch (e) { if (!cancelled) setError(e.message); return; }
      if (cancelled || !embedElRef.current) return;
      const height = embedHeight(item, largeRef.current);
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
  }, [engine, item, source, report, advance]);

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

  // Play through Spotify (the SDK directly; the embed via its effect once source is 'spotify').
  const playSpotify = useCallback(async it => {
    changeSource('spotify');
    const eng = engineRef.current === 'pending' ? await decided.current : engineRef.current;
    if (eng === 'sdk') await playSdk(it);
  }, [changeSource, playSdk]);

  // Feed audio failed to load: forget that URL and play the episode through Spotify.
  useEffect(() => {
    fallbackRef.current = () => {
      const it = itemRef.current;
      audioRef.current?.pause();
      if (!it) return;
      forgetAudioRef.current?.(it);
      playSpotify(it);
    };
  }, [playSpotify]);

  // Save the latest known position (on close, switching items, and when the page is hidden).
  const flush = useCallback(() => {
    const it = itemRef.current;
    if (!it) return;
    const audio = audioRef.current;
    if (sourceRef.current === 'audio') {
      if (audio?.src && audio.src !== SILENCE && Number.isFinite(audio.duration)) {
        report(it.uri, audio.currentTime * 1000, audio.duration * 1000, audio.paused, true);
      }
    } else if (engineRef.current === 'sdk') {
      const st = stateRef.current;
      if (st?.uri === it.uri) {
        report(st.uri, st.paused ? st.position : st.position + (Date.now() - st.at), st.duration, st.paused, true);
      }
    } else {
      const p = embedPos.current;
      if (p) report(it.uri, p.paused ? p.position : p.position + (Date.now() - p.at), p.duration, p.paused, true);
    }
  }, [report]);

  const play = useCallback(async (it, q = null) => {
    setError('');
    flush();
    const token = ++playToken.current;
    queueRef.current = q;
    setQueue(q);
    // Both must run inside the click so mobile/Safari allow audio to start.
    playerRef.current?.activateElement?.();
    const audio = audioRef.current;
    const find = isEpisode(it) && findAudioRef.current;
    audio.pause();
    if (find) {
      audio.src = SILENCE;
      audio.play().catch(() => {});
      // The embed's iframe is unmounted while we look; it's recreated if we fall back.
      controllerRef.current?.destroy?.();
      controllerRef.current = null;
      embedPos.current = null;
      changeSource('resolving');
    }
    setItem(it);
    if (find) {
      const url = await find(it).catch(() => null);
      if (token !== playToken.current) return; // another item was picked meanwhile
      if (url) {
        if (engineRef.current === 'sdk') playerRef.current?.pause();
        changeSource('audio');
        audioSeek.current = resumeMs(it);
        audio.defaultPlaybackRate = rateRef.current;
        audio.src = url;
        audio.playbackRate = rateRef.current;
        audio.play().catch(e => { if (e.name === 'NotAllowedError') setError('Tap play to start.'); });
        return;
      }
      audio.pause();
    }
    await playSpotify(it);
  }, [flush, changeSource, playSpotify]);

  const resume = useCallback(() => {
    if (sourceRef.current === 'audio') audioRef.current?.play().catch(() => {});
    else if (engineRef.current === 'sdk') playerRef.current?.resume();
    else controllerRef.current?.resume?.();
  }, []);

  const pause = useCallback(() => {
    if (sourceRef.current === 'audio') audioRef.current?.pause();
    else if (engineRef.current === 'sdk') playerRef.current?.pause();
    else controllerRef.current?.pause?.();
  }, []);

  const togglePlay = useCallback(() => {
    if (sourceRef.current === 'audio') {
      const a = audioRef.current;
      if (a.paused) a.play().catch(() => {}); else a.pause();
    } else if (engineRef.current === 'sdk') playerRef.current?.togglePlay();
    else controllerRef.current?.togglePlay?.();
  }, []);

  const seek = useCallback(ms => {
    if (sourceRef.current === 'audio') { audioRef.current.currentTime = Math.max(0, ms) / 1000; return; }
    if (engineRef.current === 'sdk') { playerRef.current?.seek(Math.max(0, ms)); return; }
    const c = controllerRef.current, p = embedPos.current;
    if (!c) return;
    if (p) embedPos.current = { ...p, position: Math.max(0, ms), at: Date.now() };
    c.seek(Math.max(0, ms) / 1000);
  }, []);

  // Jump forward/back by deltaMs from the current position, on any source.
  const skip = useCallback(async deltaMs => {
    if (sourceRef.current === 'audio') {
      const a = audioRef.current;
      const end = Number.isFinite(a.duration) ? a.duration : Infinity;
      a.currentTime = Math.min(end, Math.max(0, a.currentTime + deltaMs / 1000));
      return;
    }
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

  // Playback speed (feed audio only), remembered across visits.
  const setRate = useCallback(r => {
    rateRef.current = r;
    setRateState(r);
    try { localStorage.setItem(RATE_KEY, String(r)); } catch { /* ignore */ }
    const a = audioRef.current;
    if (a) { a.defaultPlaybackRate = r; a.playbackRate = r; }
  }, []);

  // Step through the queue (no-op without one).
  const step = useCallback(dir => {
    const q = queueRef.current;
    const i = q ? q.findIndex(t => t.uri === itemRef.current?.uri) : -1;
    if (i >= 0 && q[i + dir]) play(q[i + dir], q);
  }, [play]);
  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

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
    ++playToken.current;
    if (engineRef.current === 'sdk') playerRef.current?.pause();
    const a = audioRef.current;
    if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
    controllerRef.current?.destroy?.();
    controllerRef.current = null;
    embedPos.current = null;
    queueRef.current = null;
    changeSource(null);
    setItem(null);
    setState(null);
    setQueue(null);
    setError('');
  }, [flush, changeSource]);

  // Lock screen / notification / headset controls.
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ } };
    if (!item) {
      ms.metadata = null;
      ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].forEach(a => set(a, null));
      return;
    }
    if (window.MediaMetadata) ms.metadata = new window.MediaMetadata(mediaInfo(item));
    const episode = isEpisode(item);
    set('play', resume);
    set('pause', pause);
    // Episodes get ±15s; queued songs get previous/next (lock screens show one or the other).
    set('seekbackward', episode ? () => skip(-15_000) : null);
    set('seekforward', episode ? () => skip(15_000) : null);
    set('seekto', d => seek(d.seekTime * 1000));
    set('previoustrack', !episode && queue ? prev : null);
    set('nexttrack', !episode && queue ? next : null);
  }, [item, queue, resume, pause, skip, seek, prev, next]);

  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms || !state || state.uri !== item?.uri) return;
    ms.playbackState = state.paused ? 'paused' : 'playing';
    if (state.duration > 0) {
      try {
        ms.setPositionState({
          duration: state.duration / 1000,
          position: Math.min(state.position, state.duration) / 1000,
          playbackRate: state.rate || 1,
        });
      } catch { /* unsupported or out of range */ }
    }
  }, [state, item]);

  return {
    engine, source, item, queue, state, error, rate,
    play, togglePlay, next, prev, seek, skip, setRate, close, embedElRef,
  };
}
