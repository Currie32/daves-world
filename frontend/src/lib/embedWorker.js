// Web Worker: runs a small sentence-embedding model (all-MiniLM-L6-v2, ~23 MB
// quantized) in the browser. Model files are fetched from Hugging Face on first
// use and cached by the browser's Cache API afterwards.
import { pipeline } from '@huggingface/transformers';

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: p => {
        if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
          self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
        }
      },
    });
  }
  return extractorPromise;
}

self.onmessage = async ({ data: { id, texts } }) => {
  try {
    const extractor = await getExtractor();
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
      const tensor = await extractor(texts.slice(i, i + 32), { pooling: 'mean', normalize: true });
      out.push(...tensor.tolist());
    }
    self.postMessage({ type: 'result', id, vectors: out });
  } catch (e) {
    self.postMessage({ type: 'error', id, message: e?.message || String(e) });
  }
};
