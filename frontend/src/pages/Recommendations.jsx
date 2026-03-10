import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import PageHeader from '../components/PageHeader';
import TagPill from '../components/TagPill';
import { createSearch, search } from '../lib/fuzzySearch';

// Fix Leaflet default marker icons (CSS import doesn't include them)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ─── Constants ────────────────────────────────────────────────────────────────

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// ─── Google Places Autocomplete Hook ──────────────────────────────────────────

function usePlacesAutocomplete() {
  const [ready, setReady] = useState(false);
  const serviceRef = useRef(null);

  useEffect(() => {
    if (!GOOGLE_MAPS_API_KEY) return;
    if (window.google?.maps?.places) {
      serviceRef.current = new window.google.maps.places.AutocompleteService();
      setReady(true);
      return;
    }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places`;
    script.async = true;
    script.onload = () => {
      serviceRef.current = new window.google.maps.places.AutocompleteService();
      setReady(true);
    };
    document.head.appendChild(script);
  }, []);

  const predict = useCallback((input) => {
    if (!serviceRef.current || !input.trim()) return Promise.resolve([]);
    return new Promise((resolve) => {
      serviceRef.current.getPlacePredictions({ input }, (results, status) => {
        if (status === window.google.maps.places.PlacesServiceStatus.OK && results) {
          resolve(results);
        } else {
          resolve([]);
        }
      });
    });
  }, []);

  const getDetails = useCallback((placeId) => {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      const svc = new window.google.maps.places.PlacesService(el);
      svc.getDetails({ placeId, fields: ['geometry', 'formatted_address', 'name', 'url'] }, (place, status) => {
        if (status === window.google.maps.places.PlacesServiceStatus.OK && place) {
          resolve({
            lat: place.geometry.location.lat(),
            lng: place.geometry.location.lng(),
            address: place.formatted_address,
            name: place.name,
            mapsUrl: place.url,
          });
        } else {
          resolve(null);
        }
      });
    });
  }, []);

  return { ready, predict, getDetails };
}

// ─── Map helper: fly to bounds when markers change ────────────────────────────

function FitBounds({ markers }) {
  const map = useMap();
  useEffect(() => {
    if (markers.length === 0) return;
    const bounds = L.latLngBounds(markers.map(m => [m.lat, m.lng]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  }, [markers, map]);
  return null;
}

// ─── Recommendation Form (Add / Edit) ─────────────────────────────────────────

function RecForm({ onSave, onCancel, places, initial }) {
  const editing = !!initial;
  const [title, setTitle] = useState(initial?.title || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [tags, setTags] = useState(initial?.tags?.join(', ') || '');
  const [url, setUrl] = useState(initial?.url || '');
  // Location
  const [addressQuery, setAddressQuery] = useState(initial?.location?.address || '');
  const [suggestions, setSuggestions] = useState([]);
  const [location, setLocation] = useState(initial?.location || null);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef(null);

  function handleAddressInput(val) {
    setAddressQuery(val);
    if (!places.ready) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const preds = await places.predict(val);
      setSuggestions(preds);
    }, 300);
  }

  async function pickSuggestion(pred) {
    setSuggestions([]);
    setAddressQuery(pred.description);
    const details = await places.getDetails(pred.place_id);
    if (details) setLocation(details);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    const rec = {
      title: title.trim(),
      description: description.trim(),
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      url: url.trim() || null,
      location: location || null,
      ...(editing ? { updatedAt: serverTimestamp() } : { createdAt: serverTimestamp() }),
    };
    try {
      await onSave(rec);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={s.form}>
      <h3 style={s.formTitle}>{editing ? 'Edit Recommendation' : 'Add Recommendation'}</h3>

      <div style={s.formGrid}>
        <div style={s.field}>
          <label style={s.label}>Title *</label>
          <input style={s.input} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Sushi Masato" />
        </div>

        <div style={{ ...s.field, gridColumn: '1 / -1' }}>
          <label style={s.label}>Description</label>
          <textarea style={{ ...s.input, minHeight: 80, resize: 'vertical' }} value={description}
            onChange={e => setDescription(e.target.value)} placeholder="Why do you recommend this?" />
        </div>

        <div style={s.field}>
          <label style={s.label}>Tags (comma-separated)</label>
          <input style={s.input} value={tags} onChange={e => setTags(e.target.value)} placeholder="e.g. sushi, date night, omakase" />
        </div>

        <div style={s.field}>
          <label style={s.label}>URL</label>
          <input style={s.input} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." />
        </div>

        <div style={{ ...s.field, position: 'relative' }}>
          <label style={s.label}>Address</label>
          <input style={s.input} value={addressQuery} onChange={e => handleAddressInput(e.target.value)}
            placeholder={places.ready ? 'Search for a place...' : 'Set Google Maps API key to enable'} disabled={!places.ready} />
          {suggestions.length > 0 && (
            <ul style={s.suggestions}>
              {suggestions.map(p => (
                <li key={p.place_id} style={s.suggestion} onClick={() => pickSuggestion(p)}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  {p.description}
                </li>
              ))}
            </ul>
          )}
          {location && (
            <div style={s.locationConfirm}>
              📍 {location.address}
            </div>
          )}
        </div>
      </div>

      <div style={s.formActions}>
        <button type="button" onClick={onCancel} style={s.cancelBtn}>Cancel</button>
        <button type="submit" disabled={saving || !title.trim()} style={{ ...s.saveBtn, opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ─── Recommendation Card ──────────────────────────────────────────────────────

function RecCard({ rec, isAdmin, onDelete, onEdit }) {
  return (
    <div style={s.card}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}>
      {isAdmin && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginBottom: 4 }}>
          <button style={s.editBtn} title="Edit" onClick={() => onEdit(rec)}>✎</button>
          <button style={s.deleteBtn} title="Delete" onClick={() => onDelete(rec.id)}>×</button>
        </div>
      )}
      <h3 style={s.cardTitle}>
        {rec.url ? (
          <a href={rec.url} target="_blank" rel="noopener noreferrer" style={s.cardLink}>{rec.title}</a>
        ) : rec.title}
      </h3>
      {rec.description && <p style={s.cardDesc}>{rec.description}</p>}
      {rec.location?.address && (
        <p style={s.cardAddress}>
          <a href={rec.location.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${rec.location.lat},${rec.location.lng}`}
            target="_blank" rel="noopener noreferrer" style={s.addressLink}>
            📍 {rec.location.address}
          </a>
        </p>
      )}
      {rec.tags?.length > 0 && (
        <div style={s.cardTags}>
          {rec.tags.map(t => <span key={t} style={s.tag}>{t}</span>)}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Recommendations() {
  const { isAdmin } = useAuth();
  const [recs, setRecs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingRec, setEditingRec] = useState(null); // rec being edited, or null for add
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState(new Set());
  const places = usePlacesAutocomplete();

  // Load recommendations
  useEffect(() => {
    getDocs(collection(db, 'recommendations'))
      .then(snap => {
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        items.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        setRecs(items);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Fuzzy search index
  const fuse = useMemo(() => createSearch(recs, ['title', 'description', 'tags', 'location.address']), [recs]);

  // All unique tags across recommendations
  const allTags = useMemo(() => {
    const tagSet = new Set();
    recs.forEach(r => (r.tags || []).forEach(t => tagSet.add(t)));
    return [...tagSet].sort();
  }, [recs]);

  // Filtered results
  const filtered = useMemo(() => {
    let items = query.trim() ? (search(fuse, query) || recs) : recs;
    if (activeTags.size > 0) {
      items = items.filter(r => (r.tags || []).some(t => activeTags.has(t)));
    }
    return items;
  }, [recs, fuse, query, activeTags]);

  // Markers for map
  const markers = useMemo(() => filtered.filter(r => r.location?.lat && r.location?.lng), [filtered]);

  async function handleSave(rec) {
    if (editingRec) {
      // Update existing
      await updateDoc(doc(db, 'recommendations', editingRec.id), rec);
      setRecs(prev => prev.map(r => r.id === editingRec.id ? { ...r, ...rec } : r));
    } else {
      // Add new
      const docRef = await addDoc(collection(db, 'recommendations'), rec);
      const newRec = { id: docRef.id, ...rec };
      setRecs(prev => [newRec, ...prev]);
    }
    setShowForm(false);
    setEditingRec(null);
  }

  function handleEdit(rec) {
    setEditingRec(rec);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleDelete(id) {
    await deleteDoc(doc(db, 'recommendations', id));
    setRecs(prev => prev.filter(r => r.id !== id));
  }

  function toggleTag(tag) {
    setActiveTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }

  if (loading) {
    return (
      <div style={s.page}>
        <PageHeader title="Recommendations" subtitle="Places and things that I like." />
        <p style={{ color: 'var(--color-text-muted)' }}>Loading...</p>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <PageHeader title="Recommendations" subtitle="Places and things that I like." />

      {/* Admin add button */}
      {isAdmin && !showForm && (
        <button style={s.addBtn} onClick={() => { setEditingRec(null); setShowForm(true); }}>+ Add Recommendation</button>
      )}

      {/* Add/Edit form */}
      {isAdmin && showForm && (
        <RecForm key={editingRec?.id || 'new'} onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingRec(null); }}
          places={places} initial={editingRec} />
      )}

      {/* Map */}
      {markers.length > 0 && (
        <div style={s.mapWrapper}>
          <MapContainer center={[markers[0].location.lat, markers[0].location.lng]} zoom={4}
            style={{ height: '100%', width: '100%', borderRadius: 12 }} scrollWheelZoom={false}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <FitBounds markers={markers.map(m => m.location)} />
            {markers.map(m => (
              <Marker key={m.id} position={[m.location.lat, m.location.lng]}>
                <Popup>
                  <strong>{m.title}</strong>
                  {m.location.address && <br />}
                  {m.location.address}
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      )}

      {/* Filters */}
      {recs.length > 0 && (
        <div style={s.filters}>
          <input style={s.searchInput} value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search recommendations..." />

          {allTags.length > 0 && (
            <div style={s.pillRow}>
              {allTags.map(t => (
                <TagPill key={t} label={t} active={activeTags.has(t)} onClick={() => toggleTag(t)} />
              ))}
            </div>
          )}

          <p style={s.resultCount}>
            {filtered.length === recs.length ? `${recs.length} recommendations` : `${filtered.length} of ${recs.length}`}
          </p>
        </div>
      )}

      {/* Cards */}
      {filtered.length > 0 ? (
        <div style={s.grid}>
          {filtered.map(r => (
            <RecCard key={r.id} rec={r} isAdmin={isAdmin} onDelete={handleDelete} onEdit={handleEdit} />
          ))}
        </div>
      ) : recs.length > 0 ? (
        <p style={{ color: 'var(--color-text-muted)', textAlign: 'center', marginTop: '2rem' }}>
          No recommendations match your filters.
        </p>
      ) : (
        <p style={{ color: 'var(--color-text-muted)', textAlign: 'center', marginTop: '2rem' }}>
          No recommendations yet.
        </p>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  page: {
    maxWidth: 1100, margin: '0 auto', padding: '2rem 1.5rem 4rem',
    fontFamily: 'var(--font-body)',
  },
  // Map
  mapWrapper: {
    height: 360, borderRadius: 12, overflow: 'hidden',
    border: '1px solid var(--color-border)', marginBottom: '1.5rem',
  },
  // Filters
  filters: {
    marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem',
  },
  searchInput: {
    width: '100%', padding: '0.6rem 1rem', fontSize: '0.95rem',
    fontFamily: 'var(--font-body)', border: '1px solid var(--color-border)',
    borderRadius: 8, background: 'var(--color-surface)', color: 'var(--color-text)',
    outline: 'none', boxSizing: 'border-box',
  },
  pillRow: {
    display: 'flex', flexWrap: 'wrap', gap: 6,
  },
  resultCount: {
    margin: 0, fontSize: '0.85rem', color: 'var(--color-text-muted)',
  },
  // Grid
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '1rem',
  },
  // Card
  card: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderLeft: '4px solid var(--color-accent)', borderRadius: 10, padding: '1.25rem',
    transition: 'transform 0.15s, box-shadow 0.15s',
  },
  editBtn: {
    background: 'none', border: 'none', fontSize: '1rem', cursor: 'pointer',
    color: 'var(--color-text-muted)', lineHeight: 1, padding: '2px 6px',
  },
  deleteBtn: {
    background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer',
    color: 'var(--color-text-muted)', lineHeight: 1, padding: '2px 6px',
  },
  cardTitle: {
    margin: '0 0 6px', fontSize: '1.1rem', fontFamily: 'var(--font-display)',
    color: 'var(--color-text)',
  },
  cardLink: {
    color: 'var(--color-text)', textDecoration: 'none',
    borderBottom: '1px solid var(--color-border)', transition: 'border-color 0.15s',
  },
  cardDesc: {
    margin: '0 0 8px', fontSize: '0.9rem', color: 'var(--color-text-muted)', lineHeight: 1.5,
  },
  cardAddress: {
    margin: '0 0 8px', fontSize: '0.85rem',
  },
  addressLink: {
    color: 'var(--color-text-muted)', textDecoration: 'none',
    transition: 'color 0.15s',
  },
  cardTags: {
    display: 'flex', flexWrap: 'wrap', gap: 4,
  },
  tag: {
    fontSize: '0.75rem', padding: '2px 8px', borderRadius: 9999,
    background: 'var(--color-bg)', color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
  },
  // Add button
  addBtn: {
    marginBottom: '1.5rem', padding: '0.5rem 1.25rem', fontSize: '0.9rem',
    fontFamily: 'var(--font-body)', fontWeight: 600,
    background: 'var(--color-accent)', color: '#fff', border: 'none',
    borderRadius: 8, cursor: 'pointer', transition: 'background 0.15s',
  },
  // Form
  form: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: 12, padding: '1.5rem', marginBottom: '1.5rem',
  },
  formTitle: {
    margin: '0 0 1rem', fontFamily: 'var(--font-display)', fontSize: '1.3rem',
  },
  formGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem',
  },
  field: {
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  label: {
    fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  input: {
    padding: '0.5rem 0.75rem', fontSize: '0.9rem', fontFamily: 'var(--font-body)',
    border: '1px solid var(--color-border)', borderRadius: 6,
    background: 'var(--color-bg)', color: 'var(--color-text)', outline: 'none',
    width: '100%', boxSizing: 'border-box',
  },
  suggestions: {
    position: 'absolute', top: '100%', left: 0, right: 0,
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: 8, listStyle: 'none', margin: '4px 0 0', padding: 0,
    zIndex: 10, maxHeight: 200, overflowY: 'auto',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  },
  suggestion: {
    padding: '0.5rem 0.75rem', fontSize: '0.85rem', cursor: 'pointer',
    transition: 'background 0.1s',
  },
  locationConfirm: {
    fontSize: '0.8rem', color: 'var(--color-accent)', marginTop: 4,
  },
  formActions: {
    display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: '1rem',
  },
  cancelBtn: {
    padding: '0.45rem 1rem', fontSize: '0.85rem', fontFamily: 'var(--font-body)',
    background: 'none', border: '1px solid var(--color-border)', borderRadius: 6,
    cursor: 'pointer', color: 'var(--color-text-muted)',
  },
  saveBtn: {
    padding: '0.45rem 1.25rem', fontSize: '0.85rem', fontFamily: 'var(--font-body)',
    fontWeight: 600, background: 'var(--color-accent)', color: '#fff', border: 'none',
    borderRadius: 6, cursor: 'pointer',
  },
};
