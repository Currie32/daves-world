import { useState, useEffect, useMemo } from 'react';

// Compares recent observed weather with 1991-2020 daily normals (Open-Meteo archive API).

const NORMALS_START = '1991-01-01';
const NORMALS_END = '2020-12-31';
const NORMALS_KEY = 'weather_normals';
const NORMALS_TTL = 30 * 24 * 60 * 60 * 1000;
const HISTORY_KEY = 'weather_history';
const HISTORY_TTL = 60 * 60 * 1000;

const PERIODS = [
  { id: 'month', label: 'Past Month', days: 30 },
  { id: 'year', label: 'Past Year', days: 365 },
];

const BLUE = '#5b9bd5';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDate(d, days) {
  const n = new Date(d);
  n.setDate(n.getDate() + days);
  return n;
}

function readCache(key, lat, lon, ttl) {
  try {
    const c = JSON.parse(localStorage.getItem(key));
    if (!c || c.lat !== lat || c.lon !== lon || Date.now() - c.timestamp > ttl) return null;
    return c.data;
  } catch {
    return null;
  }
}

function writeCache(key, lat, lon, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ lat, lon, timestamp: Date.now(), data }));
  } catch { /* ignore quota errors */ }
}

const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
const sum = (arr) => arr.reduce((s, v) => s + v, 0);

function signed(v, digits = 1) {
  const r = v.toFixed(digits);
  return v > 0 ? `+${r}` : r;
}

function formatShort(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Centered moving average of the normal temperature across neighboring calendar days (wraps around the year).
function smoothedNormal(normals, date, field, window = 7) {
  const d = new Date(date + 'T12:00:00');
  const half = Math.floor(window / 2);
  const vals = [];
  for (let k = -half; k <= half; k++) {
    const n = normals[isoDate(shiftDate(d, k)).slice(5)];
    if (n) vals.push(n[field]);
  }
  return avg(vals);
}

function formatLong(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatValue(v) {
  return v.toFixed(1);
}

async function fetchArchive(lat, lon, start, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Historical weather API error: ${res.status}`);
  return (await res.json()).daily;
}

// Average mean/high/low temperature and precipitation for each calendar day (MM-DD).
async function loadNormals(lat, lon) {
  const cached = readCache(NORMALS_KEY, lat, lon, NORMALS_TTL);
  if (cached) return cached;

  const d = await fetchArchive(lat, lon, NORMALS_START, NORMALS_END);
  const acc = {};
  d.time.forEach((t, i) => {
    const key = t.slice(5);
    const a = acc[key] || (acc[key] = { mean: [], max: [], min: [], precip: [] });
    if (d.temperature_2m_mean[i] != null) a.mean.push(d.temperature_2m_mean[i]);
    if (d.temperature_2m_max[i] != null) a.max.push(d.temperature_2m_max[i]);
    if (d.temperature_2m_min[i] != null) a.min.push(d.temperature_2m_min[i]);
    if (d.precipitation_sum[i] != null) a.precip.push(d.precipitation_sum[i]);
  });
  const normals = {};
  for (const [key, a] of Object.entries(acc)) {
    normals[key] = {
      mean: avg(a.mean),
      max: avg(a.max),
      min: avg(a.min),
      precip: avg(a.precip),
    };
  }
  writeCache(NORMALS_KEY, lat, lon, normals);
  return normals;
}

async function loadRecent(lat, lon) {
  const cached = readCache(HISTORY_KEY, lat, lon, HISTORY_TTL);
  if (cached) return cached;

  const today = new Date();
  const d = await fetchArchive(lat, lon, isoDate(shiftDate(today, -364)), isoDate(today));
  const days = d.time
    .map((t, i) => ({
      date: t,
      mean: d.temperature_2m_mean[i],
      max: d.temperature_2m_max[i],
      min: d.temperature_2m_min[i],
      precip: d.precipitation_sum[i],
    }))
    .filter((r) => r.mean != null && r.precip != null);
  writeCache(HISTORY_KEY, lat, lon, days);
  return days;
}

// ─── Chart ───────────────────────────────────────────────────────────────────

function LineChart({ title, unit, dates, actual, normal, actualColor, normalLabel = 'Normal' }) {
  const W = 640;
  const H = 180;
  const pad = { l: 38, r: 10, t: 10, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const all = [...actual, ...normal];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) hi = lo + 1;
  const x = (i) => pad.l + (dates.length === 1 ? iw / 2 : (i / (dates.length - 1)) * iw);
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [lo, (lo + hi) / 2, hi];
  const [hover, setHover] = useState(null);

  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = Math.min(1, Math.max(0, (px - pad.l) / iw));
    setHover(Math.round(frac * (dates.length - 1)));
  }
  const labelIdx = [0, Math.floor((dates.length - 1) / 2), dates.length - 1];

  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '10px', padding: '0.9rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.95rem' }}>{title}</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', display: 'flex', gap: '0.9rem' }}>
          <span><span style={{ color: actualColor }}>&#9632;</span> This period</span>
          <span><span style={{ color: 'var(--color-text-muted)' }}>&#9472;</span> {normalLabel}</span>
        </span>
      </div>
      <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={title}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-border)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--color-text-muted)">
              {Math.round(t)}{unit}
            </text>
          </g>
        ))}
        {labelIdx.map((i, k) => (
          <text key={k} x={x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'} fontSize="10" fill="var(--color-text-muted)">
            {formatShort(dates[i])}
          </text>
        ))}
        <path d={path(actual)} fill="none" stroke={actualColor} strokeWidth={2} strokeLinejoin="round" />
        <path d={path(normal)} fill="none" stroke="var(--color-text-muted)" strokeWidth={1.5} strokeDasharray="4 3" />
        {hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--color-text-muted)" strokeWidth={1} opacity={0.5} />
            <circle cx={x(hover)} cy={y(actual[hover])} r={4} fill={actualColor} stroke="var(--color-surface)" strokeWidth={1.5} />
            <circle cx={x(hover)} cy={y(normal[hover])} r={3} fill="var(--color-text-muted)" stroke="var(--color-surface)" strokeWidth={1.5} />
          </g>
        )}
      </svg>
      {hover != null && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: `${(x(hover) / W) * 100}%`,
            transform: `translateX(${hover > dates.length / 2 ? 'calc(-100% - 10px)' : '10px'})`,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            padding: '0.3rem 0.55rem',
            fontSize: '0.75rem',
            lineHeight: 1.4,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontWeight: 600 }}>{formatLong(dates[hover])}</div>
          <div><span style={{ color: actualColor }}>&#9632;</span> {formatValue(actual[hover])}{unit}</div>
          <div style={{ color: 'var(--color-text-muted)' }}>{normalLabel}: {formatValue(normal[hover])}{unit}</div>
        </div>
      )}
      </div>
    </div>
  );
}

// ─── Summary tile ────────────────────────────────────────────────────────────

function Tile({ label, value, delta, note }) {
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '10px', padding: '0.9rem 1rem', flex: '1 1 150px' }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.6rem', lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--color-accent)' }}>{delta}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{note}</div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function WeatherHistory({ location }) {
  const [recent, setRecent] = useState(null);
  const [normals, setNormals] = useState(null);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState('month');

  useEffect(() => {
    let cancelled = false;
    setRecent(null);
    setNormals(null);
    setError(null);
    Promise.all([loadRecent(location.lat, location.lon), loadNormals(location.lat, location.lon)])
      .then(([r, n]) => {
        if (cancelled) return;
        setRecent(r);
        setNormals(n);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load historical weather.');
      });
    return () => { cancelled = true; };
  }, [location.lat, location.lon]);

  const view = useMemo(() => {
    if (!recent || !normals) return null;
    const { days } = PERIODS.find((p) => p.id === period);
    const rows = recent.slice(-days).map((r) => ({ ...r, norm: normals[r.date.slice(5)] || normals['02-28'] }));
    const dates = rows.map((r) => r.date);
    const meanNorm = rows.map((r) => r.norm.mean);
    const precipNorm = rows.map((r) => r.norm.precip);
    const precipTotal = sum(rows.map((r) => r.precip));
    const precipNormTotal = sum(precipNorm);
    const cumulative = (vals) => vals.reduce((acc, v) => [...acc, (acc[acc.length - 1] || 0) + v], []);
    return {
      rows,
      dates,
      meanAvg: avg(rows.map((r) => r.mean)),
      meanNormAvg: avg(meanNorm),
      highAvg: avg(rows.map((r) => r.max)),
      highNormAvg: avg(rows.map((r) => r.norm.max)),
      lowAvg: avg(rows.map((r) => r.min)),
      lowNormAvg: avg(rows.map((r) => r.norm.min)),
      precipTotal,
      precipNormTotal,
      wetDays: rows.filter((r) => r.precip >= 1).length,
      tempSeries: rows.map((r) => r.max),
      tempNormSeries: rows.map((r) => smoothedNormal(normals, r.date, 'max')),
      cumActual: cumulative(rows.map((r) => r.precip)),
      cumNormal: cumulative(precipNorm),
      };
  }, [recent, normals, period]);

  if (error) {
    return (
      <div style={{ background: 'var(--color-surface)', border: '1px solid #c0392b', borderRadius: '8px', padding: '1rem 1.25rem', color: '#c0392b', fontSize: '0.9rem' }}>
        {error}
      </div>
    );
  }

  if (!view) {
    return <p style={{ color: 'var(--color-text-muted)' }}>Loading 30 years of history...</p>;
  }

  const tempDiff = view.meanAvg - view.meanNormAvg;
  const precipDiff = view.precipTotal - view.precipNormTotal;
  const precipPct = view.precipNormTotal > 0 ? (precipDiff / view.precipNormTotal) * 100 : 0;
  const first = view.dates[0];
  const last = view.dates[view.dates.length - 1];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {PERIODS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            style={{
              padding: '0.35rem 0.9rem',
              borderRadius: '999px',
              border: '1px solid',
              borderColor: period === p.id ? 'var(--color-accent)' : 'var(--color-border)',
              background: period === p.id ? 'var(--color-accent)' : 'var(--color-surface)',
              color: period === p.id ? '#fff' : 'var(--color-text-muted)',
              fontFamily: 'var(--font-body)',
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--color-text-muted)', alignSelf: 'center' }}>
          {formatShort(first)} – {formatShort(last)}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Tile
          label="Average temperature"
          value={`${view.meanAvg.toFixed(1)}°C`}
          delta={`${signed(tempDiff)}°C vs normal (${view.meanNormAvg.toFixed(1)}°C)`}
          note={tempDiff > 0.3 ? 'Warmer than average' : tempDiff < -0.3 ? 'Cooler than average' : 'About average'}
        />
        <Tile
          label="Avg high / low"
          value={`${Math.round(view.highAvg)}° / ${Math.round(view.lowAvg)}°`}
          delta={`${signed(view.highAvg - view.highNormAvg)}° / ${signed(view.lowAvg - view.lowNormAvg)}° vs normal`}
          note={`Normal ${Math.round(view.highNormAvg)}° / ${Math.round(view.lowNormAvg)}°`}
        />
        <Tile
          label="Total precipitation"
          value={`${Math.round(view.precipTotal)} mm`}
          delta={`${signed(precipDiff, 0)} mm (${signed(precipPct, 0)}%) vs normal`}
          note={`Normal ${Math.round(view.precipNormTotal)} mm · ${view.wetDays} days with 1 mm+`}
        />
      </div>

      <LineChart
        title="Daily high temperature"
        unit={'°'}
        dates={view.dates}
        actual={view.tempSeries}
        normal={view.tempNormSeries}
        actualColor="var(--color-accent)"
      />

      <LineChart
        title="Cumulative precipitation"
        unit=" mm"
        dates={view.dates}
        actual={view.cumActual}
        normal={view.cumNormal}
        actualColor={BLUE}
      />

      <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', margin: 0 }}>
        Normal = 1991–2020 average for the same calendar days at this location (Open-Meteo reanalysis); the normal temperature line is smoothed over 7 days.
      </p>
    </div>
  );
}
