import { useState, useEffect, useRef } from 'react';
import { collection, getDocs, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import { usePlacesAutocomplete } from '../hooks/usePlacesAutocomplete';
import { useWalkPlanner } from '../hooks/useWalkPlanner';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import PageHeader from '../components/PageHeader';
import TagPill from '../components/TagPill';

// Fix Leaflet default marker icons (CSS import doesn't include them)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const ACCENT = '#c0622f';

const CATEGORIES = [
  { key: 'landmarks', label: 'Landmarks', types: ['tourist_attraction', 'historical_landmark'] },
  { key: 'museums', label: 'Museums & Art', types: ['museum', 'art_gallery'] },
  { key: 'parks', label: 'Parks & Nature', types: ['park'] },
  { key: 'shopping', label: 'Shopping', types: ['shopping_mall'] },
];

const FOOD_CATEGORIES = [
  { key: 'food', label: 'Quick Bites', types: ['fast_food_restaurant', 'sandwich_shop', 'meal_takeaway', 'bakery', 'hamburger_restaurant'] },
  { key: 'drink', label: 'Coffee & Drinks', types: ['cafe', 'bar'] },
];

// Google's Places "includedTypes" filter matches loosely — a sit-down spot
// tagged with meal_takeaway (nearly all restaurants are) still comes back.
// So for "Quick Bites" we search broadly, then keep only results whose own
// primaryType is actually a grab-and-go type.
const QUICK_BITE_TYPES = new Set([
  'fast_food_restaurant', 'sandwich_shop', 'bakery', 'hamburger_restaurant',
  'hot_dog_restaurant', 'pizza_restaurant', 'bagel_shop', 'coffee_shop',
  'donut_shop', 'ice_cream_shop', 'juice_shop', 'food_court',
]);

// The same loose matching lets full-service restaurants slip into completely
// unrelated searches too (an acclaimed restaurant tagged tourist_attraction
// shows up under Landmarks, etc.) — so this exclusion applies to every
// category's results, not just the Quick Bites search.
function isUnwantedRestaurant(p) {
  const t = p.primaryType || '';
  const isRestaurantFamily = t === 'restaurant' || t.endsWith('_restaurant');
  return isRestaurantFamily && !QUICK_BITE_TYPES.has(t);
}

// ─── Google encoded polyline decoder (Routes API returns one per route) ───────

function decodePolyline(encoded) {
  if (!encoded) return [];
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

function numberedIcon(n) {
  return L.divIcon({
    className: 'walk-stop-icon',
    html: `<div style="background:${ACCENT};color:#fff;width:26px;height:26px;border-radius:50%;
      display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;
      border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35);">${n}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function buildMapsUrl(stops, mode) {
  if (stops.length < 2) return null;
  const origin = `${stops[0].lat},${stops[0].lng}`;
  const destination = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lng}`;
  const waypoints = stops.slice(1, -1).map(p => `${p.lat},${p.lng}`).join('|');
  const params = new URLSearchParams({
    api: '1', origin, destination,
    travelmode: mode === 'TRANSIT' ? 'transit' : 'walking',
  });
  if (waypoints) params.set('waypoints', waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

// weekdayDescriptions is a 7-item array starting Monday (Google's format,
// e.g. "Monday: 9:00 AM – 5:00 PM") — pull out just today's line.
function todayHoursText(hours) {
  if (!hours || hours.length !== 7) return null;
  const dayIndex = (new Date().getDay() + 6) % 7;
  const line = hours[dayIndex];
  if (!line) return null;
  const sep = line.indexOf(': ');
  return sep >= 0 ? line.slice(sep + 2) : line;
}

function RatingText({ p, style }) {
  if (p.rating == null) return null;
  const count = p.ratingCount ? ` (${p.ratingCount.toLocaleString()})` : '';
  return (
    <span style={{ ...s.ratingText, ...style }}>
      <span style={s.ratingStar}>★</span> {p.rating.toFixed(1)}{count}
    </span>
  );
}

function TodayHours({ p, style }) {
  const today = todayHoursText(p.hours);
  if (!today) return null;
  return (
    <span style={{ ...s.hoursText, ...style }} title={p.hours.join('\n')}>Today: {today}</span>
  );
}

// ─── Map helpers ────────────────────────────────────────────────────────────

function FlyTo({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.flyTo([center.lat, center.lng], 14);
  }, [center, map]);
  return null;
}

function MapCenterTracker({ onMove }) {
  useMapEvents({
    moveend: (e) => {
      const c = e.target.getCenter();
      onMove({ lat: c.lat, lng: c.lng });
    },
  });
  return null;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CityWalkPlanner() {
  const { isAdmin } = useAuth();
  const places = usePlacesAutocomplete();
  const { searchNearby, getDirections } = useWalkPlanner();

  // Location
  const [cityQuery, setCityQuery] = useState('');
  const [citySuggestions, setCitySuggestions] = useState([]);
  const [center, setCenter] = useState(null);
  const [liveMapCenter, setLiveMapCenter] = useState(null);
  const cityDebounceRef = useRef(null);

  // Preferences
  const [selectedCategories, setSelectedCategories] = useState(new Set(['landmarks', 'museums']));
  const [mode, setMode] = useState('WALK');

  // Manually added places
  const [addQuery, setAddQuery] = useState('');
  const [addSuggestions, setAddSuggestions] = useState([]);
  const [addedPlaces, setAddedPlaces] = useState([]);
  const addDebounceRef = useRef(null);

  // Candidate places to choose from
  const [candidates, setCandidates] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [searching, setSearching] = useState(false);

  // Route
  const [stops, setStops] = useState([]);
  const [routeInfo, setRouteInfo] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const dragItem = useRef(null);
  const dragOverItem = useRef(null);

  // Saved walks
  const [savedWalks, setSavedWalks] = useState([]);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const [saveTitle, setSaveTitle] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getDocs(collection(db, 'city_walks'))
      .then(snap => {
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        items.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        setSavedWalks(items);
      })
      .catch(() => {})
      .finally(() => setLoadingSaved(false));
  }, []);

  function toggleCategory(key) {
    setSelectedCategories(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function handleCityInput(val) {
    setCityQuery(val);
    if (!places.ready) return;
    clearTimeout(cityDebounceRef.current);
    cityDebounceRef.current = setTimeout(async () => {
      const preds = await places.predict(val, []); // [] = worldwide, not Canada-restricted
      setCitySuggestions(preds);
    }, 300);
  }

  async function pickCity(pred) {
    setCitySuggestions([]);
    setCityQuery(pred.description);
    const details = await places.getDetails(pred.place_id);
    if (details) setCenter({
      lat: details.lat, lng: details.lng, address: details.address,
      name: details.name || pred.description, country: details.country,
    });
  }

  function useMapAreaAsLocation() {
    if (!liveMapCenter) return;
    setCenter({ ...liveMapCenter, address: 'Custom map area', name: 'Custom map area' });
    setCityQuery('Custom map area');
  }

  function handleAddInput(val) {
    setAddQuery(val);
    if (!places.ready) return;
    clearTimeout(addDebounceRef.current);
    addDebounceRef.current = setTimeout(async () => {
      const preds = await places.predict(val, []);
      setAddSuggestions(preds);
    }, 300);
  }

  async function pickAddedPlace(pred) {
    setAddSuggestions([]);
    setAddQuery('');
    const details = await places.getDetails(pred.place_id);
    if (!details) return;
    setAddedPlaces(prev => prev.some(p => p.placeId === pred.place_id) ? prev : [
      ...prev,
      {
        placeId: pred.place_id, name: details.name || pred.description, lat: details.lat, lng: details.lng,
        mapsUrl: details.mapsUrl, category: 'custom',
        rating: details.rating, ratingCount: details.ratingCount, hours: details.hours,
        categoryLabel: details.categoryLabel, description: details.description,
      },
    ]);
  }

  function removeAddedPlace(placeId) {
    setAddedPlaces(prev => prev.filter(p => p.placeId !== placeId));
  }

  async function handleFindPlaces() {
    if (!center) { setError('Search for a city or pick a location on the map first.'); return; }
    const sightCats = CATEGORIES.filter(c => selectedCategories.has(c.key));
    const foodCats = FOOD_CATEGORIES.filter(c => selectedCategories.has(c.key));
    if (sightCats.length === 0 && foodCats.length === 0) {
      setError('Select at least one category to search.');
      return;
    }

    setError(null);
    setSearching(true);
    setCandidates([]);
    setSelectedIds(new Set());
    setStops([]);
    setRouteInfo(null);
    try {
      const radius = 1500;
      const score = (p) => (p.rating || 3) * Math.log((p.ratingCount || 1) + 1);
      const sameCountry = (p) => !center.country || !p.country || p.country === center.country;
      const addedIds = new Set(addedPlaces.map(p => p.placeId));

      const allCats = [...sightCats, ...foodCats];
      const results = await Promise.all(allCats.map(c =>
        searchNearby({ lat: center.lat, lng: center.lng, radius, includedTypes: c.types, maxResultCount: 15 })
          .then(list => list
            .filter(p => !isUnwantedRestaurant(p) && (c.key !== 'food' || QUICK_BITE_TYPES.has(p.primaryType)))
            .map(p => ({ ...p, category: c.key })))));

      const seen = new Map();
      results.flat().forEach(p => {
        if (p.placeId && !addedIds.has(p.placeId) && !seen.has(p.placeId)) seen.set(p.placeId, p);
      });
      const pool = [...seen.values()].filter(sameCountry).sort((a, b) => score(b) - score(a));

      if (pool.length === 0 && addedPlaces.length === 0) {
        setError('No places found nearby — try different categories or a wider location.');
        return;
      }

      setCandidates(pool);
      // Pre-check a sensible default so there's a ready-to-go selection,
      // but every result stays visible and togglable.
      const targetStops = Math.max(0, 5 - addedPlaces.length);
      setSelectedIds(new Set(pool.slice(0, targetStops).map(p => p.placeId)));
    } finally {
      setSearching(false);
    }
  }

  function toggleCandidate(placeId) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(placeId)) next.delete(placeId); else next.add(placeId);
      return next;
    });
  }

  async function computeRoute(stopsArr, optimize) {
    const origin = stopsArr[0];
    const destination = stopsArr[stopsArr.length - 1];
    const intermediates = stopsArr.slice(1, -1);
    const result = await getDirections({ origin, destination, intermediates, mode, optimize });
    if (!result) return null;
    // Google's Routes API can return a sentinel like [-1] instead of [0] when
    // there's only one intermediate to "optimize" — guard against bad indices.
    let orderedIntermediates = intermediates;
    if (optimize && Array.isArray(result.order) && result.order.length === intermediates.length &&
        result.order.every(i => i >= 0 && i < intermediates.length)) {
      orderedIntermediates = result.order.map(i => intermediates[i]);
    }
    return { result, orderedStops: [origin, ...orderedIntermediates, destination] };
  }

  async function handleBuildRoute() {
    const selected = candidates.filter(p => selectedIds.has(p.placeId));
    const combined = [...addedPlaces, ...selected];
    if (combined.length < 2) {
      setError('Select at least 2 places (or add specific ones) to build a route.');
      return;
    }
    setError(null);
    setGenerating(true);
    try {
      const outcome = await computeRoute(combined, true);
      if (!outcome) {
        setError('Could not compute a route between these stops.');
        return;
      }
      setStops(outcome.orderedStops);
      setRouteInfo(outcome.result);
    } finally {
      setGenerating(false);
    }
  }

  async function handleRecalculate() {
    if (stops.length < 2) return;
    setGenerating(true);
    setError(null);
    try {
      const outcome = await computeRoute(stops, false);
      if (outcome) setRouteInfo(outcome.result);
      else setError('Could not recompute the route.');
    } finally {
      setGenerating(false);
    }
  }

  function removeStop(idx) {
    setStops(prev => prev.filter((_, i) => i !== idx));
    setRouteInfo(null);
  }

  function handleDragStart(idx) { dragItem.current = idx; }
  function handleDragEnter(idx) { dragOverItem.current = idx; }
  function handleDragEnd() {
    if (dragItem.current === null || dragOverItem.current === null) return;
    setStops(prev => {
      const list = [...prev];
      const [moved] = list.splice(dragItem.current, 1);
      list.splice(dragOverItem.current, 0, moved);
      return list;
    });
    dragItem.current = null;
    dragOverItem.current = null;
    setRouteInfo(null);
  }

  const mapsUrl = buildMapsUrl(stops, mode);

  async function handleSaveWalk() {
    if (!isAdmin || stops.length < 2) return;
    setSaving(true);
    try {
      const walk = {
        title: saveTitle.trim() || center?.name || center?.address || 'Untitled walk',
        city: center?.address || center?.name || '',
        center: { lat: center.lat, lng: center.lng },
        mode,
        stops: stops.map(s => ({
          placeId: s.placeId, name: s.name, lat: s.lat, lng: s.lng, mapsUrl: s.mapsUrl || null,
          category: s.category || null, rating: s.rating ?? null, ratingCount: s.ratingCount ?? null,
          hours: s.hours || null, categoryLabel: s.categoryLabel || null, description: s.description || null,
        })),
        routeInfo: routeInfo ? {
          distanceMeters: routeInfo.distanceMeters, encodedPolyline: routeInfo.encodedPolyline,
        } : null,
        mapsUrl,
        createdAt: serverTimestamp(),
      };
      const docRef = await addDoc(collection(db, 'city_walks'), walk);
      setSavedWalks(prev => [{ id: docRef.id, ...walk }, ...prev]);
      setSaveTitle('');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteWalk(id) {
    await deleteDoc(doc(db, 'city_walks', id));
    setSavedWalks(prev => prev.filter(w => w.id !== id));
  }

  function handleLoadWalk(walk) {
    setCenter({ lat: walk.center.lat, lng: walk.center.lng, address: walk.city, name: walk.city });
    setCityQuery(walk.city || '');
    setStops(walk.stops.map(s => ({ ...s })));
    setMode(walk.mode || 'WALK');
    setRouteInfo(walk.routeInfo || null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const routeCoords = routeInfo?.encodedPolyline ? decodePolyline(routeInfo.encodedPolyline) : [];
  const initialMapCenter = [20, 0];

  return (
    <div style={s.page}>
      <PageHeader title="City Walk Planner" subtitle="Build an optimized walking route through any city and export it to Google Maps." />

      {error && <div style={s.errorBox}>{error}</div>}

      <div style={s.formCard}>
        {/* Location */}
        <div style={s.field}>
          <label style={s.label}>City or area</label>
          <div style={{ position: 'relative' }}>
            <input style={s.input} value={cityQuery} onChange={e => handleCityInput(e.target.value)}
              placeholder="Search for a city or neighborhood..." />
            {citySuggestions.length > 0 && (
              <ul style={s.suggestions}>
                {citySuggestions.map(p => (
                  <li key={p.place_id} style={s.suggestion} onClick={() => pickCity(p)}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    {p.description}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" style={s.linkBtn} onClick={useMapAreaAsLocation} disabled={!liveMapCenter}>
            Use current map view as location instead
          </button>
          {center && <div style={s.locationConfirm}>📍 {center.address || center.name}</div>}
        </div>

        {/* Categories */}
        <div style={s.field}>
          <label style={s.label}>What do you want to see?</label>
          <div style={s.pillRow}>
            {CATEGORIES.map(c => (
              <TagPill key={c.key} label={c.label} active={selectedCategories.has(c.key)} onClick={() => toggleCategory(c.key)} />
            ))}
          </div>
        </div>

        <div style={s.field}>
          <label style={s.label}>Food &amp; drink stops</label>
          <div style={s.pillRow}>
            {FOOD_CATEGORIES.map(c => (
              <TagPill key={c.key} label={c.label} active={selectedCategories.has(c.key)} onClick={() => toggleCategory(c.key)} />
            ))}
          </div>
        </div>

        {/* Add specific place */}
        <div style={{ ...s.field, position: 'relative' }}>
          <label style={s.label}>Add a specific place (optional)</label>
          <input style={s.input} value={addQuery} onChange={e => handleAddInput(e.target.value)}
            placeholder="Search for a named place to include..." />
          {addSuggestions.length > 0 && (
            <ul style={s.suggestions}>
              {addSuggestions.map(p => (
                <li key={p.place_id} style={s.suggestion} onClick={() => pickAddedPlace(p)}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  {p.description}
                </li>
              ))}
            </ul>
          )}
          {addedPlaces.length > 0 && (
            <div style={{ ...s.pillRow, marginTop: 6 }}>
              {addedPlaces.map(p => (
                <span key={p.placeId} style={s.chip}>
                  {p.name}
                  <button type="button" style={s.chipRemove} onClick={() => removeAddedPlace(p.placeId)}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Mode */}
        <div style={s.field}>
          <label style={s.label}>Getting around</label>
          <div style={s.pillRow}>
            <TagPill label="Walking" active={mode === 'WALK'} onClick={() => setMode('WALK')} />
            <TagPill label="Transit" active={mode === 'TRANSIT'} onClick={() => setMode('TRANSIT')} />
          </div>
        </div>

        <button style={{ ...s.generateBtn, opacity: searching ? 0.6 : 1 }} disabled={searching} onClick={handleFindPlaces}>
          {searching ? 'Searching...' : 'Find places'}
        </button>
      </div>

      {/* Candidate places to choose from */}
      {candidates.length > 0 && (
        <div style={s.formCard}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={s.sectionTitle}>Found {candidates.length} places</h3>
            <p style={s.routeSummary}>{selectedIds.size + addedPlaces.length} selected</p>
          </div>
          <p style={s.hint}>Check the ones you want to visit, then build your route.</p>
          <ul style={s.candidateList}>
            {candidates.map((p, idx) => {
              const checked = selectedIds.has(p.placeId);
              const baseBg = checked ? 'rgba(192, 98, 47, 0.06)' : 'transparent';
              const hoverBg = checked ? 'rgba(192, 98, 47, 0.1)' : 'var(--color-bg)';
              return (
                <li key={p.placeId}
                  style={{
                    ...s.candidateItem,
                    borderBottom: idx === candidates.length - 1 ? 'none' : s.candidateItem.borderBottom,
                    borderLeftColor: checked ? 'var(--color-accent)' : 'transparent',
                  }}>
                  <label style={{ ...s.candidateRow, background: baseBg }}
                    onMouseEnter={e => { e.currentTarget.style.background = hoverBg; }}
                    onMouseLeave={e => { e.currentTarget.style.background = baseBg; }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleCandidate(p.placeId)} style={s.checkbox} />
                    <div style={s.candidateMain}>
                      <span style={s.candidateName}>{p.name}</span>
                      <div style={s.candidateMetaTop}>
                        {p.categoryLabel && <span style={s.categoryPill}>{p.categoryLabel}</span>}
                        <RatingText p={p} />
                      </div>
                      {p.description && <p style={s.candidateDesc}>{p.description}</p>}
                    </div>
                    <TodayHours p={p} style={s.hoursCorner} />
                  </label>
                </li>
              );
            })}
          </ul>
          <button style={{ ...s.generateBtn, opacity: generating ? 0.6 : 1 }} disabled={generating}
            onClick={handleBuildRoute}>
            {generating ? 'Building route...' : 'Build route'}
          </button>
        </div>
      )}

      {/* Map */}
      <div style={s.mapWrapper}>
        <MapContainer center={initialMapCenter} zoom={2} style={{ height: '100%', width: '100%', borderRadius: 12 }} scrollWheelZoom={true}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapCenterTracker onMove={setLiveMapCenter} />
          <FlyTo center={center} />
          {routeCoords.length > 0 && <Polyline positions={routeCoords} pathOptions={{ color: ACCENT, weight: 4, opacity: 0.8 }} />}
          {stops.map((p, i) => (
            <Marker key={p.placeId || i} position={[p.lat, p.lng]} icon={numberedIcon(i + 1)}>
              <Popup>
                <strong>{i + 1}. {p.name}</strong>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0' }}>
                  {p.categoryLabel && <span style={s.categoryPill}>{p.categoryLabel}</span>}
                  <RatingText p={p} />
                </div>
                <TodayHours p={p} />
                {p.description && (
                  <p style={{ ...s.candidateDesc, margin: '4px 0 0' }}>{p.description}</p>
                )}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* Stop list */}
      {stops.length > 0 && (
        <div style={s.formCard}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={s.sectionTitle}>Your route ({stops.length} stops)</h3>
            {routeInfo && (
              <p style={s.routeSummary}>{(routeInfo.distanceMeters / 1000).toFixed(1)} km</p>
            )}
          </div>
          <p style={s.hint}>Drag to reorder, then recalculate to update the route.</p>
          <ul style={s.stopList}>
            {stops.map((p, i) => (
              <li key={p.placeId || i} style={s.stopItem} draggable
                onDragStart={() => handleDragStart(i)}
                onDragEnter={() => handleDragEnter(i)}
                onDragEnd={handleDragEnd}
                onDragOver={e => e.preventDefault()}>
                <span style={s.stopHandle}>⠿</span>
                <span style={s.stopNumber}>{i + 1}</span>
                <div style={s.stopMain}>
                  <span style={s.stopName}>{p.name}</span>
                  <div style={s.stopMetaRow}>
                    {p.categoryLabel && <span style={s.categoryPill}>{p.categoryLabel}</span>}
                    <RatingText p={p} />
                  </div>
                </div>
                <TodayHours p={p} style={s.hoursCorner} />
                <button type="button" style={{ ...s.deleteBtn, marginTop: -2 }} title="Remove" onClick={() => removeStop(i)}>×</button>
              </li>
            ))}
          </ul>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: '0.75rem' }}>
            <button style={s.secondaryBtn} disabled={generating || stops.length < 2} onClick={handleRecalculate}>
              Recalculate route
            </button>
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={s.exportBtn}>
                Open in Google Maps →
              </a>
            )}
          </div>

          {isAdmin && (
            <div style={s.saveRow}>
              <input style={{ ...s.input, flex: 1 }} value={saveTitle} onChange={e => setSaveTitle(e.target.value)}
                placeholder="Name this route to save it..." />
              <button style={{ ...s.secondaryBtn, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={handleSaveWalk}>
                {saving ? 'Saving...' : 'Save route'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Saved walks */}
      {!loadingSaved && savedWalks.length > 0 && (
        <div style={s.formCard}>
          <h3 style={s.sectionTitle}>Saved walks</h3>
          <div style={s.grid}>
            {savedWalks.map(w => (
              <div key={w.id} style={s.savedCard}>
                {isAdmin && (
                  <button style={{ ...s.deleteBtn, position: 'absolute', top: 4, right: 4 }} title="Delete"
                    onClick={() => handleDeleteWalk(w.id)}>×</button>
                )}
                <h4 style={s.savedTitle}>{w.title}</h4>
                <p style={s.savedMeta}>{w.city} · {w.stops?.length || 0} stops</p>
                <button type="button" style={s.linkBtn} onClick={() => handleLoadWalk(w)}>View this route →</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  page: {
    maxWidth: 900, margin: '0 auto', padding: '2rem 1.5rem 4rem',
    fontFamily: 'var(--font-body)',
  },
  errorBox: {
    border: '1px solid #c0392b', color: '#c0392b', borderRadius: 8,
    padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.9rem',
  },
  formCard: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: 12, padding: '1.5rem', marginBottom: '1.5rem',
    display: 'flex', flexDirection: 'column', gap: '1.1rem',
  },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: {
    fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  input: {
    padding: '0.55rem 0.75rem', fontSize: '0.9rem', fontFamily: 'var(--font-body)',
    border: '1px solid var(--color-border)', borderRadius: 6,
    background: 'var(--color-bg)', color: 'var(--color-text)', outline: 'none',
    width: '100%', boxSizing: 'border-box',
  },
  suggestions: {
    position: 'absolute', top: '100%', left: 0, right: 0,
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: 8, listStyle: 'none', margin: '4px 0 0', padding: 0,
    zIndex: 500, maxHeight: 200, overflowY: 'auto',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  },
  suggestion: {
    padding: '0.5rem 0.75rem', fontSize: '0.85rem', cursor: 'pointer', transition: 'background 0.1s',
  },
  locationConfirm: { fontSize: '0.8rem', color: 'var(--color-accent)', marginTop: 4 },
  pillRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem',
    padding: '3px 6px 3px 10px', borderRadius: 9999, background: 'var(--color-bg)',
    border: '1px solid var(--color-border)', color: 'var(--color-text)',
  },
  chipRemove: {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem',
    lineHeight: 1, color: 'var(--color-text-muted)', padding: 0,
  },
  linkBtn: {
    background: 'none', border: 'none', color: 'var(--color-accent)', fontSize: '0.8rem',
    cursor: 'pointer', padding: 0, textAlign: 'left', textDecoration: 'underline',
  },
  generateBtn: {
    padding: '0.65rem 1.5rem', fontSize: '0.95rem', fontFamily: 'var(--font-body)', fontWeight: 600,
    background: 'var(--color-accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  mapWrapper: {
    height: 420, borderRadius: 12, overflow: 'hidden',
    border: '1px solid var(--color-border)', marginBottom: '1.5rem',
  },
  sectionTitle: { margin: 0, fontFamily: 'var(--font-display)', fontSize: '1.2rem' },
  routeSummary: { margin: 0, fontSize: '0.9rem', color: 'var(--color-text-muted)' },
  hint: { margin: 0, fontSize: '0.8rem', color: 'var(--color-text-muted)' },
  stopList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  stopItem: {
    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '0.6rem 0.75rem',
    background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 8, cursor: 'grab',
  },
  stopHandle: { color: 'var(--color-text-muted)', fontSize: '1rem', marginTop: 2 },
  stopNumber: {
    width: 22, height: 22, borderRadius: '50%', background: 'var(--color-accent)', color: '#fff',
    fontSize: '0.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, marginTop: 1,
  },
  stopMain: { flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  stopName: { fontSize: '0.92rem', fontWeight: 500 },
  stopMetaRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  candidateList: {
    listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column',
    maxHeight: 460, overflowY: 'auto',
  },
  candidateItem: {
    borderBottom: '1px solid var(--color-border)', borderLeft: '3px solid transparent',
    transition: 'border-color 0.15s',
  },
  candidateRow: {
    display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer',
    padding: '0.7rem 0.75rem', borderRadius: 6, transition: 'background 0.12s',
  },
  candidateMain: { flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  candidateName: { fontSize: '0.95rem', fontWeight: 600, color: 'var(--color-text)' },
  candidateDesc: {
    margin: 0, fontSize: '0.82rem', color: 'var(--color-text-muted)', lineHeight: 1.45, fontStyle: 'italic',
  },
  candidateMetaTop: { display: 'flex', alignItems: 'center', gap: 8 },
  hoursCorner: { flexShrink: 0, marginTop: 2, marginLeft: 8 },
  checkbox: { width: 16, height: 16, marginTop: 3, accentColor: 'var(--color-accent)', cursor: 'pointer', flexShrink: 0 },
  categoryPill: {
    fontSize: '0.72rem', padding: '2px 9px', borderRadius: 9999, fontWeight: 600,
    background: 'rgba(192, 98, 47, 0.08)', color: 'var(--color-accent)',
    border: 'none', whiteSpace: 'nowrap',
  },
  ratingText: {
    fontSize: '0.85rem', color: 'var(--color-text)', whiteSpace: 'nowrap',
  },
  ratingStar: { color: 'var(--color-accent)' },
  hoursText: {
    fontSize: '0.78rem', color: 'var(--color-text-muted)', whiteSpace: 'nowrap',
    borderBottom: '1px dotted var(--color-text-muted)', cursor: 'help',
  },
  deleteBtn: {
    background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer',
    color: 'var(--color-text-muted)', lineHeight: 1, padding: '2px 6px',
  },
  secondaryBtn: {
    padding: '0.5rem 1.1rem', fontSize: '0.85rem', fontFamily: 'var(--font-body)', fontWeight: 600,
    background: 'none', border: '1px solid var(--color-accent)', color: 'var(--color-accent)',
    borderRadius: 6, cursor: 'pointer',
  },
  exportBtn: {
    padding: '0.5rem 1.1rem', fontSize: '0.85rem', fontFamily: 'var(--font-body)', fontWeight: 600,
    background: 'var(--color-accent)', color: '#fff', borderRadius: 6, textDecoration: 'none',
    display: 'inline-flex', alignItems: 'center',
  },
  saveRow: { display: 'flex', gap: 8, marginTop: '0.5rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1rem' },
  savedCard: {
    position: 'relative', background: 'var(--color-bg)', border: '1px solid var(--color-border)',
    borderLeft: '4px solid var(--color-accent)', borderRadius: 10, padding: '1rem',
  },
  savedTitle: { margin: '0 0 4px', fontSize: '1rem', fontFamily: 'var(--font-display)' },
  savedMeta: { margin: '0 0 8px', fontSize: '0.8rem', color: 'var(--color-text-muted)' },
};
