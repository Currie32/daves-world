import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../lib/firebase';
import PageHeader from '../components/PageHeader';

// ─── Constants ──────────────────────────────────────────────────────────────

const CACHE_KEY_PREFIX = 'sp500_v2_';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

const METRICS = {
  trailing: { label: 'Trailing P/E', unit: '', color: '#c0622f' },
  cape: { label: 'Shiller CAPE', unit: '', color: '#5b9bd5' },
  earnings: { label: 'Earnings Growth', unit: '%', color: '#6bae6b' },
};

const METRIC_KEYS = Object.keys(METRICS);

const RANGES = [
  { label: '1Y', years: 1 },
  { label: '5Y', years: 5 },
  { label: '10Y', years: 10 },
  { label: '20Y', years: 20 },
  { label: '50Y', years: 50 },
  { label: 'All', years: null },
];

const VIEW_MODES = [
  { key: 'single', label: 'A' },
  { key: 'overlay', label: 'A + B' },
  { key: 'ratio', label: 'A \u00F7 B' },
];

const CHART_PADDING = { top: 25, bottom: 35, left: 50 };
const RIGHT_PAD_SINGLE = 15;
const RIGHT_PAD_DUAL = 50;

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = {
  page: { maxWidth: '900px', margin: '0 auto', padding: '2rem 1.5rem' },
  currentValue: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: '12px', padding: '1.5rem 2rem', marginBottom: '1.5rem',
    display: 'flex', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap',
  },
  currentPE: {
    fontSize: '3rem', fontWeight: 700, fontFamily: 'var(--font-display)',
    color: 'var(--color-text)', lineHeight: 1, margin: 0,
  },
  currentLabel: { fontSize: '1rem', color: 'var(--color-text-muted)' },
  currentDate: { fontSize: '0.85rem', color: 'var(--color-text-muted)', marginLeft: 'auto' },
  controlsRow: {
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    marginBottom: '0.75rem', flexWrap: 'wrap',
  },
  pillGroup: {
    display: 'flex', gap: '0.25rem', background: 'var(--color-surface)',
    border: '1px solid var(--color-border)', borderRadius: '8px', padding: '3px',
  },
  pill: (active, color) => ({
    padding: '0.4rem 0.85rem', border: 'none', borderRadius: '6px',
    fontFamily: 'var(--font-body)', fontSize: '0.82rem', cursor: 'pointer',
    transition: 'all 0.15s',
    background: active ? (color || 'var(--color-accent)') : 'transparent',
    color: active ? '#fff' : 'var(--color-text-muted)',
    fontWeight: active ? 600 : 400,
  }),
  metricBtn: (active, color) => ({
    padding: '0.4rem 0.85rem', borderRadius: '6px',
    fontFamily: 'var(--font-body)', fontSize: '0.82rem', cursor: 'pointer',
    transition: 'all 0.15s',
    background: active ? color + '18' : 'transparent',
    border: active ? `1.5px solid ${color}` : '1.5px solid transparent',
    color: active ? color : 'var(--color-text-muted)',
    fontWeight: active ? 600 : 400,
  }),
  label: {
    fontSize: '0.78rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  chartContainer: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: '12px', padding: '1rem', marginBottom: '1rem',
  },
  chartInner: { position: 'relative' },
  tooltip: {
    position: 'absolute', background: 'var(--color-surface)',
    border: '1px solid var(--color-border)', borderRadius: '8px',
    padding: '0.5rem 0.75rem', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    pointerEvents: 'none', zIndex: 10, whiteSpace: 'nowrap',
  },
  tooltipDate: { fontSize: '0.78rem', color: 'var(--color-text-muted)', marginBottom: '0.2rem' },
  tooltipRow: { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.92rem' },
  tooltipDot: (color) => ({
    width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
  }),
  tooltipVal: {
    fontWeight: 600, fontFamily: 'var(--font-display)', color: 'var(--color-text)',
  },
  averagesRow: {
    display: 'flex', justifyContent: 'space-between',
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: '10px', padding: '1rem 1.5rem', marginBottom: '1rem',
  },
  avgItem: { textAlign: 'center', flex: 1 },
  avgValue: {
    fontSize: '1.15rem', fontWeight: 600, fontFamily: 'var(--font-display)',
    color: 'var(--color-text)', lineHeight: 1.2,
  },
  avgLabel: { fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '0.2rem' },
  attribution: { fontSize: '0.78rem', color: 'var(--color-text-muted)', textAlign: 'center' },
  errorBox: {
    background: 'var(--color-surface)', border: '1px solid #c0392b', borderRadius: '8px',
    padding: '1rem 1.25rem', color: '#c0392b', fontSize: '0.9rem', marginBottom: '1.5rem',
  },
};

// ─── Cache Helpers ──────────────────────────────────────────────────────────

function getCached(type) {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + type);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.timestamp > CACHE_TTL) return null;
    return cached.data;
  } catch { return null; }
}

function setCache(type, data) {
  try {
    localStorage.setItem(CACHE_KEY_PREFIX + type, JSON.stringify({ data, timestamp: Date.now() }));
  } catch { /* ignore */ }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
function formatDateLong(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function niceStep(range) {
  const raw = range / 6; // aim for ~6 ticks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

function computeYRange(values) {
  if (values.length === 0) return { min: 0, max: 10 };
  const sorted = [...values].sort((a, b) => a - b);
  const p1 = percentile(sorted, 1);
  const p99 = percentile(sorted, 99);
  const span = p99 - p1 || 1;
  const pad = span * 0.08;
  const step = niceStep(span + 2 * pad);
  const hasNeg = sorted[0] < 0;
  const rawMin = hasNeg ? p1 - pad : 0;
  return {
    min: Math.floor(rawMin / step) * step,
    max: Math.ceil((p99 + pad) / step) * step,
  };
}

function niceYTicks(yMin, yMax) {
  const step = niceStep(yMax - yMin);
  const ticks = [];
  for (let v = yMin; v <= yMax + step * 0.01; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

function getXTickDates(minTs, maxTs, rangeYears) {
  const firstDate = new Date(minTs);
  const lastDate = new Date(maxTs);
  const span = rangeYears ?? ((maxTs - minTs) / (365.25 * 24 * 3600 * 1000));
  let stepYears;
  if (span >= 50) stepYears = 20;
  else if (span >= 20) stepYears = 5;
  else if (span >= 10) stepYears = 2;
  else if (span >= 5) stepYears = 1;
  else stepYears = 0.25;

  const ticks = [];
  if (stepYears >= 1) {
    const startYear = Math.ceil(firstDate.getFullYear() / stepYears) * stepYears;
    for (let y = startYear; y <= lastDate.getFullYear(); y += stepYears) {
      const ts = new Date(y, 0, 1).getTime();
      if (ts >= minTs && ts <= maxTs) ticks.push({ ts, label: String(y) });
    }
  } else {
    const stepMonths = Math.round(stepYears * 12);
    const d = new Date(firstDate);
    d.setMonth(Math.ceil(d.getMonth() / stepMonths) * stepMonths);
    d.setDate(1);
    while (d <= lastDate) {
      ticks.push({ ts: d.getTime(), label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) });
      d.setMonth(d.getMonth() + stepMonths);
    }
  }
  return ticks;
}

function filterByRange(data, rangeYears) {
  if (!data || data.length === 0) return [];
  if (rangeYears === null) return data;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - rangeYears);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return data.filter((d) => d.date >= cutoffStr);
}

function computeRatio(dataA, dataB) {
  // Join by year-month since datasets may use different days (1st vs last of month)
  const ym = (d) => d.date.slice(0, 7);
  const mapB = new Map(dataB.map((d) => [ym(d), d.value]));
  return dataA
    .filter((d) => mapB.has(ym(d)) && mapB.get(ym(d)) !== 0)
    .map((d) => ({ date: d.date, value: +(d.value / mapB.get(ym(d))).toFixed(4) }));
}

function annualAverage(data) {
  if (!data || data.length === 0) return [];
  const byYear = {};
  for (const d of data) {
    const year = d.date.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(d.value);
  }
  return Object.entries(byYear)
    .map(([year, vals]) => ({
      date: `${year}-07-01`,
      value: vals.reduce((s, v) => s + v, 0) / vals.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function periodAverages(data) {
  if (!data || data.length === 0) return null;
  const now = new Date();
  const periods = [1, 3, 5, 10, 25];
  const allMean = data.reduce((s, d) => s + d.value, 0) / data.length;
  const rows = periods.map((years) => {
    const cutoff = new Date(now);
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const subset = data.filter((d) => d.date >= cutoffStr);
    if (subset.length === 0) return null;
    return { label: `${years}Y`, avg: subset.reduce((s, d) => s + d.value, 0) / subset.length };
  }).filter(Boolean);
  return { all: allMean, periods: rows };
}

// ─── MetricChart ────────────────────────────────────────────────────────────

function MetricChart({ seriesA, seriesB, rangeYears }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(800);
  const [tooltip, setTooltip] = useState(null);

  const isDual = !!seriesB;
  const rightPad = isDual ? RIGHT_PAD_DUAL : RIGHT_PAD_SINGLE;
  const height = Math.max(300, Math.min(420, width * 0.45));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((e) => { const w = e[0].contentRect.width; if (w > 0) setWidth(w); });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const chartW = width - CHART_PADDING.left - rightPad;
  const chartH = height - CHART_PADDING.top - CHART_PADDING.bottom;

  // Prepare series A
  const a = useMemo(() => {
    const d = seriesA.data;
    const ts = d.map((p) => new Date(p.date + 'T00:00:00').getTime());
    const vals = d.map((p) => p.value);
    const { min, max } = computeYRange(vals);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    return { ts, vals, yMin: min, yMax: max, mean, minTs: Math.min(...ts), maxTs: Math.max(...ts) };
  }, [seriesA.data]);

  // Prepare series B
  const b = useMemo(() => {
    if (!seriesB) return null;
    const d = seriesB.data;
    const ts = d.map((p) => new Date(p.date + 'T00:00:00').getTime());
    const vals = d.map((p) => p.value);
    const { min, max } = computeYRange(vals);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    return { ts, vals, yMin: min, yMax: max, mean, minTs: Math.min(...ts), maxTs: Math.max(...ts) };
  }, [seriesB]);

  // Shared x range
  const minTs = isDual ? Math.min(a.minTs, b.minTs) : a.minTs;
  const maxTs = isDual ? Math.max(a.maxTs, b.maxTs) : a.maxTs;

  const xScale = useCallback(
    (ts) => CHART_PADDING.left + ((ts - minTs) / (maxTs - minTs || 1)) * chartW,
    [minTs, maxTs, chartW]
  );
  const yScaleA = useCallback(
    (val) => {
      const clamped = Math.max(a.yMin, Math.min(val, a.yMax));
      return CHART_PADDING.top + (1 - (clamped - a.yMin) / (a.yMax - a.yMin || 1)) * chartH;
    },
    [a.yMin, a.yMax, chartH]
  );
  const yScaleB = useCallback(
    (val) => {
      if (!b) return 0;
      const clamped = Math.max(b.yMin, Math.min(val, b.yMax));
      return CHART_PADDING.top + (1 - (clamped - b.yMin) / (b.yMax - b.yMin || 1)) * chartH;
    },
    [b, chartH]
  );

  // Paths
  const buildPath = useCallback((timestamps, values, yFn) =>
    timestamps.map((t, i) => `${i === 0 ? 'M' : 'L'}${xScale(t).toFixed(1)},${yFn(values[i]).toFixed(1)}`).join(' '),
    [xScale]
  );

  const lineA = useMemo(() => buildPath(a.ts, a.vals, yScaleA), [a, buildPath, yScaleA]);
  const lineB = useMemo(() => b ? buildPath(b.ts, b.vals, yScaleB) : '', [b, buildPath, yScaleB]);

  const areaA = useMemo(() => {
    if (!lineA || isDual) return '';
    const baseY = yScaleA(a.yMin);
    return lineA + ` L${xScale(a.maxTs).toFixed(1)},${baseY.toFixed(1)} L${xScale(a.minTs).toFixed(1)},${baseY.toFixed(1)} Z`;
  }, [lineA, isDual, yScaleA, xScale, a]);

  const yTicksA = useMemo(() => niceYTicks(a.yMin, a.yMax), [a.yMin, a.yMax]);
  const yTicksB = useMemo(() => b ? niceYTicks(b.yMin, b.yMax) : [], [b]);
  const xTicks = useMemo(() => getXTickDates(minTs, maxTs, rangeYears), [minTs, maxTs, rangeYears]);

  // Hover
  const handlePointer = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left;
    const ts = minTs + ((x - CHART_PADDING.left) / chartW) * (maxTs - minTs);

    const findNearest = (timestamps, data) => {
      let lo = 0, hi = timestamps.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (timestamps[mid] < ts) lo = mid + 1; else hi = mid; }
      if (lo > 0 && Math.abs(timestamps[lo - 1] - ts) < Math.abs(timestamps[lo] - ts)) lo--;
      return { point: data[lo], ts: timestamps[lo], idx: lo };
    };

    const nearA = findNearest(a.ts, seriesA.data);
    const nearB = b ? findNearest(b.ts, seriesB.data) : null;
    const px = xScale(nearA.ts);
    setTooltip({ nearA, nearB, px });
  }, [a, b, seriesA, seriesB, minTs, maxTs, chartW, xScale]);

  const handleLeave = useCallback(() => setTooltip(null), []);

  if (seriesA.data.length === 0) return null;

  return (
    <div style={styles.chartContainer}>
      <div style={styles.chartInner} ref={containerRef}>
        <svg width={width} height={height} style={{ display: 'block' }}
          onMouseMove={handlePointer} onTouchMove={handlePointer}
          onMouseLeave={handleLeave} onTouchEnd={handleLeave}>

          {/* Left Y-axis grid + labels */}
          {yTicksA.map((v) => (
            <g key={`ya-${v}`}>
              <line x1={CHART_PADDING.left} y1={yScaleA(v)} x2={width - rightPad} y2={yScaleA(v)}
                stroke="var(--color-border)" strokeWidth={1} />
              <text x={CHART_PADDING.left - 8} y={yScaleA(v) + 4} textAnchor="end"
                fontSize={11} fontFamily="var(--font-body)" fill={isDual ? seriesA.color : 'var(--color-text-muted)'}>
                {v}{seriesA.unit}
              </text>
            </g>
          ))}

          {/* Right Y-axis labels (dual mode) */}
          {isDual && yTicksB.map((v) => (
            <text key={`yb-${v}`} x={width - rightPad + 8} y={yScaleB(v) + 4}
              textAnchor="start" fontSize={11} fontFamily="var(--font-body)" fill={seriesB.color}>
              {v}{seriesB.unit}
            </text>
          ))}

          {/* X-axis labels */}
          {xTicks.map(({ ts, label }) => (
            <text key={`x-${ts}`} x={xScale(ts)} y={height - CHART_PADDING.bottom + 20}
              textAnchor="middle" fontSize={11} fontFamily="var(--font-body)" fill="var(--color-text-muted)">
              {label}
            </text>
          ))}

          {/* Zero line for mixed-sign data */}
          {a.yMin < 0 && (
            <line x1={CHART_PADDING.left} y1={yScaleA(0)} x2={width - rightPad} y2={yScaleA(0)}
              stroke="var(--color-text-muted)" strokeWidth={1} opacity={0.4} />
          )}

          {/* Area fill (single mode only) */}
          {areaA && <path d={areaA} fill={seriesA.color} opacity={0.08} />}

          {/* Line A */}
          <path d={lineA} fill="none" stroke={seriesA.color} strokeWidth={1.5} strokeLinejoin="round" />

          {/* Line B */}
          {lineB && <path d={lineB} fill="none" stroke={seriesB.color} strokeWidth={1.5} strokeLinejoin="round" />}

          {/* Mean reference lines */}
          <line x1={CHART_PADDING.left} y1={yScaleA(a.mean)} x2={width - rightPad} y2={yScaleA(a.mean)}
            stroke={seriesA.color} strokeWidth={1} strokeDasharray="5,4" opacity={0.5} />
          <text x={CHART_PADDING.left + 4} y={yScaleA(a.mean) - 5}
            fontSize={10} fontFamily="var(--font-body)" fill={seriesA.color} opacity={0.7}>
            avg {a.mean.toFixed(1)}
          </text>

          {isDual && (
            <>
              <line x1={CHART_PADDING.left} y1={yScaleB(b.mean)} x2={width - rightPad} y2={yScaleB(b.mean)}
                stroke={seriesB.color} strokeWidth={1} strokeDasharray="5,4" opacity={0.5} />
              <text x={width - rightPad - 4} y={yScaleB(b.mean) - 5}
                fontSize={10} fontFamily="var(--font-body)" fill={seriesB.color} opacity={0.7} textAnchor="end">
                avg {b.mean.toFixed(1)}
              </text>
            </>
          )}

          {/* Hover crosshair */}
          {tooltip && (
            <>
              <line x1={tooltip.px} y1={CHART_PADDING.top} x2={tooltip.px} y2={height - CHART_PADDING.bottom}
                stroke="var(--color-text-muted)" strokeWidth={1} opacity={0.5} />
              <circle cx={tooltip.px} cy={yScaleA(tooltip.nearA.point.value)} r={4}
                fill={seriesA.color} stroke="var(--color-surface)" strokeWidth={2} />
              {tooltip.nearB && (
                <circle cx={xScale(tooltip.nearB.ts)} cy={yScaleB(tooltip.nearB.point.value)} r={4}
                  fill={seriesB.color} stroke="var(--color-surface)" strokeWidth={2} />
              )}
            </>
          )}
        </svg>

        {/* Tooltip */}
        {tooltip && (
          <div style={{ ...styles.tooltip, left: Math.min(tooltip.px, width - 160), top: Math.max(0, yScaleA(tooltip.nearA.point.value) - 70) }}>
            <div style={styles.tooltipDate}>{formatDateLong(tooltip.nearA.point.date)}</div>
            <div style={styles.tooltipRow}>
              <span style={styles.tooltipDot(seriesA.color)} />
              <span style={styles.tooltipVal}>{tooltip.nearA.point.value.toFixed(2)}{seriesA.unit}</span>
              <span style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>{seriesA.label}</span>
            </div>
            {tooltip.nearB && (
              <div style={{ ...styles.tooltipRow, marginTop: '0.15rem' }}>
                <span style={styles.tooltipDot(seriesB.color)} />
                <span style={styles.tooltipVal}>{tooltip.nearB.point.value.toFixed(2)}{seriesB.unit}</span>
                <span style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>{seriesB.label}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SP500PE (Page) ─────────────────────────────────────────────────────────

export default function SP500PE() {
  const [metricA, setMetricA] = useState('trailing');
  const [metricB, setMetricB] = useState('cape');
  const [viewMode, setViewMode] = useState('single');
  const [dataStore, setDataStore] = useState({});
  const [loading, setLoading] = useState({});
  const [error, setError] = useState(null);
  const [range, setRange] = useState('All');
  const [smoothing, setSmoothing] = useState('monthly');

  const loadMetric = useCallback(async (metric) => {
    if (dataStore[metric]) return;

    const cached = getCached(metric);
    if (cached) {
      const normalized = cached.map((d) => ({ date: d.date, value: d.value ?? d.pe }));
      setDataStore((prev) => ({ ...prev, [metric]: normalized }));
      return;
    }

    setLoading((prev) => ({ ...prev, [metric]: true }));
    setError(null);
    try {
      const fn = httpsCallable(getFunctions(app, 'us-west1'), 'fetch_pe_data');
      const result = await fn({ type: metric });
      const data = result.data.data.map((d) => ({ date: d.date, value: d.value ?? d.pe }));
      setCache(metric, data);
      setDataStore((prev) => ({ ...prev, [metric]: data }));
    } catch (err) {
      setError(err.message || 'Failed to load data.');
    } finally {
      setLoading((prev) => ({ ...prev, [metric]: false }));
    }
  }, [dataStore]);

  // Load required metrics
  useEffect(() => { loadMetric(metricA); }, [metricA, loadMetric]);
  useEffect(() => {
    if (viewMode !== 'single') loadMetric(metricB);
  }, [metricB, viewMode, loadMetric]);

  const isLoading = loading[metricA] || (viewMode !== 'single' && loading[metricB]);
  const rangeYears = RANGES.find((r) => r.label === range)?.years ?? null;

  // Prepare chart data based on view mode
  const smooth = useCallback((data) => smoothing === 'annual' ? annualAverage(data) : data, [smoothing]);

  const chartProps = useMemo(() => {
    const rawA = dataStore[metricA];
    if (!rawA) return null;

    if (viewMode === 'single') {
      const filtered = smooth(filterByRange(rawA, rangeYears));
      return {
        seriesA: { data: filtered, color: METRICS[metricA].color, label: METRICS[metricA].label, unit: METRICS[metricA].unit },
      };
    }

    const rawB = dataStore[metricB];
    if (!rawB) return null;

    if (viewMode === 'overlay') {
      const fA = smooth(filterByRange(rawA, rangeYears));
      const fB = smooth(filterByRange(rawB, rangeYears));
      return {
        seriesA: { data: fA, color: METRICS[metricA].color, label: METRICS[metricA].label, unit: METRICS[metricA].unit },
        seriesB: { data: fB, color: METRICS[metricB].color, label: METRICS[metricB].label, unit: METRICS[metricB].unit },
      };
    }

    // ratio — smooth inputs before dividing to avoid monthly noise
    const sA = smooth(rawA);
    const sB = smooth(rawB);
    const ratio = computeRatio(sA, sB);
    const filtered = filterByRange(ratio, rangeYears);
    const label = `${METRICS[metricA].label} \u00F7 ${METRICS[metricB].label}`;
    return {
      seriesA: { data: filtered, color: METRICS[metricA].color, label, unit: '' },
    };
  }, [dataStore, metricA, metricB, viewMode, rangeYears, smooth]);

  // Data for current value display and averages
  const displayData = chartProps?.seriesA?.data;
  const currentValue = displayData?.[displayData.length - 1];
  const currentLabel = viewMode === 'ratio'
    ? `${METRICS[metricA].label} \u00F7 ${METRICS[metricB].label}`
    : METRICS[metricA].label;
  const currentUnit = viewMode === 'single' ? METRICS[metricA].unit : viewMode === 'ratio' ? '' : METRICS[metricA].unit;

  const avgs = useMemo(() => {
    const fullData = viewMode === 'ratio' && dataStore[metricA] && dataStore[metricB]
      ? computeRatio(dataStore[metricA], dataStore[metricB])
      : dataStore[metricA];
    return periodAverages(fullData);
  }, [dataStore, metricA, metricB, viewMode]);

  return (
    <div style={styles.page}>
      <PageHeader
        title="S&P 500 Market Data"
        subtitle="Historical metrics with monthly data since 1871."
      />

      {/* Current value */}
      {currentValue && !isLoading && (
        <div style={styles.currentValue}>
          <p style={styles.currentPE}>{currentValue.value.toFixed(2)}{currentUnit}</p>
          <span style={styles.currentLabel}>{currentLabel}</span>
          <span style={styles.currentDate}>as of {formatDate(currentValue.date)}</span>
        </div>
      )}

      {/* View mode + metric selectors */}
      <div style={styles.controlsRow}>
        <span style={styles.label}>View</span>
        <div style={styles.pillGroup}>
          {VIEW_MODES.map((m) => (
            <button key={m.key} style={styles.pill(viewMode === m.key)} onClick={() => setViewMode(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.controlsRow}>
        <span style={styles.label}>A</span>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {METRIC_KEYS.map((k) => (
            <button key={k} style={styles.metricBtn(metricA === k, METRICS[k].color)}
              onClick={() => setMetricA(k)}>
              {METRICS[k].label}
            </button>
          ))}
        </div>
      </div>

      {viewMode !== 'single' && (
        <div style={styles.controlsRow}>
          <span style={styles.label}>B</span>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {METRIC_KEYS.map((k) => (
              <button key={k} style={styles.metricBtn(metricB === k, METRICS[k].color)}
                onClick={() => setMetricB(k)}>
                {METRICS[k].label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Granularity */}
      <div style={styles.controlsRow}>
        <span style={styles.label}>Data</span>
        <div style={styles.pillGroup}>
          <button style={styles.pill(smoothing === 'monthly')} onClick={() => setSmoothing('monthly')}>Monthly</button>
          <button style={styles.pill(smoothing === 'annual')} onClick={() => setSmoothing('annual')}>Annual Avg</button>
        </div>
      </div>

      {/* Range selector */}
      <div style={{ ...styles.controlsRow, marginBottom: '1.5rem' }}>
        <span style={styles.label}>Range</span>
        <div style={styles.pillGroup}>
          {RANGES.map((r) => (
            <button key={r.label} style={styles.pill(range === r.label)} onClick={() => setRange(r.label)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div style={styles.chartContainer}>
          <p style={{ color: 'var(--color-text-muted)', textAlign: 'center', padding: '4rem 0' }}>
            Loading data...
          </p>
        </div>
      )}

      {error && <div style={styles.errorBox}>{error}</div>}

      {/* Chart */}
      {!isLoading && !error && chartProps && chartProps.seriesA.data.length > 0 && (
        <MetricChart {...chartProps} rangeYears={rangeYears} />
      )}

      {/* Period averages */}
      {avgs && !isLoading && (
        <div style={styles.averagesRow}>
          <div style={styles.avgItem}>
            <div style={styles.avgValue}>{avgs.all.toFixed(1)}</div>
            <div style={styles.avgLabel}>All-time</div>
          </div>
          {avgs.periods.map((p) => (
            <div key={p.label} style={styles.avgItem}>
              <div style={styles.avgValue}>{p.avg.toFixed(1)}</div>
              <div style={styles.avgLabel}>{p.label} avg</div>
            </div>
          ))}
        </div>
      )}

      <p style={styles.attribution}>
        Data source: multpl.com (Robert Shiller, <em>Irrational Exuberance</em>). Updated monthly.
      </p>
    </div>
  );
}
