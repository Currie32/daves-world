import { useState, useEffect, useMemo, useCallback } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';
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

const METRO_VAN_CENTER = [49.2488, -122.8], // roughly centered on the Tri-Cities
  DEFAULT_ZOOM = 10;

// Registry keys must match `EVENT_SOURCES` in functions/main.py
const EVENT_SOURCES = [
  { key: 'coquitlam', label: 'City of Coquitlam' },
  { key: 'port_moody', label: 'City of Port Moody' },
  { key: 'port_coquitlam', label: 'City of Port Coquitlam' },
  { key: 'tourism_coquitlam', label: 'Tourism Coquitlam' },
  { key: 'destination_vancouver', label: 'Destination Vancouver' },
  { key: 'metro_vancouver_parks', label: 'Metro Vancouver Regional Parks' },
  { key: 'tourism_burnaby', label: 'Tourism Burnaby' },
  { key: 'new_westminster', label: 'City of New Westminster' },
];

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// ─── Date helpers ──────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysUntil(dateStr) {
  const start = new Date(dateStr + 'T00:00:00');
  const today = new Date(todayStr() + 'T00:00:00');
  return Math.max(0, Math.round((start - today) / 86400000));
}

// Soonest events render as a dark blue marker, fading to light blue for events
// further out (capped at MARKER_HORIZON_DAYS so distant dates don't all look identical).
const MARKER_HORIZON_DAYS = 60;
const MARKER_COLOR_NEAR = [13, 71, 161];   // dark blue
const MARKER_COLOR_FAR = [190, 224, 251];  // light blue

function markerColor(dateStr) {
  const t = Math.min(1, daysUntil(dateStr) / MARKER_HORIZON_DAYS);
  const [r, g, b] = MARKER_COLOR_NEAR.map((c, i) => Math.round(c + (MARKER_COLOR_FAR[i] - c) * t));
  return `rgb(${r}, ${g}, ${b})`;
}

function markerIcon(dateStr) {
  return L.divIcon({
    className: 'events-marker-icon',
    html: `<span style="display:block;width:16px;height:16px;border-radius:50%;background:${markerColor(dateStr)};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8],
  });
}

function fmtDateStr(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatEventDate(ev) {
  if (ev.endDate && ev.endDate !== ev.startDate) {
    return `${fmtDateStr(ev.startDate)} – ${fmtDateStr(ev.endDate)}`;
  }
  return fmtDateStr(ev.startDate);
}

// Does the event overlap the [from, to] filter range? (either bound may be empty)
function overlapsRange(ev, from, to) {
  const start = ev.startDate;
  const end = ev.endDate || ev.startDate;
  if (from && end < from) return false;
  if (to && start > to) return false;
  return true;
}

function eventSpanDays(ev) {
  if (!ev.endDate || ev.endDate === ev.startDate) return 0;
  return (new Date(ev.endDate) - new Date(ev.startDate)) / 86400000;
}

// Multi-week exhibitions/listings match every day in their range, which would
// otherwise crowd out one-off events on the same day - so short/single-day
// events sort first, with day-spanning listings pushed toward "+N more".
function eventsOnDate(events, dateStr) {
  return events
    .filter(ev => ev.startDate <= dateStr && (ev.endDate || ev.startDate) >= dateStr)
    .sort((a, b) => eventSpanDays(a) - eventSpanDays(b));
}

// Build a 6-week (42-cell) grid of date strings (or null for padding) for a given month
function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push(dateStr);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// ─── Price helpers ──────────────────────────────────────────────────────────────

function priceLabel(price) {
  if (!price || price.isFree) return 'Free';
  return price.text || 'Paid';
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

// ─── Responsive helper ─────────────────────────────────────────────────────────

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
}

// ─── Event Card ─────────────────────────────────────────────────────────────

function EventCard({ ev }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={s.card}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}>
      <h3 style={s.cardTitle}>
        {ev.url ? (
          <a href={ev.url} target="_blank" rel="noopener noreferrer" style={s.cardLink}>{ev.title}</a>
        ) : ev.title}
      </h3>
      <p style={s.cardMeta}>
        {formatEventDate(ev)}{ev.timeText ? ` · ${ev.timeText}` : ''}
      </p>
      {ev.description && (
        <>
          <p style={expanded ? s.cardDesc : s.cardDescClamped}>{ev.description}</p>
          {ev.description.length > 120 && (
            <button type="button" style={s.showMoreBtn} onClick={() => setExpanded(v => !v)}>
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
      {ev.location?.address && (
        <p style={s.cardAddress}>
          <a href={ev.location.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${ev.location.lat},${ev.location.lng}`}
            target="_blank" rel="noopener noreferrer" style={s.addressLink}>
            📍 {ev.location.name || ev.location.address}
          </a>
        </p>
      )}
      <div style={s.cardFooter}>
        <span style={{ ...s.priceBadge, ...(ev.price?.isFree ? s.priceFree : s.pricePaid) }}>
          {priceLabel(ev.price)}
        </span>
        {ev.price && !ev.price.isFree && ev.price.advancePurchase && (
          <span style={s.advanceBadge}>Buy in advance</span>
        )}
        {ev.price?.ticketUrl && (
          <a href={ev.price.ticketUrl} target="_blank" rel="noopener noreferrer" style={s.ticketLink}>Tickets →</a>
        )}
      </div>
      {ev.tags?.length > 0 && (
        <div style={s.cardTags}>
          {ev.tags.map(t => <span key={t} style={s.tag}>{t}</span>)}
        </div>
      )}
    </div>
  );
}

// ─── Calendar (month grid) view ────────────────────────────────────────────

function CalendarView({ events, month, onChangeMonth, selectedDate, onSelectDate }) {
  const year = month.getFullYear();
  const monthIdx = month.getMonth();
  const cells = useMemo(() => buildMonthGrid(year, monthIdx), [year, monthIdx]);
  const today = todayStr();
  const isMobile = useIsMobile();
  const maxVisible = isMobile ? 1 : 3;

  return (
    <div style={s.calendarWrapper}>
      <div style={s.calendarNav}>
        <button style={s.navBtn} onClick={() => onChangeMonth(-1)}>‹</button>
        <h3 style={s.calendarMonthLabel}>{MONTH_LABELS[monthIdx]} {year}</h3>
        <button style={s.navBtn} onClick={() => onChangeMonth(1)}>›</button>
      </div>
      <div style={s.calendarGrid}>
        {DAY_LABELS.map(d => <div key={d} style={s.calendarDayLabel}>{d}</div>)}
        {cells.map((dateStr, i) => {
          if (!dateStr) return <div key={i} style={s.calendarCellEmpty} />;
          const dayEvents = eventsOnDate(events, dateStr);
          const isToday = dateStr === today;
          const isSelected = dateStr === selectedDate;
          const visible = dayEvents.slice(0, maxVisible);
          const overflowCount = dayEvents.length - visible.length;
          return (
            <div key={i} style={{
              ...s.calendarCell,
              ...(isMobile ? s.calendarCellMobile : {}),
              ...(isToday ? s.calendarCellToday : {}),
              ...(isSelected ? s.calendarCellSelected : {}),
            }} onClick={() => onSelectDate(dateStr)}>
              <span style={s.calendarCellDate}>{parseInt(dateStr.slice(-2), 10)}</span>
              {visible.length > 0 && (
                <div style={s.calendarCellEvents}>
                  {isMobile ? (
                    <span style={s.calendarDot}>{dayEvents.length > 3 ? '●●●' : '●'.repeat(dayEvents.length)}</span>
                  ) : (
                    <>
                      {visible.map(ev => (
                        <button key={ev.id} type="button" style={s.calendarEventChip}
                          onClick={e => { e.stopPropagation(); onSelectDate(dateStr); }}>
                          <span style={s.calendarEventTitle}>{ev.title}</span>
                          <span style={s.calendarEventMeta}>
                            {ev.allDay || !ev.timeText ? 'All day' : ev.timeText}
                            {ev.location?.name ? ` · ${ev.location.name}` : ''}
                          </span>
                        </button>
                      ))}
                      {overflowCount > 0 && (
                        <button type="button" style={s.calendarEventMore}
                          onClick={e => { e.stopPropagation(); onSelectDate(dateStr); }}>
                          +{overflowCount} more
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Events() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState(new Set());
  const [activeCities, setActiveCities] = useState(new Set());
  const [freeOnly, setFreeOnly] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [view, setView] = useState('list'); // 'list' | 'calendar'
  const [calendarMonth, setCalendarMonth] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [selectedDate, setSelectedDate] = useState(null);

  const loadEvents = useCallback(() => {
    setLoading(true);
    return getDocs(collection(db, 'events'))
      .then(snap => {
        const today = todayStr();
        const items = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(e => (e.endDate || e.startDate) >= today);
        items.sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));
        setEvents(items);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // Fuzzy search index
  const fuse = useMemo(() => createSearch(events, ['title', 'description', 'tags', 'location.name', 'location.address']), [events]);

  // All unique tags across events
  const allTags = useMemo(() => {
    const tagSet = new Set();
    events.forEach(e => (e.tags || []).forEach(t => tagSet.add(t)));
    return [...tagSet].sort();
  }, [events]);

  // All unique cities across events
  const allCities = useMemo(() => {
    const citySet = new Set();
    events.forEach(e => { if (e.city) citySet.add(e.city); });
    return [...citySet].sort();
  }, [events]);

  // Filtered results (search + tags + cities + free + date range), sorted chronologically
  const filtered = useMemo(() => {
    let items = query.trim() ? (search(fuse, query) || events) : events;
    if (activeTags.size > 0) {
      items = items.filter(e => (e.tags || []).some(t => activeTags.has(t)));
    }
    if (activeCities.size > 0) {
      items = items.filter(e => e.city && activeCities.has(e.city));
    }
    if (freeOnly) {
      items = items.filter(e => e.price?.isFree);
    }
    if (dateFrom || dateTo) {
      items = items.filter(e => overlapsRange(e, dateFrom, dateTo));
    }
    return [...items].sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));
  }, [events, fuse, query, activeTags, activeCities, freeOnly, dateFrom, dateTo]);

  // Group list view by date
  const grouped = useMemo(() => {
    const groups = [];
    let lastDate = null;
    for (const ev of filtered) {
      if (ev.startDate !== lastDate) {
        groups.push({ date: ev.startDate, events: [] });
        lastDate = ev.startDate;
      }
      groups[groups.length - 1].events.push(ev);
    }
    return groups;
  }, [filtered]);

  // Markers for map
  const markers = useMemo(() => filtered.filter(e => e.location?.lat && e.location?.lng), [filtered]);

  // Events for the selected calendar day
  const dayEvents = useMemo(() => selectedDate ? eventsOnDate(filtered, selectedDate) : [], [filtered, selectedDate]);

  function toggleTag(tag) {
    setActiveTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }

  function toggleCity(city) {
    setActiveCities(prev => {
      const next = new Set(prev);
      if (next.has(city)) next.delete(city); else next.add(city);
      return next;
    });
  }

  function changeCalendarMonth(delta) {
    setCalendarMonth(prev => {
      const d = new Date(prev);
      d.setMonth(d.getMonth() + delta);
      return d;
    });
  }

  if (loading) {
    return (
      <div style={s.page}>
        <PageHeader title="Events" subtitle="Things to do around Metro Vancouver" />
        <p style={{ color: 'var(--color-text-muted)' }}>Loading...</p>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <PageHeader title="Events" subtitle="Things to do around Metro Vancouver" />

      {/* Map */}
      {markers.length > 0 && (
        <div style={s.mapWrapper}>
          <MapContainer center={METRO_VAN_CENTER} zoom={DEFAULT_ZOOM}
            style={{ height: '100%', width: '100%', borderRadius: 12 }} scrollWheelZoom={false}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <FitBounds markers={markers.map(m => m.location)} />
            {markers.map(m => (
              <Marker key={m.id} position={[m.location.lat, m.location.lng]} icon={markerIcon(m.startDate)}>
                <Popup>
                  <strong>{m.title}</strong><br />
                  {formatEventDate(m)}
                  {m.location.address && <><br />{m.location.address}</>}
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      )}

      {/* Filters */}
      {events.length > 0 && (
        <div style={s.filters}>
          <input style={s.searchInput} value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search events..." />

          <div style={s.filterRow}>
            <label style={s.dateFieldLabel}>
              From
              <input type="date" style={s.dateInput} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </label>
            <label style={s.dateFieldLabel}>
              To
              <input type="date" style={s.dateInput} value={dateTo} onChange={e => setDateTo(e.target.value)} min={dateFrom} />
            </label>
            {(dateFrom || dateTo) && (
              <button type="button" style={s.clearDatesBtn} onClick={() => { setDateFrom(''); setDateTo(''); }}>Clear dates</button>
            )}
            <TagPill label="Free only" active={freeOnly} onClick={() => setFreeOnly(v => !v)} />
          </div>

          {allCities.length > 0 && (
            <div style={s.filterGroup}>
              <span style={s.filterGroupLabel}>City</span>
              <div style={s.pillRow}>
                {allCities.map(c => (
                  <TagPill key={c} label={c} active={activeCities.has(c)} onClick={() => toggleCity(c)} />
                ))}
              </div>
            </div>
          )}

          {allTags.length > 0 && (
            <div style={s.filterGroup}>
              <span style={s.filterGroupLabel}>Tags</span>
              <div style={s.pillRow}>
                {allTags.map(t => (
                  <TagPill key={t} label={t} active={activeTags.has(t)} onClick={() => toggleTag(t)} />
                ))}
              </div>
            </div>
          )}

          <div style={s.viewToggleRow}>
            <div style={s.viewToggle}>
              <button style={{ ...s.viewToggleBtn, ...(view === 'list' ? s.viewToggleBtnActive : {}) }}
                onClick={() => setView('list')}>List</button>
              <button style={{ ...s.viewToggleBtn, ...(view === 'calendar' ? s.viewToggleBtnActive : {}) }}
                onClick={() => setView('calendar')}>Calendar</button>
            </div>
            <p style={s.resultCount}>
              {filtered.length === events.length ? `${events.length} events` : `${filtered.length} of ${events.length}`}
            </p>
          </div>
        </div>
      )}

      {/* Calendar view */}
      {view === 'calendar' && filtered.length > 0 && (
        <>
          <CalendarView events={filtered} month={calendarMonth} onChangeMonth={changeCalendarMonth}
            selectedDate={selectedDate} onSelectDate={d => setSelectedDate(d === selectedDate ? null : d)} />
          {selectedDate && (
            <div style={{ marginTop: '1.5rem' }}>
              <h3 style={s.dayHeading}>{fmtDateStr(selectedDate)}</h3>
              {dayEvents.length > 0 ? (
                <div style={s.grid}>
                  {dayEvents.map(e => (
                    <EventCard key={e.id} ev={e} />
                  ))}
                </div>
              ) : (
                <p style={{ color: 'var(--color-text-muted)' }}>No events on this day.</p>
              )}
            </div>
          )}
        </>
      )}

      {/* List view */}
      {view === 'list' && (
        filtered.length > 0 ? (
          <div>
            {grouped.map(group => (
              <div key={group.date} style={s.dateGroup}>
                <h3 style={s.dateGroupHeading}>{fmtDateStr(group.date)}</h3>
                <div style={s.grid}>
                  {group.events.map(e => (
                    <EventCard key={e.id} ev={e} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : events.length > 0 ? (
          <p style={{ color: 'var(--color-text-muted)', textAlign: 'center', marginTop: '2rem' }}>
            No events match your filters.
          </p>
        ) : (
          <p style={{ color: 'var(--color-text-muted)', textAlign: 'center', marginTop: '2rem' }}>
            No events yet.
          </p>
        )
      )}

      {view === 'calendar' && filtered.length === 0 && (
        <p style={{ color: 'var(--color-text-muted)', textAlign: 'center', marginTop: '2rem' }}>
          {events.length > 0 ? 'No events match your filters.' : 'No events yet.'}
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
  filterRow: {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
  },
  dateFieldLabel: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem',
    color: 'var(--color-text-muted)',
  },
  dateInput: {
    padding: '0.35rem 0.5rem', fontSize: '0.85rem', fontFamily: 'var(--font-body)',
    border: '1px solid var(--color-border)', borderRadius: 6,
    background: 'var(--color-surface)', color: 'var(--color-text)', outline: 'none',
  },
  clearDatesBtn: {
    padding: '0.3rem 0.6rem', fontSize: '0.75rem', fontFamily: 'var(--font-body)',
    background: 'none', border: '1px solid var(--color-border)', borderRadius: 6,
    cursor: 'pointer', color: 'var(--color-text-muted)',
  },
  pillRow: {
    display: 'flex', flexWrap: 'wrap', gap: 6,
  },
  filterGroup: {
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  filterGroupLabel: {
    fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
    color: 'var(--color-text-muted)',
  },
  viewToggleRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
  },
  viewToggle: {
    display: 'flex', border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden',
  },
  viewToggleBtn: {
    padding: '0.4rem 1rem', fontSize: '0.85rem', fontFamily: 'var(--font-body)',
    background: 'var(--color-surface)', border: 'none', cursor: 'pointer',
    color: 'var(--color-text-muted)',
  },
  viewToggleBtnActive: {
    background: 'var(--color-accent)', color: '#fff',
  },
  resultCount: {
    margin: 0, fontSize: '0.85rem', color: 'var(--color-text-muted)',
  },
  // Calendar
  calendarWrapper: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: 12, padding: '1.25rem', marginBottom: '1rem',
  },
  calendarNav: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem',
  },
  calendarMonthLabel: {
    margin: 0, fontFamily: 'var(--font-display)', fontSize: '1.2rem',
  },
  navBtn: {
    background: 'none', border: '1px solid var(--color-border)', borderRadius: 6,
    width: 32, height: 32, fontSize: '1rem', cursor: 'pointer', color: 'var(--color-text)',
  },
  calendarGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4,
  },
  calendarDayLabel: {
    textAlign: 'center', fontSize: '0.75rem', fontWeight: 600,
    color: 'var(--color-text-muted)', padding: '4px 0',
  },
  calendarCellEmpty: {
    minHeight: 52,
  },
  calendarCell: {
    minHeight: 52, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch',
    gap: 3, border: '1px solid var(--color-border)', padding: '4px 3px',
    borderRadius: 8, background: 'var(--color-bg)', cursor: 'pointer',
    fontFamily: 'var(--font-body)', overflow: 'hidden',
  },
  calendarCellMobile: {
    minHeight: 34, padding: '3px 2px', gap: 1,
  },
  calendarDot: {
    fontSize: '0.5rem', color: 'var(--color-accent)', textAlign: 'center', lineHeight: 1,
  },
  calendarCellToday: {
    borderColor: 'var(--color-accent)',
  },
  calendarCellSelected: {
    background: 'rgba(192, 98, 47, 0.08)', borderColor: 'var(--color-accent)',
  },
  calendarCellDate: {
    fontSize: '0.8rem', fontWeight: 600, padding: '0 2px',
  },
  calendarCellEvents: {
    display: 'flex', flexDirection: 'column', gap: 2,
  },
  calendarEventChip: {
    display: 'flex', flexDirection: 'column', alignItems: 'stretch', textAlign: 'left',
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderLeft: '3px solid var(--color-accent)', borderRadius: 4,
    padding: '2px 4px', cursor: 'pointer', font: 'inherit', color: 'var(--color-text)',
    minWidth: 0,
  },
  calendarEventTitle: {
    fontSize: '0.68rem', fontWeight: 600, lineHeight: 1.25,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  calendarEventMeta: {
    fontSize: '0.62rem', color: 'var(--color-text-muted)', lineHeight: 1.25,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  calendarEventMore: {
    background: 'none', border: 'none', padding: '1px 4px', cursor: 'pointer',
    font: 'inherit', fontSize: '0.62rem', fontWeight: 600, color: 'var(--color-accent)',
    textAlign: 'left',
  },
  dayHeading: {
    margin: '0 0 0.75rem', fontFamily: 'var(--font-display)', fontSize: '1.2rem',
  },
  // Date groups (list view)
  dateGroup: {
    marginBottom: '1.5rem',
  },
  dateGroupHeading: {
    margin: '0 0 0.75rem', fontFamily: 'var(--font-display)', fontSize: '1.05rem',
    color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)', paddingBottom: 6,
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
  cardTitle: {
    margin: '0 0 4px', fontSize: '1.1rem', fontFamily: 'var(--font-display)',
    color: 'var(--color-text)',
  },
  cardLink: {
    color: 'var(--color-text)', textDecoration: 'none',
    borderBottom: '1px solid var(--color-border)', transition: 'border-color 0.15s',
  },
  cardMeta: {
    margin: '0 0 8px', fontSize: '0.8rem', color: 'var(--color-accent)', fontWeight: 600,
  },
  cardDesc: {
    margin: '0 0 8px', fontSize: '0.9rem', color: 'var(--color-text-muted)', lineHeight: 1.5,
  },
  cardDescClamped: {
    margin: '0 0 8px', fontSize: '0.9rem', color: 'var(--color-text-muted)', lineHeight: 1.5,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  showMoreBtn: {
    background: 'none', border: 'none', padding: 0, marginBottom: 8, cursor: 'pointer',
    fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-accent)',
  },
  cardAddress: {
    margin: '0 0 8px', fontSize: '0.85rem',
  },
  addressLink: {
    color: 'var(--color-text-muted)', textDecoration: 'none',
    transition: 'color 0.15s',
  },
  cardFooter: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8,
  },
  priceBadge: {
    fontSize: '0.75rem', fontWeight: 600, padding: '2px 8px', borderRadius: 9999,
  },
  priceFree: {
    background: '#e6f4ea', color: '#2e7d4f',
  },
  pricePaid: {
    background: '#fdf0e6', color: 'var(--color-accent)',
  },
  advanceBadge: {
    fontSize: '0.7rem', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)',
    padding: '2px 8px', borderRadius: 9999,
  },
  ticketLink: {
    fontSize: '0.8rem', color: 'var(--color-accent)', textDecoration: 'none', fontWeight: 600,
  },
  cardTags: {
    display: 'flex', flexWrap: 'wrap', gap: 4,
  },
  tag: {
    fontSize: '0.75rem', padding: '2px 8px', borderRadius: 9999,
    background: 'var(--color-bg)', color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
  },
};
