import Fuse from 'fuse.js';

export function createSearch(items, keys) {
  return new Fuse(items, {
    keys,
    threshold: 0.35,
    includeScore: true,
  });
}

export function search(fuse, query) {
  if (!query.trim()) return null;
  return fuse.search(query).map((r) => r.item);
}
