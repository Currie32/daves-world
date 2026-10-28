import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { collection, getDocs, deleteDoc, doc, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { MapContainer, TileLayer, Marker, Popup, Polygon, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { db, app } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePlacesAutocomplete } from '../hooks/usePlacesAutocomplete';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';

const AREA_COLORS = ['#c0622f', '#2f7fc0', '#3a9a5b', '#8e4fb3', '#d1a31a', '#c0396b', '#2a9d9d', '#6b7280'];

// A must-see needs both signals: Claude's editorial pick and strong Google reviews.
// Places with no Google rating keep Claude's call.
const MUST_MIN_RATING = 4.4;
const MUST_MIN_REVIEWS = 200;
function isMust(p) {
  if (p.tier !== 'must') return false;
  if (p.rating == null) return true;
  return p.rating >= MUST_MIN_RATING && (p.ratingCount || 0) >= MUST_MIN_REVIEWS;
}

// 24x24 stroke icons drawn inside the map pins and list badges.
const CATEGORIES = [
  { key: 'eat', label: 'Eat', icon: 'M7 3v7a2 2 0 0 0 2 2v9M11 3v7a2 2 0 0 1-2 2M17 21V3c-2 1-3.5 4-3.5 8 0 1.5 1.5 2 3.5 2' },
  { key: 'drink', label: 'Drink', icon: 'M6 4h12l-6 8zM12 12v8M8 20h8' },
  { key: 'cafe', label: 'Cafes & Bakeries', icon: 'M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4zM16 11h1.5a2.5 2.5 0 0 1 0 5H16M8 3v3M12 3v3' },
  { key: 'museum', label: 'Museums & Culture', icon: 'M3 9l9-5 9 5zM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18' },
  { key: 'attraction', label: 'Attractions', icon: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z' },
  { key: 'activity', label: 'Activities', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z' },
  { key: 'outdoors', label: 'Outdoors', icon: 'M4 19l5-9 3.5 6 2.5-4 5 7zM15 6.5h.01' },
];
const CAT_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

function iconSvg(path, size, color = '#fff') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
}

function pinIcon(place, color, active) {
  const size = active ? 38 : isMust(place) ? 32 : 26;
  return L.divIcon({
    className: 'sb-pin',
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;
      display:flex;align-items:center;justify-content:center;border:${active ? 3 : 2}px solid #fff;
      box-shadow:0 1px 5px rgba(0,0,0,${active ? 0.55 : 0.35});">${iconSvg(CAT_BY_KEY[place.category].icon, Math.round(size * 0.55))}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

// ─── Area shapes ─────────────────────────────────────────────────────────────
// Each place claims the ground nearer to it than to any other place (a Voronoi
// cell capped at a radius). Cells are drawn in their area's colour, so areas
// tile the map and never overlap.

function placeCells(places, radiusM) {
  if (!places.length) return [];
  const lat0 = places.reduce((t, p) => t + p.lat, 0) / places.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xy = p => [p.lng * kx, p.lat];
  const r = radiusM / 111320;
  return places.map((p, i) => {
    const [cx, cy] = xy(p);
    let poly = Array.from({ length: 24 }, (_, k) => {
      const a = (k / 24) * 2 * Math.PI;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    });
    for (let j = 0; j < places.length && poly.length; j++) {
      if (j === i) continue;
      const [ox, oy] = xy(places[j]);
      const mx = (cx + ox) / 2, my = (cy + oy) / 2, nx = ox - cx, ny = oy - cy;
      const side = pt => (pt[0] - mx) * nx + (pt[1] - my) * ny; // <= 0 is on this place's side
      const out = [];
      for (let k = 0; k < poly.length; k++) {
        const u = poly[k], v = poly[(k + 1) % poly.length];
        const su = side(u), sv = side(v);
        if (su <= 0) out.push(u);
        if ((su < 0 && sv > 0) || (su > 0 && sv < 0)) {
          const t = su / (su - sv);
          out.push([u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t]);
        }
      }
      poly = out;
    }
    return { place: p, positions: poly.map(([x, y]) => [y, x / kx]) };
  }).filter(c => c.positions.length >= 3);
}

// ─── Map helpers ─────────────────────────────────────────────────────────────

function FitBounds({ places, center, trigger }) {
  const map = useMap();
  useEffect(() => {
    if (places.length) {
      map.fitBounds(L.latLngBounds(places.map(p => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 16 });
    } else if (center) {
      map.setView([center.lat, center.lng], 12);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);
  return null;
}

function FlyToActive({ place }) {
  const map = useMap();
  useEffect(() => {
    if (place) map.flyTo([place.lat, place.lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
  }, [place, map]);
  return null;
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function Rating({ p }) {
  if (p.rating == null) return null;
  return (
    <span style={s.rating}>
      <span style={{ color: '#d1a31a' }}>★</span> {p.rating.toFixed(1)}
      {p.ratingCount ? ` (${p.ratingCount.toLocaleString()})` : ''}
    </span>
  );
}

function PlaceCard({ p, area, color, active, onSelect, cardRef }) {
  const cat = CAT_BY_KEY[p.category];
  return (
    <div
      ref={cardRef}
      onClick={() => onSelect(p.placeId)}
      style={{
        ...s.card,
        borderLeftColor: color,
        boxShadow: active ? '0 4px 14px rgba(0,0,0,0.14)' : 'none',
        transform: active ? 'translateY(-1px)' : 'none',
      }}
    >
      <div style={s.cardTop}>
        <span style={{ ...s.badge, background: color }} dangerouslySetInnerHTML={{ __html: iconSvg(cat.icon, 14) }} />
        <h3 style={s.cardTitle}>{p.name}</h3>
        {p.kidFriendly && <span style={s.kidTag}>Kid-friendly</span>}
        {isMust(p) && <span style={s.mustTag}>Must-see</span>}
      </div>
      <div style={s.cardMeta}>
        <span>{cat.label}</span>
        <span style={{ color: color, fontWeight: 600 }}>{area?.name}</span>
        <Rating p={p} />
      </div>
      <p style={s.why}>{p.why}</p>
      {p.tip && <p style={s.tip}><strong>Tip:</strong> {p.tip}</p>}
      <div style={s.links}>
        {p.mapsUrl && <a href={p.mapsUrl} target="_blank" rel="noreferrer" className="sb-link" onClick={e => e.stopPropagation()}>Google Maps ↗</a>}
        {p.website && <a href={p.website} target="_blank" rel="noreferrer" className="sb-link" onClick={e => e.stopPropagation()}>Website ↗</a>}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SitesAndBites() {
  const { isAdmin } = useAuth();
  const isMobile = useIsMobile();
  const placesApi = usePlacesAutocomplete();
  const functions = useRef(getFunctions(app, 'us-west1'));
  const [searchParams, setSearchParams] = useSearchParams();
  const activeDestId = searchParams.get('d');

  const [destinations, setDestinations] = useState([]);
  const [dest, setDest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const debounceRef = useRef(null);
  const [generating, setGenerating] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [cats, setCats] = useState(new Set());
  const [areaFilter, setAreaFilter] = useState(null);
  const [mustOnly, setMustOnly] = useState(false);
  const [kidsOnly, setKidsOnly] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const markerRefs = useRef({});
  const cardRefs = useRef({});

  async function loadDestinations() {
    try {
      const snap = await getDocs(collection(db, 'destinations'));
      setDestinations(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      setError('Could not load saved destinations.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { loadDestinations(); }, []);

  // Live subscription, so places appear on the page while a guide is generating.
  useEffect(() => {
    setDest(null);
    if (!activeDestId) return undefined;
    return onSnapshot(
      doc(db, 'destinations', activeDestId),
      snap => setDest(snap.exists() ? { id: snap.id, ...snap.data() } : null),
      () => setError('Could not load this destination.'),
    );
  }, [activeDestId]);
  const building = dest?.status === 'generating';

  useEffect(() => {
    setCats(new Set());
    setAreaFilter(null);
    setMustOnly(false);
    setKidsOnly(false);
    setActiveId(null);
    setConfirmDelete(false);
  }, [activeDestId]);

  const areaColor = useMemo(() => {
    const m = {};
    (dest?.areas || []).forEach((a, i) => { m[a.id] = AREA_COLORS[i % AREA_COLORS.length]; });
    return m;
  }, [dest]);
  const areaById = useMemo(() => Object.fromEntries((dest?.areas || []).map(a => [a.id, a])), [dest]);

  const filtered = useMemo(() => {
    if (!dest) return [];
    return dest.places
      .filter(p => (cats.size === 0 || cats.has(p.category)) && (!areaFilter || p.areaId === areaFilter) && (!mustOnly || isMust(p)) && (!kidsOnly || p.kidFriendly))
      .sort((a, b) => (isMust(a) ? 0 : 1) - (isMust(b) ? 0 : 1) || (b.rating || 0) - (a.rating || 0));
  }, [dest, cats, areaFilter, mustOnly, kidsOnly]);

  const grouped = useMemo(
    () => CATEGORIES.map(c => ({ cat: c, items: filtered.filter(p => p.category === c.key) })).filter(g => g.items.length),
    [filtered],
  );

  const areaCells = useMemo(() => {
    if (!dest) return [];
    const radiusM = Math.min(1500, Math.max(400, (dest.radiusKm || 10) * 60));
    const cells = placeCells(dest.places, radiusM);
    // One label per area, on the cell closest to the area's centre.
    const labelled = new Set();
    for (const area of dest.areas) {
      const mine = cells.filter(c => c.place.areaId === area.id);
      if (!mine.length) continue;
      const cLat = mine.reduce((t, c) => t + c.place.lat, 0) / mine.length;
      const cLng = mine.reduce((t, c) => t + c.place.lng, 0) / mine.length;
      const best = mine.reduce((m, c) =>
        (c.place.lat - cLat) ** 2 + (c.place.lng - cLng) ** 2 < (m.place.lat - cLat) ** 2 + (m.place.lng - cLng) ** 2 ? c : m);
      labelled.add(best.place.placeId);
    }
    return cells.map(c => ({ ...c, labelled: labelled.has(c.place.placeId) }));
  }, [dest]);

  const activePlace = dest?.places.find(p => p.placeId === activeId) || null;

  function selectPlace(id) {
    setActiveId(id);
    setTimeout(() => markerRefs.current[id]?.openPopup(), 650);
  }

  function markerSelected(id) {
    setActiveId(id);
    cardRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function toggleCat(key) {
    setCats(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function handleInput(val) {
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSuggestions(val.trim() ? await placesApi.predict(val, []) : []);
    }, 300);
  }

  async function generate(placeId, refresh = false) {
    setError(null);
    setGenerating(placeId);
    setSearchParams({ d: placeId });
    try {
      const fn = httpsCallable(functions.current, 'generate_destination', { timeout: 540000 });
      await fn({ placeId, refresh });
      await loadDestinations();
    } catch (e) {
      setError(e.message || 'Could not build the guide.');
    } finally {
      setGenerating(null);
    }
  }

  function pickSuggestion(pred) {
    setSuggestions([]);
    setQuery('');
    generate(pred.place_id);
  }

  async function removeDestination() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    await deleteDoc(doc(db, 'destinations', dest.id));
    setSearchParams({});
    loadDestinations();
  }

  const mapHeight = isMobile ? 340 : 'calc(100vh - 2rem)';

  return (
    <div style={s.page}>
      <style>{`
        .sb-pin { background: none; border: none; }
        .sb-cell { shape-rendering: crispEdges; }
        .sb-link { color: var(--color-accent); text-decoration: none; font-size: 0.8rem; font-weight: 600;
          padding: 3px 10px; border: 1px solid var(--color-border); border-radius: 9999px; cursor: pointer;
          transition: background 0.15s, border-color 0.15s, color 0.15s; }
        .sb-link:hover { background: var(--color-accent); border-color: var(--color-accent); color: #fff; }
        .sb-spin { display: inline-block; width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
          border: 2px solid var(--color-border); border-top-color: var(--color-accent); animation: sb-spin 0.8s linear infinite; }
        @keyframes sb-spin { to { transform: rotate(360deg); } }
        .sb-area-label { background: rgba(255,255,255,0.85); border: none; box-shadow: none; font-weight: 700;
          font-size: 11px; letter-spacing: .03em; padding: 1px 6px; }
        .sb-area-label:before { display: none; }
      `}</style>

      <PageHeader
        title="Sites and Bites"
        subtitle="A short list of the places worth your time: the best food, drink, culture and views for a destination."
      />

      {error && <div style={s.errorBox}>{error}</div>}

      {isAdmin && (
        <div style={s.searchCard}>
          <label style={s.label}>Add a destination</label>
          <div style={{ position: 'relative' }}>
            <input
              style={s.input}
              value={query}
              onChange={e => handleInput(e.target.value)}
              placeholder="e.g. Palm Springs, Lisbon, Napa Valley..."
              disabled={!!generating}
            />
            {suggestions.length > 0 && (
              <ul style={s.suggestions}>
                {suggestions.map(p => (
                  <li
                    key={p.place_id}
                    style={s.suggestion}
                    onClick={() => pickSuggestion(p)}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {p.description}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {generating && (
            <p style={s.progress}><span className="sb-spin" /> Researching the best spots. Results appear below as they are found.</p>
          )}
        </div>
      )}

      {!activeDestId && (
        <>
          {loading ? (
            <EmptyState message="Loading..." />
          ) : destinations.length === 0 ? (
            <EmptyState message={isAdmin ? 'No destinations yet. Search for one above.' : 'No destinations yet.'} />
          ) : (
            <div style={s.destGrid}>
              {destinations.map(d => (
                <button key={d.id} type="button" style={s.destCard} onClick={() => setSearchParams({ d: d.id })}>
                  <span style={s.destName}>{d.name}</span>
                  <span style={s.destAddr}>{d.address}</span>
                  <span style={s.destCount}>
                    {d.status === 'generating' ? 'Building...' : `${d.places.length} places · ${d.areas.length} areas`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {activeDestId && !dest && (
        <>
          <button type="button" style={s.linkBtn} onClick={() => setSearchParams({})}>← All destinations</button>
          <p style={s.progress}>
            {generating === activeDestId ? <><span className="sb-spin" /> Starting...</> : 'Destination not found.'}
          </p>
        </>
      )}

      {dest && (
        <>
          <div style={s.destHeader}>
            <button type="button" style={s.linkBtn} onClick={() => setSearchParams({})}>← All destinations</button>
            {isAdmin && (
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" style={s.linkBtn} disabled={!!generating || building} onClick={() => generate(dest.id, true)}>
                  {generating === dest.id ? 'Regenerating...' : 'Regenerate'}
                </button>
                <button type="button" style={{ ...s.linkBtn, color: '#c0392b' }} onClick={removeDestination}>
                  {confirmDelete ? 'Click again to delete' : 'Delete'}
                </button>
              </div>
            )}
          </div>

          <h2 style={s.destTitle}>{dest.name}</h2>
          {building && (
            <p style={{ ...s.progress, margin: '0 0 1rem' }}>
              <span className="sb-spin" /> Finding places... {dest.places.length} so far
            </p>
          )}
          {dest.status === 'error' && <div style={s.errorBox}>{dest.error || 'Guide generation failed.'}</div>}
          <p style={s.summary}>{dest.summary}</p>

          {dest.areas.length > 0 && <h3 style={s.sectionTitle}>Areas</h3>}
          <div style={s.areaGrid}>
            {dest.areas.map(a => {
              const selected = areaFilter === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAreaFilter(selected ? null : a.id)}
                  style={{
                    ...s.areaCard,
                    borderColor: selected ? areaColor[a.id] : 'var(--color-border)',
                    boxShadow: selected ? `0 0 0 2px ${areaColor[a.id]}33` : 'none',
                  }}
                >
                  <span style={s.areaHead}>
                    <span style={{ ...s.swatch, background: areaColor[a.id] }} />
                    <span style={s.areaName}>{a.name}</span>
                    <span style={s.areaCount}>{dest.places.filter(p => p.areaId === a.id).length}</span>
                  </span>
                  <span style={s.areaDesc}>{a.description}</span>
                  {a.bestFor && <span style={s.areaBest}>Best for: {a.bestFor}</span>}
                </button>
              );
            })}
          </div>

          <div style={s.filterRow}>
            {CATEGORIES.map(c => {
              const on = cats.has(c.key);
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => toggleCat(c.key)}
                  style={{ ...s.chipBtn, ...(on ? s.chipOn : null) }}
                >
                  {c.label}
                </button>
              );
            })}
            {dest.places.some(p => p.kidFriendly) && (
              <button
                type="button"
                onClick={() => setKidsOnly(v => !v)}
                style={{ ...s.chipBtn, ...(kidsOnly ? s.chipOn : null), marginLeft: isMobile ? 0 : 'auto' }}
              >
                Kid-friendly
              </button>
            )}
            <button
              type="button"
              onClick={() => setMustOnly(v => !v)}
              style={{ ...s.chipBtn, ...(mustOnly ? s.chipOn : null), marginLeft: !isMobile && !dest.places.some(p => p.kidFriendly) ? 'auto' : 0 }}
            >
              Must-sees only
            </button>
          </div>

          <div style={{ ...s.split, flexDirection: isMobile ? 'column' : 'row' }}>
            <div style={{ ...s.mapCol, flex: isMobile ? 'none' : '1 1 55%', order: isMobile ? 0 : 1, height: mapHeight, position: isMobile ? 'relative' : 'sticky' }}>
              <MapContainer center={[dest.center.lat, dest.center.lng]} zoom={12} style={{ height: '100%', width: '100%', borderRadius: 12 }}>
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <FitBounds places={filtered} center={dest.center} trigger={`${dest.id}|${[...cats].join()}|${areaFilter}|${mustOnly}|${kidsOnly}|${building ? filtered.length : 'done'}`} />
                <FlyToActive place={activePlace} />
                {areaCells.map(({ place, positions, labelled }) => {
                  const dim = areaFilter && areaFilter !== place.areaId;
                  return (
                    <Polygon
                      key={place.placeId}
                      positions={positions}
                      interactive={false}
                      className="sb-cell"
                      pathOptions={{ stroke: false, fillColor: areaColor[place.areaId], fillOpacity: dim ? 0.04 : areaFilter ? 0.3 : 0.2 }}
                    >
                      {labelled && (
                        <Tooltip permanent direction="center" className="sb-area-label">{areaById[place.areaId]?.name}</Tooltip>
                      )}
                    </Polygon>
                  );
                })}
                {filtered.map(p => (
                  <Marker
                    key={p.placeId}
                    position={[p.lat, p.lng]}
                    icon={pinIcon(p, areaColor[p.areaId], p.placeId === activeId)}
                    zIndexOffset={p.placeId === activeId ? 1000 : isMust(p) ? 100 : 0}
                    ref={r => { markerRefs.current[p.placeId] = r; }}
                    eventHandlers={{ click: () => markerSelected(p.placeId) }}
                  >
                    <Popup>
                      <strong>{p.name}</strong><br />
                      <span style={{ color: '#6b6b6b' }}>{CAT_BY_KEY[p.category].label} · {areaById[p.areaId]?.name}</span>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>

            <div style={{ ...s.listCol, flex: isMobile ? 'none' : '1 1 45%', order: isMobile ? 1 : 0 }}>
              <p style={s.count}>{filtered.length} place{filtered.length === 1 ? '' : 's'}</p>
              {grouped.length === 0 && <EmptyState message="Nothing matches these filters." />}
              {grouped.map(({ cat, items }) => (
                <section key={cat.key}>
                  <h3 style={s.sectionTitle}>{cat.label}</h3>
                  <div style={s.cardList}>
                    {items.map(p => (
                      <PlaceCard
                        key={p.placeId}
                        p={p}
                        area={areaById[p.areaId]}
                        color={areaColor[p.areaId]}
                        active={p.placeId === activeId}
                        onSelect={selectPlace}
                        cardRef={r => { cardRefs.current[p.placeId] = r; }}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const s = {
  page: { maxWidth: 1200, margin: '0 auto', padding: '2rem 1.5rem 4rem', fontFamily: 'var(--font-body)' },
  errorBox: { border: '1px solid #c0392b', color: '#c0392b', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.9rem' },
  searchCard: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12,
    padding: '1.25rem 1.5rem', marginBottom: '2rem', display: 'flex', flexDirection: 'column', gap: 6,
  },
  label: { fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  input: {
    padding: '0.6rem 0.75rem', fontSize: '0.95rem', fontFamily: 'var(--font-body)', border: '1px solid var(--color-border)',
    borderRadius: 6, background: 'var(--color-bg)', color: 'var(--color-text)', outline: 'none', width: '100%', boxSizing: 'border-box',
  },
  suggestions: {
    position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: 8, listStyle: 'none', margin: '4px 0 0', padding: 0, zIndex: 1000, maxHeight: 240, overflowY: 'auto',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  },
  suggestion: { padding: '0.5rem 0.75rem', fontSize: '0.88rem', cursor: 'pointer' },
  progress: { margin: '0.5rem 0 0', fontSize: '0.88rem', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 8 },
  destGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem' },
  destCard: {
    textAlign: 'left', background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderLeft: '4px solid var(--color-accent)', borderRadius: 10, padding: '1rem 1.1rem', cursor: 'pointer',
    display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'var(--font-body)',
  },
  destName: { fontFamily: 'var(--font-display)', fontSize: '1.25rem', color: 'var(--color-text)' },
  destAddr: { fontSize: '0.82rem', color: 'var(--color-text-muted)' },
  destCount: { fontSize: '0.8rem', color: 'var(--color-accent)', marginTop: 4 },
  destHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' },
  linkBtn: { background: 'none', border: 'none', padding: 0, color: 'var(--color-accent)', fontSize: '0.88rem', cursor: 'pointer', fontFamily: 'var(--font-body)' },
  destTitle: { fontFamily: 'var(--font-display)', fontSize: '2rem', margin: '0 0 0.4rem', color: 'var(--color-text)' },
  summary: { margin: '0 0 1.5rem', color: 'var(--color-text-muted)', lineHeight: 1.55, maxWidth: 760 },
  sectionTitle: { fontFamily: 'var(--font-display)', fontSize: '1.15rem', margin: '1.25rem 0 0.6rem', color: 'var(--color-text)' },
  areaGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' },
  areaCard: {
    textAlign: 'left', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10,
    padding: '0.8rem 0.9rem', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 5, fontFamily: 'var(--font-body)',
  },
  areaHead: { display: 'flex', alignItems: 'center', gap: 8 },
  swatch: { width: 12, height: 12, borderRadius: 3, flexShrink: 0 },
  areaName: { fontWeight: 700, fontSize: '0.95rem', color: 'var(--color-text)', flex: 1 },
  areaCount: { fontSize: '0.78rem', color: 'var(--color-text-muted)' },
  areaDesc: { fontSize: '0.84rem', color: 'var(--color-text-muted)', lineHeight: 1.45 },
  areaBest: { fontSize: '0.78rem', color: 'var(--color-text)', fontStyle: 'italic' },
  filterRow: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: '1.25rem' },
  chipBtn: {
    padding: '0.4rem 0.85rem', borderRadius: 9999, border: '1px solid var(--color-border)', background: 'var(--color-surface)',
    color: 'var(--color-text)', fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'var(--font-body)',
  },
  chipOn: { background: 'var(--color-accent)', borderColor: 'var(--color-accent)', color: '#fff' },
  split: { display: 'flex', gap: '1.5rem', alignItems: 'flex-start' },
  mapCol: { top: '1rem', minWidth: 0, width: '100%' },
  listCol: { minWidth: 0, width: '100%' },
  count: { margin: 0, fontSize: '0.85rem', color: 'var(--color-text-muted)' },
  cardList: { display: 'flex', flexDirection: 'column', gap: '0.7rem' },
  card: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderLeft: '4px solid var(--color-accent)',
    borderRadius: 10, padding: '0.8rem 0.95rem', cursor: 'pointer', transition: 'box-shadow 0.15s, transform 0.15s',
  },
  cardTop: { display: 'flex', alignItems: 'center', gap: 8 },
  badge: { width: 22, height: 22, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  cardTitle: { margin: 0, fontSize: '1rem', fontFamily: 'var(--font-body)', fontWeight: 700, color: 'var(--color-text)', flex: 1 },
  mustTag: {
    fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-accent)',
    border: '1px solid var(--color-accent)', borderRadius: 9999, padding: '1px 7px', whiteSpace: 'nowrap',
  },
  kidTag: {
    fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#2f7fc0',
    border: '1px solid #2f7fc0', borderRadius: 9999, padding: '1px 7px', whiteSpace: 'nowrap',
  },
  cardMeta: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: '0.78rem', color: 'var(--color-text-muted)', margin: '4px 0 6px' },
  rating: { whiteSpace: 'nowrap' },
  why: { margin: 0, fontSize: '0.88rem', lineHeight: 1.45, color: 'var(--color-text)' },
  tip: { margin: '4px 0 0', fontSize: '0.82rem', lineHeight: 1.4, color: 'var(--color-text-muted)' },
  links: { display: 'flex', gap: 8, marginTop: 10 },
};
