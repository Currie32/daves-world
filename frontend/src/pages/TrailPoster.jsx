import { useState, useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import PageHeader from '../components/PageHeader';

// --- Constants ---

const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const MAPTILER_API_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

// Layer IDs from the OpenFreeMap liberty style that should be styled as trails
const TRAIL_LAYER_IDS = new Set([
  'road_path_pedestrian', 'tunnel_path_pedestrian', 'bridge_path_pedestrian',
  'road_path_pedestrian_casing', 'bridge_path_pedestrian_casing',
]);
// Layer IDs that contain tracks (trail-like) mixed with service roads — we restyle these
const TRACK_LAYER_IDS = new Set([
  'road_service_track', 'tunnel_service_track', 'bridge_service_track',
  'road_service_track_casing', 'tunnel_service_track_casing', 'bridge_service_track_casing',
]);
// Layer ID patterns for roads to hide
const ROAD_HIDE_PATTERNS = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'street', 'link', 'minor', 'rail', 'one_way',
];

const POSTER_SIZES = [
  { label: '18 x 24"', w: 18, h: 24 },
  { label: '24 x 36"', w: 24, h: 36 },
  { label: '11 x 14"', w: 11, h: 14 },
  { label: '16 x 20"', w: 16, h: 20 },
  { label: 'Square (20 x 20")', w: 20, h: 20 },
];

const DPI_OPTIONS = [150, 200, 300];

// Each palette is tuned for thin ink on a warm ground: contours are a soft
// earthy mid-tone (visible but quiet), water is muted, text tracks the trail ink.
const THEME_PRESETS = {
  'Parchment': {
    background: '#f3ede1', trails: '#453a2e', contours: '#cdbca0',
    water: '#aebfc4', text: '#453a2e',
  },
  'Ivory': {
    background: '#faf7f0', trails: '#20201d', contours: '#d8cdb8',
    water: '#bcc9cd', text: '#20201d',
  },
  'Sage': {
    background: '#e6e9de', trails: '#374139', contours: '#bcc3ad',
    water: '#9fb4ad', text: '#374139',
  },
  'Canyon': {
    background: '#f0e2d1', trails: '#6b3a29', contours: '#d0b593',
    water: '#8b9b87', text: '#472819',
  },
  'Slate': {
    background: '#e8eaec', trails: '#2e343a', contours: '#c0c6cc',
    water: '#9aabb4', text: '#2e343a',
  },
  'Blueprint': {
    background: '#1b3b58', trails: '#eef3f6', contours: '#3a6491',
    water: '#16324a', text: '#eef3f6',
  },
  'Pine': {
    background: '#21362b', trails: '#ebe6d4', contours: '#3e5a4a',
    water: '#1b2c31', text: '#ebe6d4',
  },
  'Midnight': {
    background: '#1e2126', trails: '#e6e2d8', contours: '#39404b',
    water: '#273d4d', text: '#e6e2d8',
  },
};

const DEFAULT_COLORS = THEME_PRESETS['Parchment'];

const TEXT_POSITIONS = ['top', 'bottom', 'none'];

// Difficulty tiers — mountain-bike grading with a hiking fallback.
// `swatch` is the tint used for the legend header glyph; map markers use the trail ink.
const DIFFICULTY = {
  green:  { label: 'Green',        shape: 'circle',  swatch: '#3f7d3f' },
  blue:   { label: 'Blue',         shape: 'square',  swatch: '#2f5f9f' },
  black:  { label: 'Black',        shape: 'diamond', swatch: '#1a1a1a' },
  double: { label: 'Double Black', shape: 'double',  swatch: '#1a1a1a' },
  other:  { label: 'Trails',       shape: 'dot',     swatch: '#8a8378' },
};
const DIFFICULTY_ORDER = ['green', 'blue', 'black', 'double', 'other'];

// Poster band heights as a fraction of the frame — shared by preview overlay and export
const TOP_BAND = 0.14;      // top strip when a title is shown
const BOTTOM_BAND = 0.24;   // bottom strip when the trail legend is shown
const BARE_BAND = 0.035;    // strip with neither
const SIDE_BAND = 0.045;

// Only the most prominent named trails get a number + legend entry, so the
// footer stays legible. The rest still draw as unlabelled lines.
const MAX_LABELED_TRAILS = 38;
const PER_GROUP_CAP = 14;

// --- Overpass API ---

// Tried in order — the main instance rate-limits and has outages, so fall through to mirrors
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Approximate distance in meters between two [lon, lat] points
function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function lineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += haversine(coords[i - 1], coords[i]);
  }
  return len;
}

// Map OSM tags to a difficulty tier. MTB grading first (IMBA, then mtb:scale),
// then hiking (sac_scale); unclassified named trails fall through to `other`.
function classifyDifficulty(tags) {
  const imba = parseInt(tags['mtb:scale:imba'], 10);
  if (!Number.isNaN(imba)) {
    if (imba <= 0) return 'green';
    if (imba === 1) return 'blue';
    if (imba === 2) return 'black';
    return 'double';
  }
  const mtb = parseFloat(tags['mtb:scale']);
  if (!Number.isNaN(mtb)) {
    if (mtb <= 1) return 'green';
    if (mtb <= 2) return 'blue';
    if (mtb <= 4) return 'black';
    return 'double';
  }
  switch (tags['sac_scale']) {
    case 'hiking': return 'green';
    case 'mountain_hiking': return 'blue';
    case 'demanding_mountain_hiking': return 'black';
    case 'alpine_hiking':
    case 'demanding_alpine_hiking':
    case 'difficult_alpine_hiking': return 'double';
    default: return 'other';
  }
}

// Render a small difficulty-shaped marker as ImageData for map.addImage()
function makeMarkerIcon(shape, ink, size = 48) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const m = size / 2;
  const r = size * 0.42;
  x.fillStyle = ink;
  x.beginPath();
  if (shape === 'circle') {
    x.arc(m, m, r, 0, Math.PI * 2);
  } else if (shape === 'dot') {
    x.arc(m, m, r * 0.7, 0, Math.PI * 2);
  } else if (shape === 'square') {
    x.rect(m - r * 0.92, m - r * 0.92, r * 1.84, r * 1.84);
  } else if (shape === 'diamond') {
    x.moveTo(m, m - r); x.lineTo(m + r, m); x.lineTo(m, m + r); x.lineTo(m - r, m); x.closePath();
  } else if (shape === 'double') {
    const s = r * 0.72;
    x.moveTo(m - s, m - s); x.lineTo(m, m); x.lineTo(m - s, m + s); x.lineTo(m - s * 2, m); x.closePath();
    x.moveTo(m + s, m - s); x.lineTo(m + s * 2, m); x.lineTo(m + s, m + s); x.lineTo(m, m); x.closePath();
  }
  x.fill();
  return x.getImageData(0, 0, size, size);
}

// (Re)register the four+one difficulty marker images on a map instance
function addDifficultyIcons(map, colors) {
  for (const key of DIFFICULTY_ORDER) {
    const id = `diff-${key}`;
    const img = makeMarkerIcon(DIFFICULTY[key].shape, colors.trails);
    if (map.hasImage(id)) map.updateImage(id, img);
    else map.addImage(id, img, { pixelRatio: 2 });
  }
}

function formatDistance(m) {
  if (m >= 100000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

// Draw a difficulty shape glyph on a 2D canvas context (used in the export legend)
function drawShapeGlyph(ctx, key, cx, cy, r, ink) {
  const shape = DIFFICULTY[key].shape;
  ctx.save();
  ctx.fillStyle = ink;
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(cx, cy, r, 0, Math.PI * 2);
  else if (shape === 'dot') ctx.arc(cx, cy, r * 0.68, 0, Math.PI * 2);
  else if (shape === 'square') ctx.rect(cx - r * 0.92, cy - r * 0.92, r * 1.84, r * 1.84);
  else if (shape === 'diamond') {
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
  } else if (shape === 'double') {
    const s = r * 0.72;
    ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx, cy); ctx.lineTo(cx - s, cy + s); ctx.lineTo(cx - s * 2, cy); ctx.closePath();
    ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx + s * 2, cy); ctx.lineTo(cx + s, cy + s); ctx.lineTo(cx, cy); ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

// --- Union-Find for trail network detection ---

class UnionFind {
  constructor() { this.parent = new Map(); this.rank = new Map(); }
  make(x) { if (!this.parent.has(x)) { this.parent.set(x, x); this.rank.set(x, 0); } }
  find(x) {
    if (this.parent.get(x) !== x) this.parent.set(x, this.find(this.parent.get(x)));
    return this.parent.get(x);
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra), rankB = this.rank.get(rb);
    if (rankA < rankB) { this.parent.set(ra, rb); }
    else if (rankA > rankB) { this.parent.set(rb, ra); }
    else { this.parent.set(rb, ra); this.rank.set(ra, rankA + 1); }
  }
}

// Snap to ~100m grid — generous so nearby trails that don't quite touch still connect
function snapKey([lon, lat]) {
  return `${(lon * 1100) | 0},${(lat * 1100) | 0}`;
}

function computeNetworks(features) {
  const uf = new UnionFind();
  const cellToFeatureId = new Map();

  // Union features sharing any snapped grid cell across ALL their coordinates
  features.forEach((f, i) => {
    const fid = `f${i}`;
    uf.make(fid);
    for (const coord of f.geometry.coordinates) {
      const key = snapKey(coord);
      if (cellToFeatureId.has(key)) {
        uf.union(fid, cellToFeatureId.get(key));
      } else {
        cellToFeatureId.set(key, fid);
      }
    }
  });

  // Sum total length per network
  const networkLength = new Map();
  features.forEach((f, i) => {
    const root = uf.find(`f${i}`);
    networkLength.set(root, (networkLength.get(root) || 0) + f.properties.length);
  });

  return features.map((f, i) => ({
    ...f,
    properties: {
      ...f.properties,
      networkLength: networkLength.get(uf.find(`f${i}`)),
    },
  }));
}

async function fetchTrails(bounds) {
  const { _sw, _ne } = bounds;
  const bbox = `${_sw.lat},${_sw.lng},${_ne.lat},${_ne.lng}`;
  const query = `[out:json][timeout:30];(way["highway"~"^(path|track|bridleway)$"]["surface"!~"^(asphalt|concrete|paving_stones|paved)$"](${bbox}););out geom;`;

  let data = null;
  let lastErr = null;
  // Two passes over the mirror list — Overpass 504s and rate-limits are often transient
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    for (const url of OVERPASS_URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!res.ok) throw new Error(`Overpass error: ${res.status}`);
        data = await res.json();
        break;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  if (!data) throw lastErr || new Error('All Overpass endpoints failed');

  const features = data.elements
    .filter((el) => el.type === 'way' && el.geometry && el.geometry.length >= 5)
    .map((el) => {
      const coords = el.geometry.map((pt) => [pt.lon, pt.lat]);
      return {
        type: 'Feature',
        properties: {
          highway: el.tags?.highway || 'path',
          name: el.tags?.name || null,
          difficulty: classifyDifficulty(el.tags || {}),
          length: Math.round(lineLength(coords)),
        },
        geometry: { type: 'LineString', coordinates: coords },
      };
    });

  // Prominence proxy: total length of all segments sharing a trail name
  // (unnamed ways just use their own length). Drives the trail fade.
  const nameTotals = new Map();
  for (const f of features) {
    const n = f.properties.name;
    if (n) nameTotals.set(n, (nameTotals.get(n) || 0) + f.properties.length);
  }
  for (const f of features) {
    const n = f.properties.name;
    f.properties.prominence = n ? nameTotals.get(n) : f.properties.length;
  }

  return {
    type: 'FeatureCollection',
    features: computeNetworks(features),
  };
}

function filterTrailsByNetwork(geojson, minNetworkLength) {
  if (!geojson || minNetworkLength <= 0) return geojson;
  return {
    type: 'FeatureCollection',
    features: geojson.features.filter((f) => f.properties.networkLength >= minNetworkLength),
  };
}

// Group named trails by difficulty, number them 1..N within each group (longest first),
// and place one map marker per trail. `inArea` (optional) restricts to the visible poster.
function buildTrailGroups(features, inArea) {
  const byName = new Map(); // name -> { length, difficulty, segLen, coords }
  for (const f of features) {
    const name = f.properties.name;
    if (!name) continue;
    const coords = f.geometry.coordinates;
    if (inArea && !coords.some(c => inArea(c[0], c[1]))) continue;
    let rec = byName.get(name);
    if (!rec) {
      rec = { length: 0, difficulty: f.properties.difficulty || 'other', segLen: -1, coords };
      byName.set(name, rec);
    }
    rec.length += f.properties.length;
    if (f.properties.length > rec.segLen) {
      rec.segLen = f.properties.length;
      rec.coords = coords;
      rec.difficulty = f.properties.difficulty || 'other';
    }
  }

  // Rank every named trail by length, then pick the most prominent ones — capped
  // per tier and overall — so the legend fits the footer.
  const ranked = [...byName.entries()]
    .map(([name, r]) => ({ name, ...r }))
    .sort((a, b) => b.length - a.length);

  const chosen = {};
  DIFFICULTY_ORDER.forEach(k => { chosen[k] = []; });
  let total = 0;
  for (const t of ranked) {
    if (total >= MAX_LABELED_TRAILS) break;
    const key = t.difficulty || 'other';
    if (chosen[key].length >= PER_GROUP_CAP) continue;
    chosen[key].push(t);
    total += 1;
  }

  const groups = {};
  const markers = [];
  for (const key of DIFFICULTY_ORDER) {
    const list = chosen[key];
    if (!list.length) continue;
    groups[key] = list.map((t, i) => ({ name: t.name, number: i + 1 }));
    list.forEach((t, i) => {
      let pt = t.coords[Math.floor(t.coords.length / 2)];
      if (inArea && !inArea(pt[0], pt[1])) {
        pt = t.coords.find(c => inArea(c[0], c[1])) || pt;
      }
      markers.push({ difficulty: key, number: i + 1, lon: pt[0], lat: pt[1] });
    });
  }
  return { groups, markers, namedCount: byName.size };
}

function markerFeatures(markers) {
  return {
    type: 'FeatureCollection',
    features: markers.map(mk => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [mk.lon, mk.lat] },
      properties: { number: String(mk.number), difficulty: mk.difficulty },
    })),
  };
}

function computeTrailStats(geojson, minLen) {
  if (!geojson) return { count: 0, distance: 0, groups: {}, markers: [] };
  const filtered = filterTrailsByNetwork(geojson, minLen);
  const { groups, markers, namedCount } = buildTrailGroups(filtered.features, null);
  const distance = filtered.features.reduce((sum, f) => sum + f.properties.length, 0);
  return { count: namedCount, distance, groups, markers };
}

// Compute visible-area-aware trail stats and refresh the map's difficulty markers.
function updateLabelsForViewport(map, geojson, minLen, { hasTitle, hasTrails } = {}) {
  const markerSrc = map?.getSource('trail-markers');
  if (!markerSrc || !geojson) return null;
  const container = map.getContainer();
  const w = container.clientWidth, h = container.clientHeight;
  // Inset bounds to match the poster margin overlays + small buffer
  const buf = 12;
  const sideInset = w * SIDE_BAND + buf;
  const topInset = h * (hasTitle ? TOP_BAND : BARE_BAND) + buf;
  const bottomInset = h * (hasTrails ? BOTTOM_BAND : BARE_BAND) + buf;
  const topLeft = map.unproject([sideInset, topInset]);
  const bottomRight = map.unproject([w - sideInset, h - bottomInset]);

  const inArea = (lng, lat) =>
    lng >= topLeft.lng && lng <= bottomRight.lng &&
    lat <= topLeft.lat && lat >= bottomRight.lat;

  const filtered = filterTrailsByNetwork(geojson, minLen);
  const { groups, markers, namedCount } = buildTrailGroups(filtered.features, inArea);
  markerSrc.setData(markerFeatures(markers));

  const distance = filtered.features.reduce((sum, f) => sum + f.properties.length, 0);
  return { count: namedCount, distance, groups, markers };
}

function computeScaleBar(map, containerRef) {
  if (!map) return null;
  const lat = map.getCenter().lat;
  const zoom = map.getZoom();
  const mpp = 156543.03 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
  const containerWidth = containerRef?.current?.clientWidth || 500;
  const targetM = mpp * containerWidth * 0.12;
  const niceValues = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  const nice = niceValues.find(v => v >= targetM * 0.6) || niceValues[niceValues.length - 1];
  const barPx = nice / mpp;
  return { widthPx: Math.round(barPx), label: nice >= 1000 ? `${nice / 1000} km` : `${nice} m` };
}

// Pad bounds by ~50% so trails persist when panning slightly
function padBounds(bounds) {
  const { _sw, _ne } = bounds;
  const latPad = (_ne.lat - _sw.lat) * 0.5;
  const lngPad = (_ne.lng - _sw.lng) * 0.5;
  return {
    _sw: { lat: _sw.lat - latPad, lng: _sw.lng - lngPad },
    _ne: { lat: _ne.lat + latPad, lng: _ne.lng + lngPad },
  };
}

function boundsContain(outer, inner) {
  if (!outer) return false;
  return (
    inner._sw.lat >= outer._sw.lat &&
    inner._sw.lng >= outer._sw.lng &&
    inner._ne.lat <= outer._ne.lat &&
    inner._ne.lng <= outer._ne.lng
  );
}

// --- Style Mutation ---

const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };

function buildPosterStyle(baseStyle, colors) {
  const style = JSON.parse(JSON.stringify(baseStyle));

  // Keep only: background, water. Remove everything else.
  style.layers = style.layers.filter((layer) => {
    const id = layer.id;
    if (layer.type === 'background') return true;
    if ((id.includes('water') || id.includes('ocean') || id.includes('sea')) &&
        layer.type !== 'symbol') return true;
    return false;
  });

  // Restyle kept layers
  style.layers = style.layers.map((layer) => {
    const l = { ...layer };

    if (l.type === 'background') {
      l.paint = { 'background-color': colors.background };
      return l;
    }

    // Water — faint tonal fill
    if (l.type === 'fill') {
      l.paint = { 'fill-color': colors.water, 'fill-opacity': 0.5 };
    }
    if (l.type === 'line') {
      l.paint = { 'line-color': colors.trails, 'line-width': 0.4, 'line-opacity': 0.2 };
    }
    return l;
  });

  // GeoJSON source for Overpass trail data — starts empty, filled after fetch
  style.sources['trails-geojson'] = {
    type: 'geojson',
    data: EMPTY_GEOJSON,
  };

  // GeoJSON source for numbered difficulty markers
  style.sources['trail-markers'] = {
    type: 'geojson',
    data: EMPTY_GEOJSON,
  };

  // Waterways — thin, subtle, in the water ink
  style.layers.push({
    id: 'poster-waterways',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'waterway',
    paint: {
      'line-color': colors.water,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.2, 14, 0.7],
      'line-opacity': 0.4,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });

  // Contour lines
  if (MAPTILER_API_KEY) {
    style.sources.contours = {
      type: 'vector',
      url: `https://api.maptiler.com/tiles/contours/tiles.json?key=${MAPTILER_API_KEY}`,
    };

    style.layers.push({
      id: 'contour-lines',
      type: 'line',
      source: 'contours',
      'source-layer': 'contour',
      minzoom: 9,
      maxzoom: 16,
      filter: ['!=', ['get', 'nth_line'], 0],
      paint: {
        'line-color': colors.contours,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.35, 14, 0.6],
        'line-opacity': 0.45,
      },
    }, {
      id: 'contour-lines-index',
      type: 'line',
      source: 'contours',
      'source-layer': 'contour',
      minzoom: 9,
      maxzoom: 16,
      filter: ['==', ['get', 'nth_line'], 10],
      paint: {
        'line-color': colors.contours,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 1.1],
        'line-opacity': 0.6,
      },
    });
  }

  // Trail lines — one ink, one weight, but faded by prominence so the backbone
  // trails read strong and minor spurs recede (distinct from the paler contours).
  style.layers.push({
    id: 'poster-trails',
    type: 'line',
    source: 'trails-geojson',
    paint: {
      'line-color': colors.trails,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.35, 8, 0.6, 12, 1.0, 16, 1.5],
      // `to-number` (not `coalesce`) keeps the input number-typed for `interpolate`
      'line-opacity': [
        'interpolate', ['linear'],
        ['to-number', ['get', 'prominence'], ['get', 'length'], 0],
        150, 0.3,
        700, 0.5,
        2000, 0.74,
        6000, 0.95,
      ],
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });

  // Numbered difficulty markers — icon shape encodes the tier, number matches the legend
  style.layers.push({
    id: 'trail-marker',
    type: 'symbol',
    source: 'trail-markers',
    layout: {
      'icon-image': ['concat', 'diff-', ['get', 'difficulty']],
      'icon-size': 0.62,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'text-field': ['get', 'number'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 7.5,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': colors.background,
    },
  });

  return style;
}

// --- Export ---

async function exportPoster({ map, colors, title, subtitle, textPosition, fontSize, size, orientation, dpi, previewWidth, trailStats }) {
  const w = orientation === 'landscape' ? size.h : size.w;
  const h = orientation === 'landscape' ? size.w : size.h;
  const pxW = Math.round(w * dpi);
  const pxH = Math.round(h * dpi);

  const totalPixels = pxW * pxH;
  if (totalPixels > 100_000_000) {
    alert(`Export would be ${(totalPixels / 1e6).toFixed(0)}M pixels, which may exceed browser memory limits. Try a lower DPI.`);
    return;
  }

  // Adjust zoom so export shows same area as preview
  // On Retina displays, MapLibre uses devicePixelRatio internally for both preview and export,
  // so the CSS-pixel ratio is the correct adjustment
  const pw = previewWidth || 400;
  const scale = pxW / pw;

  // Evaluate a zoom-interpolated expression at a specific zoom level
  function evalAtZoom(expr, zoom) {
    if (typeof expr === 'number') return expr;
    if (!Array.isArray(expr) || expr[0] !== 'interpolate') return expr;
    const stops = [];
    for (let i = 3; i < expr.length; i += 2) stops.push([expr[i], expr[i + 1]]);
    if (zoom <= stops[0][0]) return stops[0][1];
    if (zoom >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (zoom >= stops[i][0] && zoom <= stops[i + 1][0]) {
        const t = (zoom - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
        return stops[i][1] + t * (stops[i + 1][1] - stops[i][1]);
      }
    }
    return stops[0][1];
  }

  // Scale line widths so export matches preview proportions
  const previewZoom = map.getZoom();
  const exportStyle = JSON.parse(JSON.stringify(map.getStyle()));
  exportStyle.layers.forEach(layer => {
    if (layer.paint && layer.paint['line-width']) {
      const val = evalAtZoom(layer.paint['line-width'], previewZoom);
      if (typeof val === 'number') {
        layer.paint['line-width'] = val * scale;
      }
    }
  });

  // Rebuild difficulty markers from trailStats so map numbers match the legend exactly
  if (trailStats && trailStats.markers) {
    exportStyle.sources['trail-markers'] = {
      type: 'geojson',
      data: markerFeatures(trailStats.markers),
    };
  }
  // Copy trail line data from preview map
  try {
    const trailSrc = map.getSource('trails-geojson');
    if (trailSrc) {
      const serialized = trailSrc.serialize?.();
      const data = serialized?.data || trailSrc._data;
      if (data) exportStyle.sources['trails-geojson'] = { type: 'geojson', data };
    }
  } catch (e) { /* fallback: export style already has the source from getStyle() */ }
  // Scale marker icon + number up for the export resolution
  exportStyle.layers.forEach(layer => {
    if (layer.id === 'trail-marker' && layer.layout) {
      layer.layout['icon-size'] = 0.62 * scale;
      layer.layout['text-size'] = 7.5 * scale;
    }
  });

  // Compute the visible map area (inside preview margins) and fit export to match
  const previewContainer = map.getContainer();
  const pvW = previewContainer.clientWidth;
  const pvH = previewContainer.clientHeight;
  const hasTopTitle = textPosition === 'top' && (title || subtitle);
  const hasLegend = trailStats && trailStats.count > 0;
  const topFrac = hasTopTitle ? TOP_BAND : BARE_BAND;
  const bottomFrac = hasLegend ? BOTTOM_BAND : BARE_BAND;
  // Get the geographic bounds of the visible poster area (inside margins)
  const visibleTopLeft = map.unproject([pvW * SIDE_BAND, pvH * topFrac]);
  const visibleBottomRight = map.unproject([pvW * (1 - SIDE_BAND), pvH * (1 - bottomFrac)]);
  const visibleBounds = [
    [visibleTopLeft.lng, visibleBottomRight.lat],
    [visibleBottomRight.lng, visibleTopLeft.lat],
  ];
  // Export margins in pixels — pad the export map so the visible area matches
  const exportTopMarginPx = Math.round(pxH * topFrac);
  const exportBottomMarginPx = Math.round(pxH * bottomFrac);
  const exportSideMarginPx = Math.round(pxW * SIDE_BAND);

  const container = document.createElement('div');
  container.style.cssText = `position:fixed;left:-99999px;top:0;width:${pxW}px;height:${pxH}px;`;
  document.body.appendChild(container);

  try {
    const exportMap = new maplibregl.Map({
      container,
      style: exportStyle,
      bounds: visibleBounds,
      fitBoundsOptions: { padding: { top: exportTopMarginPx, bottom: exportBottomMarginPx, left: exportSideMarginPx, right: exportSideMarginPx } },
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      interactive: false,
      preserveDrawingBuffer: true,
      fadeDuration: 0,
      attributionControl: false,
      pixelRatio: 1,
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Map render timed out')), 30000);
      exportMap.once('load', () => addDifficultyIcons(exportMap, colors));
      exportMap.once('idle', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const mapCanvas = exportMap.getCanvas();
    const outCanvas = document.createElement('canvas');
    outCanvas.width = pxW;
    outCanvas.height = pxH;
    const ctx = outCanvas.getContext('2d');

    // Draw map
    ctx.drawImage(mapCanvas, 0, 0, pxW, pxH);

    // Draw margin frame (background color strips)
    const mx = exportSideMarginPx;
    const topH = exportTopMarginPx;
    const bottomH = exportBottomMarginPx;
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, pxW, topH);
    ctx.fillRect(0, pxH - bottomH, pxW, bottomH);
    ctx.fillRect(0, 0, mx, pxH);
    ctx.fillRect(pxW - mx, 0, mx, pxH);

    // Preview element sizes (in CSS px) — scale these up by `scale` for export
    // Scale bar: preview line ~1px, label ~6.4px (0.4rem), ticks ~5px
    // Compass: preview 16px
    // Title: preview fontSize*0.6, subtitle fontSize*0.3
    // Legend labels: ~5px (0.32rem), values: ~6px (0.38rem)

    // Scale bar
    const lat = exportMap.getCenter().lat;
    const exportZoom = exportMap.getZoom();
    const mpp = 156543.03 * Math.cos(lat * Math.PI / 180) / Math.pow(2, exportZoom);
    const scaleTargetM = mpp * pxW * 0.12;
    const scaleNiceValues = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    const scaleNice = scaleNiceValues.find(v => v >= scaleTargetM * 0.6) || scaleNiceValues[scaleNiceValues.length - 1];
    const scaleBarW = scaleNice / mpp;
    const scaleLabel = scaleNice >= 1000 ? `${scaleNice / 1000} km` : `${scaleNice} m`;
    const scaleX = Math.round(pxW * 0.06);
    const scaleY = Math.round(pxH * 0.05);
    const lineW = Math.max(1, Math.round(1 * scale));

    ctx.strokeStyle = colors.text;
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(scaleX, scaleY);
    ctx.lineTo(scaleX + scaleBarW, scaleY);
    ctx.stroke();
    const tickH = Math.round(5 * scale);
    ctx.beginPath();
    ctx.moveTo(scaleX, scaleY - tickH);
    ctx.lineTo(scaleX, scaleY + tickH);
    ctx.moveTo(scaleX + scaleBarW, scaleY - tickH);
    ctx.lineTo(scaleX + scaleBarW, scaleY + tickH);
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.font = `400 ${Math.round(6.4 * scale)}px "DM Sans", sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(scaleLabel.toUpperCase(), scaleX, scaleY + Math.round(14 * scale));

    // Compass
    const compassX = pxW - Math.round(pxW * 0.06);
    const compassY = Math.round(pxH * 0.05);
    const cs = Math.round(8 * scale);
    ctx.save();
    ctx.translate(compassX, compassY);
    ctx.strokeStyle = colors.text;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1, Math.round(0.7 * scale));
    ctx.beginPath();
    ctx.arc(0, 0, cs, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.text;
    ctx.beginPath();
    ctx.moveTo(0, -cs * 0.95);
    ctx.lineTo(cs * 0.2, cs * 0.1);
    ctx.lineTo(0, -cs * 0.15);
    ctx.lineTo(-cs * 0.2, cs * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.moveTo(0, cs * 0.95);
    ctx.lineTo(cs * 0.2, -cs * 0.1);
    ctx.lineTo(0, cs * 0.15);
    ctx.lineTo(-cs * 0.2, -cs * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();

    // Title — align top of title with scale bar and compass
    if (textPosition !== 'none' && (title || subtitle)) {
      const titleSize = Math.round(fontSize * 0.78 * scale);
      const subtitleSize = Math.round(fontSize * 0.3 * scale);
      // Align top of title text with scale bar line and compass center
      const titleY = textPosition === 'top' ? scaleY : pxH - Math.round(pxH * 0.09);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const centerX = pxW / 2;

      let bottomOfTitle = titleY;
      if (title) {
        ctx.fillStyle = colors.text;
        ctx.font = `700 ${titleSize}px "Playfair Display", serif`;
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = `${Math.round(titleSize * 0.28)}px`;
        ctx.fillText(title.toUpperCase(), centerX + Math.round(titleSize * 0.14), titleY);
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';
        bottomOfTitle = titleY + titleSize;
      }

      if (subtitle) {
        ctx.fillStyle = colors.text;
        ctx.font = `400 ${subtitleSize}px "DM Sans", sans-serif`;
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = `${Math.round(subtitleSize * 0.24)}px`;
        ctx.fillText(subtitle.toUpperCase(), centerX + Math.round(subtitleSize * 0.12), bottomOfTitle + subtitleSize * 0.5);
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';
      }
      ctx.textBaseline = 'alphabetic';
    }

    // Legend — stat block + difficulty groups
    if (trailStats && trailStats.count > 0) {
      const legendX = Math.round(pxW * 0.055);
      const legendRight = pxW - Math.round(pxW * 0.055);
      const legendTop = pxH - bottomH + Math.round(pxH * 0.028);
      const legendBottom = pxH - Math.round(pxH * 0.038);
      const availH = legendBottom - legendTop;

      const groupKeys = DIFFICULTY_ORDER.filter(k => (trailStats.groups[k] || []).length);
      const colCount = groupKeys.length + 1;
      const colW = (legendRight - legendX) / colCount;

      const headSize = Math.max(8, Math.round(4.2 * scale));
      const entrySize = Math.max(7, Math.round(3.6 * scale));
      const lineH = entrySize * 1.62;
      const listTop = legendTop + headSize * 2.6;
      const maxRows = Math.max(1, Math.floor((legendBottom - listTop) / lineH));

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      // Stat column
      const statPairs = [
        ['NUMBER OF TRAILS', String(trailStats.count)],
        ['TOTAL DISTANCE', formatDistance(trailStats.distance)],
      ];
      let sy = legendTop;
      for (const [k, v] of statPairs) {
        ctx.fillStyle = colors.text;
        ctx.font = `700 ${headSize}px "DM Sans", sans-serif`;
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = `${Math.round(headSize * 0.08)}px`;
        ctx.fillText(k, legendX, sy);
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';
        ctx.font = `400 ${Math.round(entrySize * 1.2)}px "DM Sans", sans-serif`;
        ctx.fillText(v, legendX, sy + headSize * 1.4);
        sy += headSize * 1.4 + entrySize * 1.2 + lineH * 0.9;
      }

      // Difficulty columns
      groupKeys.forEach((key, gi) => {
        const colX = legendX + colW * (gi + 1);
        const list = trailStats.groups[key];
        // Header: shape glyph + label
        drawShapeGlyph(ctx, key, colX + headSize * 0.5, legendTop + headSize * 0.55, headSize * 0.5, colors.text);
        ctx.fillStyle = colors.text;
        ctx.font = `700 ${headSize}px "DM Sans", sans-serif`;
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = `${Math.round(headSize * 0.08)}px`;
        ctx.fillText(DIFFICULTY[key].label.toUpperCase(), colX + headSize * 1.6, legendTop);
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';

        const shown = list.slice(0, list.length > maxRows ? maxRows - 1 : maxRows);
        shown.forEach((it, i) => {
          const y = listTop + i * lineH;
          ctx.fillStyle = colors.text;
          ctx.font = `700 ${entrySize}px "DM Sans", sans-serif`;
          ctx.fillText(String(it.number), colX, y);
          ctx.font = `400 ${entrySize}px "DM Sans", sans-serif`;
          let nm = it.name;
          const maxW = colW - entrySize * 3.4;
          while (nm.length && ctx.measureText(nm).width > maxW) nm = nm.slice(0, -1);
          if (nm.length < it.name.length) nm = nm.replace(/\s+\S*$/, '') + '…';
          ctx.fillText(nm, colX + entrySize * 2.4, y);
        });
        if (list.length > maxRows) {
          ctx.fillStyle = colors.text;
          ctx.globalAlpha = 0.55;
          ctx.font = `400 ${entrySize}px "DM Sans", sans-serif`;
          ctx.fillText(`+${list.length - (maxRows - 1)} more`, colX, listTop + (maxRows - 1) * lineH);
          ctx.globalAlpha = 1;
        }
      });
      ctx.textBaseline = 'alphabetic';
    }

    outCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trail-poster-${pxW}x${pxH}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');

    exportMap.remove();
  } finally {
    document.body.removeChild(container);
  }
}

// --- Component ---

// Small difficulty-shape glyph for legend headers
function ShapeSwatch({ shape, color, size = 7 }) {
  const s = size;
  const common = { fill: color };
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" style={{ flexShrink: 0, display: 'block' }}>
      {shape === 'circle' && <circle cx="5" cy="5" r="4.2" {...common} />}
      {shape === 'dot' && <circle cx="5" cy="5" r="3" {...common} />}
      {shape === 'square' && <rect x="1" y="1" width="8" height="8" {...common} />}
      {shape === 'diamond' && <path d="M5 0.5 L9.5 5 L5 9.5 L0.5 5 Z" {...common} />}
      {shape === 'double' && (
        <>
          <path d="M3.4 1.4 L5 5 L3.4 8.6 L0.4 5 Z" {...common} />
          <path d="M6.6 1.4 L9.6 5 L6.6 8.6 L5 5 Z" {...common} />
        </>
      )}
    </svg>
  );
}

export default function TrailPoster() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const cachedBoundsRef = useRef(null);
  const cachedTrailsRef = useRef(null);
  const minNetworkRef = useRef(0);
  const textPositionRef = useRef('top');
  const titleRef = useRef('');
  const [mapReady, setMapReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingTrails, setLoadingTrails] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  // Poster settings
  const [sizeIdx, setSizeIdx] = useState(0);
  const [orientation, setOrientation] = useState('portrait');
  const [colors, setColors] = useState(DEFAULT_COLORS);
  const [activeTheme, setActiveTheme] = useState('Parchment');
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [textPosition, setTextPosition] = useState('top');
  const [fontSize, setFontSize] = useState(32);
  const [dpi, setDpi] = useState(200);
  const [minNetworkSize, setMinNetworkSize] = useState(0);
  const [trailStats, setTrailStats] = useState({ count: 0, distance: 0, groups: {}, markers: [] });
  const [scaleInfo, setScaleInfo] = useState(null);

  const size = POSTER_SIZES[sizeIdx];
  const frameW = orientation === 'landscape' ? size.h : size.w;
  const frameH = orientation === 'landscape' ? size.w : size.h;
  const aspectRatio = frameW / frameH;

  // Poster band sizes (percent of frame) — kept in sync with the export canvas
  const hasTopTitle = textPosition === 'top' && (title || subtitle);
  const topBandPct = (hasTopTitle ? TOP_BAND : BARE_BAND) * 100;
  const bottomBandPct = (trailStats.count > 0 ? BOTTOM_BAND : BARE_BAND) * 100;
  const sideBandPct = SIDE_BAND * 100;
  const legendGroups = DIFFICULTY_ORDER.filter((k) => (trailStats.groups?.[k] || []).length);

  // Push filtered trail data and labels to the map sources
  const applyTrailFilter = useCallback((map, geojson, minLen) => {
    const src = map?.getSource('trails-geojson');
    if (!src || !geojson) return;
    src.setData(filterTrailsByNetwork(geojson, minLen));
    // Position labels within the visible poster area and update legend
    const visibleStats = updateLabelsForViewport(map, geojson, minLen, {
      hasTitle: textPositionRef.current === 'top' && !!titleRef.current,
      hasTrails: true,
    });
    if (visibleStats) setTrailStats(visibleStats);
  }, []);

  // Load trail data from Overpass and push to the map's GeoJSON source
  const loadTrails = useCallback(async (map) => {
    const viewBounds = map.getBounds();
    const bounds = { _sw: viewBounds.getSouthWest(), _ne: viewBounds.getNorthEast() };

    // Skip if current view is within already-fetched bounds
    if (boundsContain(cachedBoundsRef.current, bounds)) {
      applyTrailFilter(map, cachedTrailsRef.current, minNetworkRef.current);
      return;
    }

    setLoadingTrails(true);
    try {
      const fetchBounds = padBounds(bounds);
      const geojson = await fetchTrails(fetchBounds);
      cachedBoundsRef.current = fetchBounds;
      cachedTrailsRef.current = geojson;

      applyTrailFilter(map, geojson, minNetworkRef.current);
    } catch (err) {
      console.warn('Trail fetch failed:', err.message);
    } finally {
      setLoadingTrails(false);
    }
  }, [applyTrailFilter]);

  // Keep refs in sync for use inside moveend handler
  useEffect(() => { textPositionRef.current = textPosition; }, [textPosition]);
  useEffect(() => { titleRef.current = title; }, [title]);

  // Nudge the zoom control inside the poster's visible window so the margin
  // bands don't clip it.
  useEffect(() => {
    const host = mapContainerRef.current;
    const ctrl = host?.querySelector('.maplibregl-ctrl-top-left');
    if (!host || !ctrl) return;
    const { width, height } = host.getBoundingClientRect();
    const offX = Math.round(width * SIDE_BAND + 10);
    const offY = Math.round(Math.max(height * (topBandPct / 100), height * 0.075) + 10);
    ctrl.style.transform = `translate(${offX}px, ${offY}px)`;
  }, [mapReady, topBandPct, sizeIdx, orientation]);

  // Initialize map
  useEffect(() => {
    let cancelled = false;
    let debounceTimer = null;

    async function init() {
      try {
        const res = await fetch(OPENFREEMAP_STYLE_URL);
        if (!res.ok) throw new Error(`Failed to fetch map style: ${res.status}`);
        const baseStyle = await res.json();

        if (cancelled) return;

        const posterStyle = buildPosterStyle(baseStyle, colors);

        const map = new maplibregl.Map({
          container: mapContainerRef.current,
          style: posterStyle,
          center: [-122.8490, 49.2838],
          zoom: 13,
          attributionControl: false,
        });

        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

        map.on('load', () => {
          if (cancelled) return;
          mapRef.current = map;
          setMapReady(true);
          setLoading(false);
          try { addDifficultyIcons(map, colors); } catch (e) { console.warn('marker icons failed', e); }

          // Initial trail fetch
          loadTrails(map);
          setScaleInfo(computeScaleBar(map, mapContainerRef));
        });

        // Re-fetch trails when the user pans/zooms outside cached area
        map.on('moveend', () => {
          if (cancelled) return;
          setScaleInfo(computeScaleBar(map, mapContainerRef));
          // loadTrails will call applyTrailFilter which updates labels + stats
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => loadTrails(map), 300);
        });
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    }

    init();
    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply color changes to live map, preserving trail data
  const applyColors = useCallback(
    async (newColors) => {
      const map = mapRef.current;
      if (!map || !map.isStyleLoaded()) return;

      try {
        const res = await fetch(OPENFREEMAP_STYLE_URL);
        const baseStyle = await res.json();
        const newStyle = buildPosterStyle(baseStyle, newColors);

        map.once('style.load', () => {
          // Re-register marker icons in the new ink, then restore trail lines + markers
          addDifficultyIcons(map, newColors);
          if (cachedTrailsRef.current) {
            applyTrailFilter(map, cachedTrailsRef.current, minNetworkRef.current);
          }
        });

        map.setStyle(newStyle);
      } catch {
        try {
          map.setPaintProperty('poster-trails', 'line-color', newColors.trails);
          map.setPaintProperty('contour-lines', 'line-color', newColors.contours);
          map.setPaintProperty('contour-lines-index', 'line-color', newColors.contours);
        } catch { /* layers may not exist */ }
      }
    },
    [applyTrailFilter]
  );

  function handleMinNetworkSize(value) {
    setMinNetworkSize(value);
    minNetworkRef.current = value;
    applyTrailFilter(mapRef.current, cachedTrailsRef.current, value);
    setTrailStats(computeTrailStats(cachedTrailsRef.current, value));
  }

  function handleColorChange(key, value) {
    const newColors = { ...colors, [key]: value };
    setColors(newColors);
    setActiveTheme(null);
    applyColors(newColors);
  }

  function handleTheme(name) {
    const preset = THEME_PRESETS[name];
    setColors(preset);
    setActiveTheme(name);
    applyColors(preset);
  }

  async function handleExport() {
    if (!mapRef.current) return;
    setExporting(true);
    try {
      await exportPoster({
        map: mapRef.current,
        colors,
        title,
        subtitle,
        textPosition,
        fontSize,
        size,
        orientation,
        dpi,
        previewWidth: mapContainerRef.current?.clientWidth,
        trailStats,
      });
    } catch (err) {
      alert('Export failed: ' + err.message);
    } finally {
      setExporting(false);
    }
  }

  // --- Render ---

  const segmentBtn = (active) => ({
    flex: 1,
    padding: '0.3rem 0',
    borderRadius: 6,
    border: 'none',
    background: active ? 'var(--color-text)' : 'transparent',
    color: active ? '#fff' : 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)',
    fontSize: '0.75rem',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s',
  });

  const sectionLabel = {
    fontSize: '0.7rem',
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: '0 0 0.5rem',
  };

  return (
    <div style={{
      padding: '0.75rem 1.5rem',
      display: 'flex',
      flexDirection: 'column',
      height: 'calc(100dvh - 52px - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
    }}>
      <PageHeader
        title="Trail Poster Maker"
        subtitle="Create printable art from your favorite trails"
      />

      {error && (
        <div style={{
          background: '#fef2f2', color: '#991b1b',
          padding: '0.5rem 0.75rem', borderRadius: 8,
          fontSize: '0.85rem', marginBottom: '0.5rem',
        }}>
          Failed to load map: {error}
        </div>
      )}

      <div style={{
        display: 'flex',
        gap: '1.5rem',
        flex: 1,
        minHeight: 0,
      }}>
        {/* Poster — left side, centered */}
        <div style={{
          flex: 1,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 12,
          overflow: 'hidden',
          minWidth: 0,
        }}>
          <div style={{
            position: 'relative',
            aspectRatio: String(aspectRatio),
            maxWidth: '100%',
            maxHeight: '100%',
            width: aspectRatio >= 1 ? '100%' : 'auto',
            height: aspectRatio < 1 ? '100%' : 'auto',
            background: colors.background,
            borderRadius: 4,
            border: '1px solid var(--color-border)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
            overflow: 'hidden',
          }}>
            <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />

            {/* Poster frame overlays */}
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
              {/* Side margins */}
              <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: `${sideBandPct}%`, background: colors.background }} />
              <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: `${sideBandPct}%`, background: colors.background }} />

              {/* Top band — covers everything from top edge down through title + scale/compass */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: `${topBandPct}%`, background: colors.background }} />

              {/* Scale bar */}
              {scaleInfo && (
                <div style={{ position: 'absolute', top: '5%', left: '6%' }}>
                  <div style={{ width: scaleInfo.widthPx, height: 1, background: colors.text, position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 0, top: -2, width: 1, height: 5, background: colors.text }} />
                    <div style={{ position: 'absolute', right: 0, top: -2, width: 1, height: 5, background: colors.text }} />
                  </div>
                  <div style={{ fontSize: '0.4rem', color: colors.text, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>
                    {scaleInfo.label}
                  </div>
                </div>
              )}

              {/* Compass */}
              <svg viewBox="0 0 24 24" style={{ position: 'absolute', top: '4.5%', right: '5.5%', width: 16, height: 16 }}>
                <circle cx="12" cy="12" r="10.5" fill="none" stroke={colors.text} strokeWidth="0.7" opacity="0.5" />
                <path d="M12 2.5 L13.2 10 L12 8.5 L10.8 10 Z" fill={colors.text} />
                <path d="M12 21.5 L13.2 14 L12 15.5 L10.8 14 Z" fill={colors.text} opacity="0.3" />
              </svg>

              {/* Title */}
              {textPosition !== 'none' && (title || subtitle) && (
                <div style={{
                  position: 'absolute',
                  ...(textPosition === 'top' ? { top: '4.5%' } : { bottom: '7%' }),
                  left: '15%', right: '15%',
                  textAlign: 'center',
                }}>
                  {title && (
                    <div style={{
                      fontFamily: 'var(--font-display)', fontWeight: 700,
                      fontSize: `${Math.max(fontSize * 0.78, 12)}px`, color: colors.text,
                      letterSpacing: '0.28em', textTransform: 'uppercase', lineHeight: 1.15,
                      paddingLeft: '0.28em',
                    }}>{title}</div>
                  )}
                  {subtitle && (
                    <div style={{
                      fontFamily: 'var(--font-body)',
                      fontSize: `${Math.max(fontSize * 0.3, 7)}px`,
                      color: colors.text, marginTop: '0.45em',
                      letterSpacing: '0.24em', textTransform: 'uppercase',
                      paddingLeft: '0.24em',
                    }}>{subtitle}</div>
                  )}
                </div>
              )}

              {/* Bottom band — covers everything from bottom edge up through legend */}
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${bottomBandPct}%`, background: colors.background }} />

              {/* Legend — stat block + difficulty groups */}
              {trailStats.count > 0 && (
                <div style={{
                  position: 'absolute', bottom: '3.5%', top: `${100 - bottomBandPct + 2.6}%`, left: '5.5%', right: '5.5%',
                  display: 'flex', gap: '3%', alignItems: 'flex-start',
                  color: colors.text, fontFamily: 'var(--font-body)',
                }}>
                  {/* Stat block */}
                  <div style={{ flex: '0 0 auto', minWidth: '13%', lineHeight: 1.5 }}>
                    {[
                      ['Number of Trails', String(trailStats.count)],
                      ['Total Distance', formatDistance(trailStats.distance)],
                    ].map(([k, v]) => (
                      <div key={k} style={{ marginBottom: '0.5em' }}>
                        <div style={{ fontSize: '0.3rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}</div>
                        <div style={{ fontSize: '0.36rem' }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  {/* Difficulty columns */}
                  {legendGroups.map((key) => (
                    <div key={key} style={{ flex: 1, minWidth: 0, lineHeight: 1.55, overflow: 'hidden' }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '0.35em',
                        fontSize: '0.3rem', fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.08em', marginBottom: '0.5em',
                      }}>
                        <ShapeSwatch shape={DIFFICULTY[key].shape} color={colors.text} />
                        {DIFFICULTY[key].label}
                      </div>
                      {trailStats.groups[key].map((it) => (
                        <div key={it.name} style={{ fontSize: '0.3rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span style={{ fontWeight: 700, display: 'inline-block', minWidth: '1.4em' }}>{it.number}</span>
                          {it.name}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {loading && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(250,248,245,0.85)', borderRadius: 4,
              color: 'var(--color-text-muted)', fontSize: '0.95rem',
            }}>Loading map...</div>
          )}

          {loadingTrails && !loading && (
            <div style={{
              position: 'absolute', bottom: 12, left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 6, padding: '0.35rem 0.75rem',
              fontSize: '0.75rem', color: 'var(--color-text-muted)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
            }}>Loading trails...</div>
          )}
        </div>

        {/* Controls — right side */}
        <div style={{
          flex: 1,
          minWidth: 280,
          maxWidth: '50%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}>
          {/* Theme */}
          {/* Theme + Colors — side by side */}
          <div style={{ display: 'flex', gap: '1rem' }}>
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
              <p style={sectionLabel}>Theme</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.25rem' }}>
                {Object.entries(THEME_PRESETS).map(([name, preset]) => (
                  <button
                    key={name}
                    onClick={() => handleTheme(name)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.4rem',
                      padding: '0.3rem 0.45rem', borderRadius: 7,
                      border: activeTheme === name ? '2px solid var(--color-accent)' : '1px solid var(--color-border)',
                      background: activeTheme === name ? 'var(--color-accent)08' : 'var(--color-surface)',
                      cursor: 'pointer', fontFamily: 'var(--font-body)',
                      fontSize: '0.75rem', color: 'var(--color-text)',
                      transition: 'border-color 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                      {[preset.background, preset.trails, preset.water].map((c, i) => (
                        <div key={i} style={{
                          width: 12, height: 12, borderRadius: 3,
                          background: c, border: '1px solid rgba(0,0,0,0.1)',
                        }} />
                      ))}
                    </div>
                    <span style={{ fontWeight: activeTheme === name ? 600 : 400 }}>{name}</span>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ width: 1, background: 'var(--color-border)' }} />

            <div style={{ flex: '0 0 auto', minWidth: 130 }}>
              <p style={sectionLabel}>Colors</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                {[
                  ['background', 'Background'],
                  ['trails', 'Trails'],
                  ['contours', 'Contours'],
                  ['water', 'Water'],
                  ['text', 'Text'],
                ].map(([key, label]) => (
                  <label key={key} style={{
                    display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer',
                  }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{
                        width: 20, height: 20, borderRadius: 5,
                        background: colors[key],
                        border: '2px solid rgba(0,0,0,0.08)',
                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.2)',
                      }} />
                      <input
                        type="color" value={colors[key]}
                        onChange={(e) => handleColorChange(key, e.target.value)}
                        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
                      />
                    </div>
                    <span style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)' }}>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--color-border)' }} />

          {/* Trail Networks + Size — side by side */}
          <div style={{ display: 'flex', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
              <p style={sectionLabel}>Trail Networks</p>
              <input
                type="range" min={0} max={10000} step={100}
                value={minNetworkSize}
                onChange={(e) => handleMinNetworkSize(Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--color-accent)', marginBottom: '0.3rem' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <button
                  onClick={() => handleMinNetworkSize(Math.max(0, minNetworkSize - 100))}
                  disabled={minNetworkSize <= 0}
                  style={{
                    flex: 1, height: 28, borderRadius: 7,
                    border: '1px solid var(--color-border)', background: 'var(--color-surface)',
                    cursor: minNetworkSize <= 0 ? 'not-allowed' : 'pointer',
                    fontSize: '0.8rem', fontWeight: 600, lineHeight: 1,
                    color: minNetworkSize <= 0 ? 'var(--color-border)' : 'var(--color-text-muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >&minus;</button>
                <span style={{
                  flex: 1, textAlign: 'center',
                  fontSize: '0.65rem', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums',
                }}>
                  {minNetworkSize > 0 ? (minNetworkSize >= 1000 ? `${(minNetworkSize / 1000).toFixed(1)} km` : `${minNetworkSize} m`) : 'All'}
                </span>
                <button
                  onClick={() => handleMinNetworkSize(Math.min(10000, minNetworkSize + 100))}
                  disabled={minNetworkSize >= 10000}
                  style={{
                    flex: 1, height: 28, borderRadius: 7,
                    border: '1px solid var(--color-border)', background: 'var(--color-surface)',
                    cursor: minNetworkSize >= 10000 ? 'not-allowed' : 'pointer',
                    fontSize: '0.8rem', fontWeight: 600, lineHeight: 1,
                    color: minNetworkSize >= 10000 ? 'var(--color-border)' : 'var(--color-text-muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >+</button>
              </div>
            </div>

            <div style={{ width: 1, background: 'var(--color-border)' }} />

            <div style={{ flex: 1 }}>
              <p style={sectionLabel}>Size</p>
              <select
                value={sizeIdx}
                onChange={(e) => setSizeIdx(Number(e.target.value))}
                style={{
                  width: '100%', padding: '0.3rem 0.4rem', borderRadius: 7,
                  border: '1px solid var(--color-border)',
                  fontFamily: 'var(--font-body)', fontSize: '0.78rem',
                  background: 'var(--color-surface)', marginBottom: '0.3rem',
                }}
              >
                {POSTER_SIZES.map((s, i) => (
                  <option key={s.label} value={i}>{s.label}</option>
                ))}
              </select>
              <div style={{
                display: 'flex', gap: 2,
                background: 'var(--color-border)', borderRadius: 7, padding: 2,
              }}>
                <button style={segmentBtn(orientation === 'portrait')} onClick={() => setOrientation('portrait')}>Portrait</button>
                <button style={segmentBtn(orientation === 'landscape')} onClick={() => setOrientation('landscape')}>Landscape</button>
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--color-border)' }} />

          {/* Text */}
          <div>
            <p style={sectionLabel}>Text</p>
            <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.3rem' }}>
              <input
                type="text" placeholder="Title" value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={{
                  flex: 1, padding: '0.3rem 0.5rem', borderRadius: 7,
                  border: '1px solid var(--color-border)',
                  fontFamily: 'var(--font-body)', fontSize: '0.78rem', outline: 'none', minWidth: 0,
                }}
              />
              <input
                type="text" placeholder="Subtitle" value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                style={{
                  flex: 1, padding: '0.3rem 0.5rem', borderRadius: 7,
                  border: '1px solid var(--color-border)',
                  fontFamily: 'var(--font-body)', fontSize: '0.78rem', outline: 'none', minWidth: 0,
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <div style={{
                display: 'flex', gap: 2,
                background: 'var(--color-border)', borderRadius: 7, padding: 2, flex: '0 0 auto',
              }}>
                {TEXT_POSITIONS.map((pos) => (
                  <button key={pos} style={{...segmentBtn(textPosition === pos), padding: '0.25rem 0.5rem', flex: 'none', fontSize: '0.7rem'}} onClick={() => setTextPosition(pos)}>
                    {pos.charAt(0).toUpperCase() + pos.slice(1)}
                  </button>
                ))}
              </div>
              <input
                type="range" min={16} max={64} value={fontSize}
                onChange={(e) => setFontSize(Number(e.target.value))}
                style={{ flex: 1, accentColor: 'var(--color-accent)', minWidth: 40 }}
              />
              <span style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fontSize}px</span>
            </div>
          </div>

          {/* Export — inline with Text */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <select
              value={dpi}
              onChange={(e) => setDpi(Number(e.target.value))}
              style={{
                padding: '0.3rem 0.4rem', borderRadius: 6,
                border: '1px solid var(--color-border)',
                fontFamily: 'var(--font-body)', fontSize: '0.78rem',
                background: 'var(--color-surface)', flexShrink: 0,
              }}
            >
              {DPI_OPTIONS.map((d) => (
                <option key={d} value={d}>{d} DPI</option>
              ))}
            </select>
            <span style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {(() => {
                const w = orientation === 'landscape' ? size.h : size.w;
                const h = orientation === 'landscape' ? size.w : size.h;
                return `${w * dpi} × ${h * dpi} px`;
              })()}
            </span>
            <button
              disabled={!mapReady || exporting}
              onClick={handleExport}
              style={{
                marginLeft: 'auto',
                padding: '0.45rem 1rem',
                borderRadius: 8, border: 'none',
                fontFamily: 'var(--font-body)', fontWeight: 600,
                fontSize: '0.82rem', whiteSpace: 'nowrap',
                cursor: !mapReady || exporting ? 'not-allowed' : 'pointer',
                background: !mapReady || exporting ? 'var(--color-border)' : 'var(--color-text)',
                color: '#fff', transition: 'all 0.15s', letterSpacing: '0.02em',
              }}
            >
              {exporting ? 'Exporting...' : 'Download PNG'}
            </button>
          </div>

          {!MAPTILER_API_KEY && (
            <p style={{
              fontSize: '0.65rem', color: 'var(--color-text-muted)',
              margin: '0.25rem 0 0', lineHeight: 1.3,
            }}>
              Add <code style={{ fontSize: '0.6rem', background: 'var(--color-border)', padding: '0.1rem 0.25rem', borderRadius: 3 }}>VITE_MAPTILER_API_KEY</code> for contour lines.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
