// Main-thread wrapper around embedWorker.js. Vectors come back L2-normalized,
// so cosine similarity is a plain dot product.

let worker = null;
let nextId = 0;
const pending = new Map();
let progressListener = null;
// No word from the worker for this long (no download progress, no result) = stuck.
const STALL_MS = 90_000;

// Reject everything outstanding and drop the worker so the next call starts fresh.
function failAll(message) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear();
  worker?.terminate();
  worker = null;
}

function armTimers() {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => failAll('The recommendation model stopped responding. This browser may not have enough memory to run it.'), STALL_MS);
  }
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./embedWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      armTimers();
      if (data.type === 'progress') { progressListener?.(data); return; }
      const p = pending.get(data.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(data.id);
      if (data.type === 'error') p.reject(new Error(data.message));
      else p.resolve(data.vectors);
    };
    // Fires when the worker script can't load or crashes (e.g. out of memory on a phone).
    worker.onerror = e => { e.preventDefault?.(); failAll(`Recommendation model failed to start${e.message ? `: ${e.message}` : ''}.`); };
    worker.onmessageerror = () => failAll('Recommendation model returned unreadable data.');
  }
  return worker;
}

export function onModelProgress(fn) { progressListener = fn; }

export function embed(texts) {
  if (!texts.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, texts });
    armTimers();
  });
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
