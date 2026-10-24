// Shared Spotify PKCE auth + Web API helpers.
// Tokens are stored per Spotify app (client ID); pages on the same app share a
// login. SCOPES is the union of what all pages need — changing it forces a re-auth.

export const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID || '';
const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',
  'playlist-modify-public', 'playlist-modify-private',
  'user-library-read', 'user-read-playback-position',
  'user-read-playback-state', 'user-modify-playback-state',
  'user-read-recently-played', 'user-top-read',
].join(' ');

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

// The redirect URI must be registered in the Spotify dashboard for each page.
export async function startAuth(path, clientId = CLIENT_ID) {
  const redirectUri = `${window.location.origin}${path}`;
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(await sha256(verifier));
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_redirect', redirectUri);
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri,
    scope: SCOPES, code_challenge_method: 'S256', code_challenge: challenge,
    show_dialog: 'true',
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function exchangeCode(code, clientId) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: sessionStorage.getItem('pkce_redirect') || `${window.location.origin}${window.location.pathname}`,
      client_id: clientId,
      code_verifier: sessionStorage.getItem('pkce_verifier'),
    }),
  });
  if (!res.ok) throw new Error('Token exchange failed');
  return res.json();
}

async function doRefresh(refresh, clientId) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
  });
  if (!res.ok) throw new Error('Refresh failed');
  return res.json();
}

// Original (default-app) keys are kept unprefixed so existing logins carry over.
function keys(clientId) {
  const p = clientId === CLIENT_ID ? 'sp_' : `sp_${clientId}_`;
  return { access: `${p}access`, refresh: `${p}refresh`, exp: `${p}exp`, scopes: `${p}scopes` };
}

function saveTokens({ access_token, refresh_token, expires_in }, clientId) {
  const k = keys(clientId);
  localStorage.setItem(k.access, access_token);
  if (refresh_token) localStorage.setItem(k.refresh, refresh_token);
  localStorage.setItem(k.exp, String(Date.now() + expires_in * 1000 - 60_000));
  localStorage.setItem(k.scopes, SCOPES);
}

export function clearTokens(clientId = CLIENT_ID) {
  Object.values(keys(clientId)).forEach(key => localStorage.removeItem(key));
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('pkce_redirect');
}

export async function getToken(clientId = CLIENT_ID) {
  const k = keys(clientId);
  // Force re-auth if scopes have changed
  const storedScopes = localStorage.getItem(k.scopes);
  if (storedScopes && storedScopes !== SCOPES) {
    clearTokens(clientId);
    return null;
  }
  const access = localStorage.getItem(k.access);
  const exp = Number(localStorage.getItem(k.exp) || 0);
  if (access && Date.now() < exp) return access;
  const refresh = localStorage.getItem(k.refresh);
  if (!refresh) return null;
  try {
    const data = await doRefresh(refresh, clientId);
    saveTokens(data, clientId);
    return data.access_token;
  } catch {
    clearTokens(clientId);
    return null;
  }
}

// Call on page load: completes an OAuth redirect if `?code=` is present, then
// returns a valid token (or null if the user needs to connect).
export async function completeAuth(clientId = CLIENT_ID) {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    window.history.replaceState({}, '', window.location.pathname);
    const d = await exchangeCode(code, clientId);
    saveTokens(d, clientId);
    sessionStorage.removeItem('pkce_verifier');
    sessionStorage.removeItem('pkce_redirect');
  }
  return getToken(clientId);
}

// All Web API GETs go through one queue: at most MAX_IN_FLIGHT at a time, and
// when Spotify answers 429 every queued request waits out its Retry-After
// (instead of each retrying on its own and making the throttling worse).
// A wait longer than MAX_WAIT_S fails fast with a readable error.
const MAX_IN_FLIGHT = 3;
const MAX_WAIT_S = 30;
let inFlight = 0;
const queue = [];
let pausedUntil = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function acquire() {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise(r => queue.push(r));
  inFlight++;
}
function release() {
  inFlight--;
  queue.shift()?.();
}

function rateLimitError(seconds) {
  const mins = Math.ceil(seconds / 60);
  const e = new Error(`Spotify is rate-limiting this app — try again in ${mins > 1 ? `${mins} minutes` : 'a minute'}.`);
  e.status = 429;
  e.retryAfter = seconds;
  return e;
}

export async function spGet(path, token) {
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      const wait = pausedUntil - Date.now();
      if (wait > MAX_WAIT_S * 1000) throw rateLimitError(wait / 1000);
      if (wait > 0) await sleep(wait);

      const res = await fetch(`https://api.spotify.com/v1${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 429) {
        const retry = Number(res.headers.get('Retry-After')) || 5;
        pausedUntil = Math.max(pausedUntil, Date.now() + retry * 1000);
        if (retry > MAX_WAIT_S || attempt >= 2) throw rateLimitError(retry);
        continue;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = new Error(err?.error?.message || res.statusText);
        e.status = res.status;
        throw e;
      }
      if (res.status === 204) return null; // e.g. currently-playing when nothing is
      return res.json();
    }
  } finally {
    release();
  }
}
