// Main-thread wrapper around embedWorker.js. Vectors come back L2-normalized,
// so cosine similarity is a plain dot product.

let worker = null;
let nextId = 0;
const pending = new Map();
let progressListener = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./embedWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { progressListener?.(data); return; }
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.type === 'error') p.reject(new Error(data.message));
      else p.resolve(data.vectors);
    };
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
  });
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
