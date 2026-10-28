import { useState, useEffect } from 'react';
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db, app } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';
import PageHeader from '../components/PageHeader';

const functions = getFunctions(app, 'us-west1');
const previewPriceSource = httpsCallable(functions, 'preview_price_source');
const checkPricesNow = httpsCallable(functions, 'check_prices_now');
const findRetailerSources = httpsCallable(functions, 'find_retailer_sources');

function fmtPrice(n) {
  return n == null ? '—' : `$${n.toFixed(2)}`;
}

function fmtWhen(ts) {
  if (!ts?.seconds) return 'never';
  const d = new Date(ts.seconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ─── Sparkline ─────────────────────────────────────────────────────────────

function Sparkline({ points }) {
  if (points.length < 2) return null;
  const w = 240, h = 48, pad = 4;
  const prices = points.map(p => p.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - ((p.price - min) / range) * (h - pad * 2);
    return [x, y];
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
      {coords.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === coords.length - 1 ? 2.5 : 1.5} fill="var(--color-accent)" />
      ))}
    </svg>
  );
}

// ─── Add / Edit Form ─────────────────────────────────────────────────────────

function WatchForm({ onSave, onCancel, initial }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [kind, setKind] = useState(initial?.kind || 'item');
  const [targetPrice, setTargetPrice] = useState(initial?.targetPrice ?? '');
  const [matchTerms, setMatchTerms] = useState(initial?.matchTerms?.join(', ') || '');
  const [excludeTerms, setExcludeTerms] = useState(initial?.excludeTerms?.join(', ') || '');
  const [sources, setSources] = useState(
    initial?.sources?.map(src => ({ ...src, status: 'idle', preview: null })) || [{ url: '', retailer: '', status: 'idle', preview: null }]
  );
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [selectedCandidates, setSelectedCandidates] = useState(new Set());

  function updateSource(i, patch) {
    setSources(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  }

  function addSourceRow() {
    setSources(prev => [...prev, { url: '', retailer: '', status: 'idle', preview: null }]);
  }

  function removeSourceRow(i) {
    setSources(prev => prev.filter((_, idx) => idx !== i));
  }

  async function testSource(i) {
    const src = sources[i];
    if (!src.url.trim()) return;
    updateSource(i, { status: 'testing' });
    try {
      const terms = kind === 'category' ? matchTerms.split(',').map(t => t.trim()).filter(Boolean) : [];
      const excludes = kind === 'category' ? excludeTerms.split(',').map(t => t.trim()).filter(Boolean) : [];
      const { data } = await previewPriceSource({
        url: src.url.trim(),
        kind: kind === 'category' ? 'listing' : 'product',
        matchTerms: terms,
        excludeTerms: excludes,
      });
      updateSource(i, { status: 'ok', preview: data, retailer: data.retailer });
    } catch (e) {
      updateSource(i, { status: 'error', preview: null, error: e.message || 'Could not fetch price' });
    }
  }

  async function handleFindRetailers() {
    if (!name.trim()) return;
    setSearching(true);
    setCandidates(null);
    setSelectedCandidates(new Set());
    try {
      const terms = kind === 'category' ? matchTerms.split(',').map(t => t.trim()).filter(Boolean) : [];
      const { data } = await findRetailerSources({ name: name.trim(), matchTerms: terms });
      setCandidates(data.candidates || []);
    } catch (e) {
      setCandidates([]);
    } finally {
      setSearching(false);
    }
  }

  function toggleCandidate(url) {
    setSelectedCandidates(prev => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }

  function addSelectedCandidates() {
    const toAdd = candidates.filter(c => selectedCandidates.has(c.url));
    setSources(prev => {
      const withoutEmpty = prev.filter(s => s.url.trim());
      const added = toAdd.map(c => ({ url: c.url, retailer: c.retailer, status: 'idle', preview: null }));
      return [...withoutEmpty, ...added];
    });
    setCandidates(null);
    setSelectedCandidates(new Set());
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const validSources = sources.filter(s => s.url.trim());
    if (validSources.length === 0) return;
    setSaving(true);

    const lowestTested = validSources
      .map(s => s.preview?.price)
      .filter(p => p != null);
    const baselinePrice = editing
      ? initial.baselinePrice
      : (lowestTested.length ? Math.min(...lowestTested) : null);

    const watch = {
      name: name.trim(),
      kind,
      targetPrice: targetPrice === '' ? null : Number(targetPrice),
      matchTerms: kind === 'category' ? matchTerms.split(',').map(t => t.trim()).filter(Boolean) : [],
      excludeTerms: kind === 'category' ? excludeTerms.split(',').map(t => t.trim()).filter(Boolean) : [],
      sources: validSources.map(s => ({
        url: s.url.trim(),
        retailer: s.retailer || s.preview?.retailer || '',
        kind: kind === 'category' ? 'listing' : 'product',
      })),
      active: true,
      notifyEmail: 'david.currie32@gmail.com',
      ...(editing ? { updatedAt: serverTimestamp() } : {
        baselinePrice,
        lastNotifiedPrice: null,
        createdAt: serverTimestamp(),
      }),
    };
    try {
      await onSave(watch);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}
      onKeyDown={e => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') e.preventDefault(); }}
      style={s.form}>
      <h3 style={s.formTitle}>{editing ? 'Edit Watch' : 'Add Watch'}</h3>

      <div style={s.formGrid}>
        <div style={s.field}>
          <label style={s.label}>Name *</label>
          <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Thule roof box" />
        </div>

        <div style={s.field}>
          <label style={s.label}>Type</label>
          <select style={s.input} value={kind} onChange={e => setKind(e.target.value)} disabled={editing}>
            <option value="item">Specific item</option>
            <option value="category">Category (any matching product)</option>
          </select>
        </div>

        <div style={s.field}>
          <label style={s.label}>Target price (optional)</label>
          <input style={s.input} type="number" step="0.01" value={targetPrice}
            onChange={e => setTargetPrice(e.target.value)} placeholder="e.g. 400" />
        </div>

        {kind === 'category' && (
          <>
            <div style={s.field}>
              <label style={s.label}>Must include (comma-separated)</label>
              <input style={s.input} value={matchTerms} onChange={e => setMatchTerms(e.target.value)}
                placeholder="e.g. thule, box" />
            </div>
            <div style={s.field}>
              <label style={s.label}>Exclude (comma-separated)</label>
              <input style={s.input} value={excludeTerms} onChange={e => setExcludeTerms(e.target.value)}
                placeholder="e.g. mount, strap, rack" />
            </div>
          </>
        )}
      </div>

      <div style={{ marginTop: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={s.label}>Retailer {kind === 'category' ? 'listing pages' : 'product pages'}</label>
          <button type="button" style={s.findBtn} onClick={handleFindRetailers} disabled={searching || !name.trim()}>
            {searching ? 'Searching…' : '🔍 Find retailer pages'}
          </button>
        </div>

        {candidates && (
          <div style={s.candidateBox}>
            {candidates.length === 0 ? (
              <p style={s.candidateEmpty}>No results found.</p>
            ) : (
              <>
                {candidates.map(c => (
                  <label key={c.url} style={s.candidateRow}>
                    <input type="checkbox" checked={selectedCandidates.has(c.url)}
                      onChange={() => toggleCandidate(c.url)} />
                    <span style={s.candidateTitle}>{c.title}</span>
                    <span style={{ ...s.candidateBadge, ...(c.known ? s.candidateBadgeKnown : {}) }}>
                      {c.retailer}
                    </span>
                  </label>
                ))}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                  <button type="button" style={s.cancelBtn} onClick={() => setCandidates(null)}>Dismiss</button>
                  <button type="button" style={s.testBtn} onClick={addSelectedCandidates}
                    disabled={selectedCandidates.size === 0}>
                    Add selected ({selectedCandidates.size})
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {sources.map((src, i) => (
          <div key={i} style={s.sourceRow}>
            <input style={{ ...s.input, flex: 1 }} value={src.url}
              onChange={e => updateSource(i, { url: e.target.value, status: 'idle', preview: null })}
              placeholder="https://..." />
            <button type="button" style={s.testBtn} onClick={() => testSource(i)} disabled={src.status === 'testing'}>
              {src.status === 'testing' ? 'Testing…' : 'Test'}
            </button>
            {sources.length > 1 && (
              <button type="button" style={s.removeBtn} onClick={() => removeSourceRow(i)}>×</button>
            )}
            {src.status === 'ok' && (
              <span style={s.testOk}>✓ {src.preview.retailer}: {fmtPrice(src.preview.price)}{src.preview.offerCount > 1 ? ` (${src.preview.offerCount} matches)` : ''}</span>
            )}
            {src.status === 'error' && <span style={s.testErr}>✕ {src.error}</span>}
          </div>
        ))}
        <button type="button" style={s.addSourceBtn} onClick={addSourceRow}>+ Add retailer</button>
      </div>

      <div style={s.formActions}>
        <button type="button" onClick={onCancel} style={s.cancelBtn}>Cancel</button>
        <button type="submit" disabled={saving || !name.trim()} style={{ ...s.saveBtn, opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ─── Watch Card ────────────────────────────────────────────────────────────

function WatchCard({ watch, isAdmin, onEdit, onDelete }) {
  const [history, setHistory] = useState([]);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    getDocs(collection(db, 'price_watches', watch.id, 'history'))
      .then(snap => {
        const items = snap.docs.map(d => d.data()).filter(d => d.lowest?.price != null);
        items.sort((a, b) => a.date.localeCompare(b.date));
        setHistory(items.map(d => ({ date: d.date, price: d.lowest.price })));
      })
      .catch(() => {});
  }, [watch.id]);

  async function handleCheckNow() {
    setChecking(true);
    try {
      await checkPricesNow({ watchId: watch.id });
      window.location.reload();
    } finally {
      setChecking(false);
    }
  }

  const lowest = watch.lowestNow;
  const baseline = watch.baselinePrice;
  const pctOff = lowest?.price != null && baseline ? Math.round((1 - lowest.price / baseline) * 100) : null;
  const errors = watch.lastErrors && Object.entries(watch.lastErrors);

  return (
    <div style={s.card}>
      {isAdmin && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginBottom: 4 }}>
          <button style={s.iconBtn} title="Check now" onClick={handleCheckNow} disabled={checking}>
            {checking ? '⟳' : '↻'}
          </button>
          <button style={s.iconBtn} title="Edit" onClick={() => onEdit(watch)}>✎</button>
          <button style={{ ...s.iconBtn, fontSize: '1.2rem' }} title="Delete" onClick={() => onDelete(watch.id)}>×</button>
        </div>
      )}

      <h3 style={s.cardTitle}>{watch.name}</h3>
      <p style={s.cardMeta}>{watch.kind === 'category' ? 'Category watch' : 'Specific item'} · checked {fmtWhen(watch.lastCheckedAt)}</p>

      <div style={s.priceRow}>
        <div>
          <div style={s.priceNow}>{fmtPrice(lowest?.price)}</div>
          {lowest?.retailer && (
            <a href={lowest.url} target="_blank" rel="noopener noreferrer" style={s.priceRetailer}>
              at {lowest.retailer}{lowest.title ? ` — ${lowest.title}` : ''}
            </a>
          )}
        </div>
        {pctOff != null && pctOff !== 0 && (
          <span style={{ ...s.pctBadge, color: pctOff > 0 ? '#2f7a3f' : 'var(--color-text-muted)' }}>
            {pctOff > 0 ? `${pctOff}% off baseline` : `${Math.abs(pctOff)}% above baseline`}
          </span>
        )}
      </div>

      <p style={s.cardSub}>
        Baseline {fmtPrice(baseline)}
        {watch.targetPrice != null && ` · Target ${fmtPrice(watch.targetPrice)}`}
        {watch.allTimeLow && ` · All-time low ${fmtPrice(watch.allTimeLow.price)} (${watch.allTimeLow.retailer})`}
      </p>

      {history.length > 1 && (
        <div style={{ margin: '0.5rem 0' }}>
          <Sparkline points={history} />
        </div>
      )}

      <div style={s.sourceChips}>
        {watch.sources?.map(src => {
          const err = watch.lastErrors?.[src.retailer];
          return (
            <a key={src.url} href={src.url} target="_blank" rel="noopener noreferrer"
              style={{ ...s.chip, ...(err ? s.chipErr : {}) }} title={err || 'OK'}>
              {src.retailer}{err ? ' ⚠' : ''}
            </a>
          );
        })}
      </div>
      {errors?.length > 0 && (
        <p style={s.errorText}>
          {errors.map(([r, e]) => `${r}: ${e}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────

export default function PriceTracker() {
  const { isAdmin } = useAuth();
  const [watches, setWatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingWatch, setEditingWatch] = useState(null);

  useEffect(() => {
    getDocs(collection(db, 'price_watches'))
      .then(snap => {
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        items.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        setWatches(items);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(watch) {
    if (editingWatch) {
      await updateDoc(doc(db, 'price_watches', editingWatch.id), watch);
      setWatches(prev => prev.map(w => w.id === editingWatch.id ? { ...w, ...watch } : w));
    } else {
      const docRef = await addDoc(collection(db, 'price_watches'), watch);
      setWatches(prev => [{ id: docRef.id, ...watch }, ...prev]);
    }
    setShowForm(false);
    setEditingWatch(null);
  }

  function handleEdit(watch) {
    setEditingWatch(watch);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this price watch?')) return;
    await deleteDoc(doc(db, 'price_watches', id));
    setWatches(prev => prev.filter(w => w.id !== id));
  }

  if (loading) {
    return (
      <div style={s.page}>
        <PageHeader title="Price Tracker" subtitle="Watch items and get emailed when they get cheaper." />
        <p style={{ color: 'var(--color-text-muted)' }}>Loading...</p>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <PageHeader title="Price Tracker" subtitle="Watch items and get emailed when they get cheaper." />

      {isAdmin && !showForm && (
        <button style={s.addBtn} onClick={() => { setEditingWatch(null); setShowForm(true); }}>+ Add Watch</button>
      )}

      {isAdmin && showForm && (
        <WatchForm key={editingWatch?.id || 'new'} onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingWatch(null); }}
          initial={editingWatch} />
      )}

      {watches.length > 0 ? (
        <div style={s.grid}>
          {watches.map(w => (
            <WatchCard key={w.id} watch={w} isAdmin={isAdmin} onEdit={handleEdit} onDelete={handleDelete} />
          ))}
        </div>
      ) : (
        <p style={{ color: 'var(--color-text-muted)', textAlign: 'center', marginTop: '2rem' }}>
          No watches yet.
        </p>
      )}
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const s = {
  page: {
    maxWidth: 1100, margin: '0 auto', padding: '2rem 1.5rem 4rem',
    fontFamily: 'var(--font-body)',
  },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '1rem',
  },
  card: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderLeft: '4px solid var(--color-accent)', borderRadius: 10, padding: '1.25rem',
  },
  iconBtn: {
    background: 'none', border: 'none', fontSize: '1rem', cursor: 'pointer',
    color: 'var(--color-text-muted)', lineHeight: 1, padding: '2px 6px',
  },
  cardTitle: {
    margin: '0 0 2px', fontSize: '1.1rem', fontFamily: 'var(--font-display)',
    color: 'var(--color-text)',
  },
  cardMeta: {
    margin: '0 0 10px', fontSize: '0.8rem', color: 'var(--color-text-muted)',
  },
  priceRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
  },
  priceNow: {
    fontSize: '1.6rem', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1.1,
  },
  priceRetailer: {
    fontSize: '0.8rem', color: 'var(--color-text-muted)', textDecoration: 'none',
  },
  pctBadge: {
    fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap',
  },
  cardSub: {
    margin: '8px 0 0', fontSize: '0.8rem', color: 'var(--color-text-muted)',
  },
  sourceChips: {
    display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: '0.75rem',
  },
  chip: {
    fontSize: '0.72rem', padding: '2px 8px', borderRadius: 9999,
    background: 'var(--color-bg)', color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)', textDecoration: 'none',
  },
  chipErr: {
    borderColor: '#c0622f', color: '#c0622f',
  },
  errorText: {
    margin: '6px 0 0', fontSize: '0.72rem', color: 'var(--color-text-muted)',
  },
  addBtn: {
    marginBottom: '1.5rem', padding: '0.5rem 1.25rem', fontSize: '0.9rem',
    fontFamily: 'var(--font-body)', fontWeight: 600,
    background: 'var(--color-accent)', color: '#fff', border: 'none',
    borderRadius: 8, cursor: 'pointer',
  },
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
  sourceRow: {
    display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap',
  },
  testBtn: {
    padding: '0.5rem 0.75rem', fontSize: '0.8rem', fontFamily: 'var(--font-body)',
    background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 6,
    cursor: 'pointer', color: 'var(--color-text)',
  },
  removeBtn: {
    background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer',
    color: 'var(--color-text-muted)', lineHeight: 1, padding: '0 6px',
  },
  testOk: {
    fontSize: '0.78rem', color: '#2f7a3f', width: '100%',
  },
  testErr: {
    fontSize: '0.78rem', color: '#c0622f', width: '100%',
  },
  addSourceBtn: {
    marginTop: 8, padding: '0.4rem 0.9rem', fontSize: '0.8rem', fontFamily: 'var(--font-body)',
    background: 'none', border: '1px dashed var(--color-border)', borderRadius: 6,
    cursor: 'pointer', color: 'var(--color-text-muted)',
  },
  findBtn: {
    padding: '0.35rem 0.8rem', fontSize: '0.78rem', fontFamily: 'var(--font-body)',
    background: 'none', border: '1px solid var(--color-border)', borderRadius: 6,
    cursor: 'pointer', color: 'var(--color-text)',
  },
  candidateBox: {
    marginTop: 8, padding: '0.75rem', border: '1px solid var(--color-border)',
    borderRadius: 8, background: 'var(--color-bg)',
  },
  candidateEmpty: {
    margin: 0, fontSize: '0.85rem', color: 'var(--color-text-muted)',
  },
  candidateRow: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '0.3rem 0',
    fontSize: '0.85rem', cursor: 'pointer',
  },
  candidateTitle: {
    flex: 1, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  candidateBadge: {
    fontSize: '0.7rem', padding: '2px 8px', borderRadius: 9999,
    background: 'var(--color-surface)', color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)', whiteSpace: 'nowrap',
  },
  candidateBadgeKnown: {
    borderColor: 'var(--color-accent)', color: 'var(--color-accent)',
  },
  formActions: {
    display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: '1.25rem',
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
