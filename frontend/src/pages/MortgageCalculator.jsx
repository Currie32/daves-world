import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import PageHeader from '../components/PageHeader';

// ─── Constants ──────────────────────────────────────────────────────────────

const FREQUENCIES = [
  { value: 'monthly', label: 'Monthly', periodsPerYear: 12 },
  { value: 'biweekly', label: 'Bi-Weekly', periodsPerYear: 26 },
  { value: 'accelerated-biweekly', label: 'Accelerated Bi-Weekly', periodsPerYear: 26, acceleratedDivisor: 2 },
  { value: 'weekly', label: 'Weekly', periodsPerYear: 52 },
  { value: 'accelerated-weekly', label: 'Accelerated Weekly', periodsPerYear: 52, acceleratedDivisor: 4 },
];

const COLORS = {
  actual: '#c0622f',
  baseline: '#5b9bd5',
  principal: '#c0622f',
  interest: '#5b9bd5',
  extra: '#6bae6b',
};

const CHART_PADDING = { top: 20, bottom: 35, left: 65, right: 15 };

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = {
  page: { maxWidth: '900px', margin: '0 auto', padding: '2rem 1.5rem' },
  section: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: '12px', padding: '1.5rem', marginBottom: '1.25rem',
  },
  sectionTitle: {
    fontSize: '1.1rem', fontFamily: 'var(--font-display)', color: 'var(--color-text)',
    margin: '0 0 1rem',
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  label: {
    fontSize: '0.78rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-body)',
    fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  input: {
    padding: '0.55rem 0.7rem', borderRadius: '8px', border: '1px solid var(--color-border)',
    fontFamily: 'var(--font-body)', fontSize: '0.95rem', color: 'var(--color-text)',
    background: 'var(--color-bg)',
  },
  select: {
    padding: '0.55rem 0.7rem', borderRadius: '8px', border: '1px solid var(--color-border)',
    fontFamily: 'var(--font-body)', fontSize: '0.95rem', color: 'var(--color-text)',
    background: 'var(--color-bg)',
  },
  row: { display: 'flex', gap: '0.6rem', alignItems: 'flex-end', marginBottom: '0.6rem', flexWrap: 'wrap' },
  smallField: { display: 'flex', flexDirection: 'column', gap: '0.3rem', width: '120px' },
  addBtn: {
    padding: '0.5rem 0.9rem', borderRadius: '8px', border: '1px solid var(--color-accent)',
    background: 'transparent', color: 'var(--color-accent)', fontFamily: 'var(--font-body)',
    fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
  },
  removeBtn: {
    padding: '0.5rem 0.7rem', borderRadius: '8px', border: '1px solid var(--color-border)',
    background: 'transparent', color: 'var(--color-text-muted)', fontFamily: 'var(--font-body)',
    fontSize: '0.85rem', cursor: 'pointer',
  },
  emptyRowNote: { fontSize: '0.85rem', color: 'var(--color-text-muted)', margin: '0 0 0.75rem' },
  statsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem',
    marginBottom: '1.25rem',
  },
  statCard: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderTop: '4px solid var(--color-accent)', borderRadius: '10px', padding: '1rem 1.1rem',
  },
  statValue: {
    fontSize: '1.4rem', fontWeight: 700, fontFamily: 'var(--font-display)',
    color: 'var(--color-text)', lineHeight: 1.15,
  },
  statLabel: { fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' },
  statPct: {
    fontSize: '0.9rem', fontWeight: 600, fontFamily: 'var(--font-body)',
    color: 'var(--color-text-muted)', marginLeft: '0.35rem',
  },
  chartContainer: {
    background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: '12px', padding: '1rem', marginBottom: '1.25rem', position: 'relative',
  },
  legend: { display: 'flex', gap: '1.25rem', marginBottom: '0.75rem', flexWrap: 'wrap' },
  legendItem: { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--color-text-muted)' },
  legendDot: (color) => ({ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }),
  tooltip: {
    position: 'absolute', background: 'var(--color-surface)', border: '1px solid var(--color-border)',
    borderRadius: '8px', padding: '0.5rem 0.75rem', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    pointerEvents: 'none', zIndex: 10, whiteSpace: 'nowrap',
  },
  errorBox: {
    background: 'var(--color-surface)', border: '1px solid #c0392b', borderRadius: '8px',
    padding: '1rem 1.25rem', color: '#c0392b', fontSize: '0.9rem', marginBottom: '1.5rem',
  },
};

// ─── Math helpers ───────────────────────────────────────────────────────────

// Canadian mortgages state a nominal annual rate compounded semi-annually,
// regardless of payment frequency — convert to an effective periodic rate.
function periodicRateFromAnnual(annualRatePct, periodsPerYear) {
  const semiAnnualRate = annualRatePct / 100 / 2;
  const effectiveAnnualRate = Math.pow(1 + semiAnnualRate, 2) - 1;
  return Math.pow(1 + effectiveAnnualRate, 1 / periodsPerYear) - 1;
}

function levelPayment(balance, periodicRate, totalPeriods) {
  if (totalPeriods <= 0) return balance;
  if (periodicRate === 0) return balance / totalPeriods;
  return (balance * periodicRate) / (1 - Math.pow(1 + periodicRate, -totalPeriods));
}

function computePayment(balance, annualRatePct, freqDef, remainingPeriods) {
  if (freqDef.acceleratedDivisor) {
    const monthlyRate = periodicRateFromAnnual(annualRatePct, 12);
    const remainingMonths = remainingPeriods * (12 / freqDef.periodsPerYear);
    return levelPayment(balance, monthlyRate, remainingMonths) / freqDef.acceleratedDivisor;
  }
  const periodicRate = periodicRateFromAnnual(annualRatePct, freqDef.periodsPerYear);
  return levelPayment(balance, periodicRate, remainingPeriods);
}

function addPeriodsToDate(startDate, periodNumber, freqDef) {
  const d = new Date(startDate);
  if (freqDef.periodsPerYear === 12) {
    d.setMonth(d.getMonth() + periodNumber);
  } else {
    const daysPerPeriod = freqDef.periodsPerYear === 26 ? 14 : 7;
    d.setDate(d.getDate() + periodNumber * daysPerPeriod);
  }
  return d;
}

function yearToPeriod(years, periodsPerYear) {
  return Math.max(1, Math.round(years * periodsPerYear));
}

// Builds a full amortization schedule.
// rateChanges: [{ atYear, rate }] sorted ascending, applied at the given year mark.
// extraPayments: [{ atYear, amount }] one-off extra principal payments.
// recurringPayments: [{ frequencyType: 'every-payment' | 'annually', startYear, endYear, amount }]
//   'every-payment' adds `amount` on top of every regular payment within [startYear, endYear].
//   'annually' adds `amount` once per year, on the payment landing at each year mark in that range.
function buildSchedule({ principal, annualRate, amortYears, frequencyKey, startDate, rateChanges, extraPayments, recurringPayments }) {
  const freqDef = FREQUENCIES.find((f) => f.value === frequencyKey);
  const periodsPerYear = freqDef.periodsPerYear;
  const totalPeriods = yearToPeriod(amortYears, periodsPerYear);

  const events = [{ atPeriod: 0, rate: annualRate }]
    .concat(
      rateChanges
        .filter((rc) => rc.atYear > 0 && rc.atYear < amortYears)
        .map((rc) => ({ atPeriod: yearToPeriod(rc.atYear, periodsPerYear), rate: rc.newRate }))
    )
    .sort((a, b) => a.atPeriod - b.atPeriod);

  const extraMap = new Map();
  for (const ep of extraPayments) {
    if (ep.atYear <= 0 || ep.amount <= 0) continue;
    const p = yearToPeriod(ep.atYear, periodsPerYear);
    extraMap.set(p, (extraMap.get(p) || 0) + ep.amount);
  }
  for (const rp of recurringPayments) {
    if (!(rp.amount > 0)) continue;
    const startYear = Math.max(rp.startYear || 0, 0);
    const endYear = rp.endYear > 0 ? Math.min(rp.endYear, amortYears) : amortYears;
    if (endYear <= startYear && rp.frequencyType !== 'every-payment') continue;

    if (rp.frequencyType === 'annually') {
      for (let y = Math.max(Math.ceil(startYear), 1); y <= endYear; y++) {
        const p = yearToPeriod(y, periodsPerYear);
        if (p <= totalPeriods) extraMap.set(p, (extraMap.get(p) || 0) + rp.amount);
      }
    } else {
      const startPeriod = Math.max(1, Math.round(startYear * periodsPerYear) + 1);
      const endPeriod = Math.min(totalPeriods, Math.round(endYear * periodsPerYear));
      for (let p = startPeriod; p <= endPeriod; p++) {
        extraMap.set(p, (extraMap.get(p) || 0) + rp.amount);
      }
    }
  }

  let balance = principal;
  let currentRate = events[0].rate;
  let periodicRate = periodicRateFromAnnual(currentRate, periodsPerYear);
  let payment = computePayment(balance, currentRate, freqDef, totalPeriods);

  const schedule = [];
  let eventIdx = 1;

  for (let period = 1; period <= totalPeriods && balance > 0.005; period++) {
    if (eventIdx < events.length && events[eventIdx].atPeriod === period - 1) {
      currentRate = events[eventIdx].rate;
      periodicRate = periodicRateFromAnnual(currentRate, periodsPerYear);
      const remainingPeriods = totalPeriods - (period - 1);
      payment = computePayment(balance, currentRate, freqDef, remainingPeriods);
      eventIdx++;
    }

    const interest = balance * periodicRate;
    let principalPortion = payment - interest;
    let extra = extraMap.get(period) || 0;
    let actualPayment = payment;

    if (principalPortion + extra >= balance) {
      extra = Math.min(extra, balance);
      principalPortion = balance - extra;
      actualPayment = principalPortion + interest;
      balance = 0;
    } else {
      balance -= principalPortion + extra;
    }

    schedule.push({
      period,
      date: addPeriodsToDate(startDate, period, freqDef),
      rate: currentRate,
      payment: actualPayment,
      interest,
      principal: principalPortion,
      extra,
      balance,
    });
  }

  return { schedule, freqDef, totalPeriods, initialPayment: computePayment(principal, annualRate, freqDef, totalPeriods) };
}

function yearlyAggregates(schedule, periodsPerYear) {
  const byYear = new Map();
  for (const row of schedule) {
    const y = Math.floor((row.period - 1) / periodsPerYear) + 1;
    if (!byYear.has(y)) byYear.set(y, { year: y, principal: 0, interest: 0, extra: 0 });
    const agg = byYear.get(y);
    agg.principal += row.principal;
    agg.interest += row.interest;
    agg.extra += row.extra;
  }
  return Array.from(byYear.values()).sort((a, b) => a.year - b.year);
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatCurrency(v, decimals = 0) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function formatDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function niceStep(range) {
  const raw = range / 6 || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}
function niceTicks(min, max) {
  const step = niceStep(max - min);
  const ticks = [];
  for (let v = min; v <= max + step * 0.01; v += step) ticks.push(Math.round(v));
  return ticks;
}

// ─── BalanceLineChart ───────────────────────────────────────────────────────

function BalanceLineChart({ actual, baseline, periodsPerYear }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(800);
  const [tooltip, setTooltip] = useState(null);
  const height = 320;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((e) => { const w = e[0].contentRect.width; if (w > 0) setWidth(w); });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const chartW = width - CHART_PADDING.left - CHART_PADDING.right;
  const chartH = height - CHART_PADDING.top - CHART_PADDING.bottom;

  const maxPeriod = Math.max(actual[actual.length - 1]?.period || 0, baseline[baseline.length - 1]?.period || 0);
  const maxBalance = Math.max(actual[0]?.balance ?? 0, baseline[0]?.balance ?? 0, 1);
  const yMax = niceStep(maxBalance) * Math.ceil(maxBalance / niceStep(maxBalance));
  const yTicks = niceTicks(0, yMax);

  const xScale = useCallback((period) => CHART_PADDING.left + (period / maxPeriod) * chartW, [maxPeriod, chartW]);
  const yScale = useCallback((val) => CHART_PADDING.top + (1 - val / yMax) * chartH, [yMax, chartH]);

  const buildPath = useCallback((data) => {
    const pts = [{ period: 0, balance: data[0] ? data[0].balance + data[0].principal + data[0].extra : 0 }, ...data];
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.period).toFixed(1)},${yScale(p.balance).toFixed(1)}`).join(' ');
  }, [xScale, yScale]);

  const actualPath = useMemo(() => buildPath(actual), [actual, buildPath]);
  const baselinePath = useMemo(() => buildPath(baseline), [baseline, buildPath]);

  const xTicks = useMemo(() => {
    const maxYears = Math.ceil(maxPeriod / periodsPerYear) || 1;
    const yearsPerTick = maxYears > 25 ? 5 : maxYears > 10 ? 2 : 1;
    const ticks = [];
    for (let y = 0; y <= maxYears; y += yearsPerTick) {
      const period = Math.min(y * periodsPerYear, maxPeriod);
      ticks.push({ period, label: `Yr ${y}` });
    }
    return ticks;
  }, [maxPeriod, periodsPerYear]);

  const handlePointer = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left;
    const period = Math.round(((x - CHART_PADDING.left) / chartW) * maxPeriod);
    const findNearest = (data) => {
      let lo = 0, hi = data.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid].period < period) lo = mid + 1; else hi = mid; }
      return data[lo];
    };
    if (!actual.length) return;
    const nearActual = findNearest(actual);
    const nearBaseline = baseline.length ? findNearest(baseline) : null;
    setTooltip({ px: xScale(nearActual.period), nearActual, nearBaseline });
  }, [actual, baseline, chartW, maxPeriod, xScale]);

  if (actual.length === 0) return null;

  return (
    <div style={styles.chartContainer}>
      <div style={styles.legend}>
        <span style={styles.legendItem}><span style={styles.legendDot(COLORS.actual)} />Your plan</span>
        <span style={styles.legendItem}><span style={styles.legendDot(COLORS.baseline)} />No extra payments</span>
      </div>
      <div ref={containerRef} style={{ position: 'relative' }}>
        <svg width={width} height={height} style={{ display: 'block' }}
          onMouseMove={handlePointer} onTouchMove={handlePointer}
          onMouseLeave={() => setTooltip(null)} onTouchEnd={() => setTooltip(null)}>
          {yTicks.map((v) => (
            <g key={`y-${v}`}>
              <line x1={CHART_PADDING.left} y1={yScale(v)} x2={width - CHART_PADDING.right} y2={yScale(v)}
                stroke="var(--color-border)" strokeWidth={1} />
              <text x={CHART_PADDING.left - 8} y={yScale(v) + 4} textAnchor="end"
                fontSize={11} fontFamily="var(--font-body)" fill="var(--color-text-muted)">
                {formatCurrency(v)}
              </text>
            </g>
          ))}
          {xTicks.map(({ period, label }) => (
            <text key={`x-${label}`} x={xScale(period)} y={height - CHART_PADDING.bottom + 20}
              textAnchor="middle" fontSize={11} fontFamily="var(--font-body)" fill="var(--color-text-muted)">
              {label}
            </text>
          ))}
          <path d={baselinePath} fill="none" stroke={COLORS.baseline} strokeWidth={2} strokeLinejoin="round" strokeDasharray="6,4" />
          <path d={actualPath} fill="none" stroke={COLORS.actual} strokeWidth={2} strokeLinejoin="round" />
          {tooltip && (
            <line x1={tooltip.px} y1={CHART_PADDING.top} x2={tooltip.px} y2={height - CHART_PADDING.bottom}
              stroke="var(--color-text-muted)" strokeWidth={1} opacity={0.5} />
          )}
        </svg>
        {tooltip && (
          <div style={{ ...styles.tooltip, left: Math.min(tooltip.px, width - 180), top: 10 }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginBottom: '0.25rem' }}>
              {formatDate(tooltip.nearActual.date)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.9rem' }}>
              <span style={styles.legendDot(COLORS.actual)} />
              <span style={{ fontWeight: 600, fontFamily: 'var(--font-display)' }}>{formatCurrency(tooltip.nearActual.balance)}</span>
            </div>
            {tooltip.nearBaseline && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.9rem', marginTop: '0.15rem' }}>
                <span style={styles.legendDot(COLORS.baseline)} />
                <span style={{ fontWeight: 600, fontFamily: 'var(--font-display)' }}>{formatCurrency(tooltip.nearBaseline.balance)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── YearlyBreakdownChart (stacked bar) ─────────────────────────────────────

function YearlyBreakdownChart({ yearly }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(800);
  const [hoverIdx, setHoverIdx] = useState(null);
  const height = 300;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((e) => { const w = e[0].contentRect.width; if (w > 0) setWidth(w); });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const chartW = width - CHART_PADDING.left - CHART_PADDING.right;
  const chartH = height - CHART_PADDING.top - CHART_PADDING.bottom;

  const maxTotal = Math.max(...yearly.map((y) => y.principal + y.interest + y.extra), 1);
  const yMax = niceStep(maxTotal) * Math.ceil(maxTotal / niceStep(maxTotal));
  const yTicks = niceTicks(0, yMax);
  const yScale = useCallback((val) => (val / yMax) * chartH, [yMax, chartH]);

  const barWidth = Math.max(2, chartW / yearly.length - 3);
  const gap = 2;

  if (yearly.length === 0) return null;

  return (
    <div style={styles.chartContainer}>
      <div style={styles.legend}>
        <span style={styles.legendItem}><span style={styles.legendDot(COLORS.principal)} />Principal</span>
        <span style={styles.legendItem}><span style={styles.legendDot(COLORS.interest)} />Interest</span>
        <span style={styles.legendItem}><span style={styles.legendDot(COLORS.extra)} />Extra payments</span>
      </div>
      <div ref={containerRef} style={{ position: 'relative' }}>
        <svg width={width} height={height} style={{ display: 'block' }}>
          {yTicks.map((v) => (
            <g key={`yb-${v}`}>
              <line x1={CHART_PADDING.left} y1={CHART_PADDING.top + chartH - yScale(v)} x2={width - CHART_PADDING.right} y2={CHART_PADDING.top + chartH - yScale(v)}
                stroke="var(--color-border)" strokeWidth={1} />
              <text x={CHART_PADDING.left - 8} y={CHART_PADDING.top + chartH - yScale(v) + 4} textAnchor="end"
                fontSize={11} fontFamily="var(--font-body)" fill="var(--color-text-muted)">
                {formatCurrency(v)}
              </text>
            </g>
          ))}
          {yearly.map((y, i) => {
            const x = CHART_PADDING.left + (i / yearly.length) * chartW + gap / 2;
            const baseY = CHART_PADDING.top + chartH;
            const hP = yScale(y.principal);
            const hI = yScale(y.interest);
            const hE = yScale(y.extra);
            let cursor = baseY;
            const segs = [
              { h: hP, color: COLORS.principal },
              { h: hI, color: COLORS.interest },
              { h: hE, color: COLORS.extra },
            ];
            return (
              <g key={y.year}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}>
                <rect x={x} y={CHART_PADDING.top} width={barWidth} height={chartH} fill="transparent" />
                {segs.map((s, si) => {
                  if (s.h <= 0) return null;
                  const y0 = cursor - s.h;
                  cursor = y0 - 1;
                  return (
                    <rect key={si} x={x} y={y0} width={barWidth} height={Math.max(0, s.h - 1)}
                      fill={s.color} opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.35} rx={1.5} />
                  );
                })}
                {(yearly.length <= 20 || y.year % 5 === 0) && (
                  <text x={x + barWidth / 2} y={height - CHART_PADDING.bottom + 20} textAnchor="middle"
                    fontSize={10} fontFamily="var(--font-body)" fill="var(--color-text-muted)">
                    {y.year}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hoverIdx !== null && (
          <div style={{ ...styles.tooltip, left: Math.min((hoverIdx / yearly.length) * chartW + CHART_PADDING.left, width - 180), top: 10 }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginBottom: '0.25rem' }}>Year {yearly[hoverIdx].year}</div>
            <div style={{ fontSize: '0.85rem' }}>Principal: <strong>{formatCurrency(yearly[hoverIdx].principal)}</strong></div>
            <div style={{ fontSize: '0.85rem' }}>Interest: <strong>{formatCurrency(yearly[hoverIdx].interest)}</strong></div>
            {yearly[hoverIdx].extra > 0 && (
              <div style={{ fontSize: '0.85rem' }}>Extra: <strong>{formatCurrency(yearly[hoverIdx].extra)}</strong></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

let idCounter = 0;
function nextId() { return ++idCounter; }

export default function MortgageCalculator() {
  const [principal, setPrincipal] = useState(500000);
  const [annualRate, setAnnualRate] = useState(5.5);
  const [amortYears, setAmortYears] = useState(25);
  const [frequencyKey, setFrequencyKey] = useState('monthly');
  const [startDateStr, setStartDateStr] = useState(() => new Date().toISOString().slice(0, 10));
  const startDate = useMemo(() => new Date(startDateStr + 'T00:00:00'), [startDateStr]);

  const [rateChanges, setRateChanges] = useState([]);
  const [extraPayments, setExtraPayments] = useState([]);
  const [recurringPayments, setRecurringPayments] = useState([]);

  const addRateChange = () => setRateChanges((prev) => [...prev, { id: nextId(), atYear: 5, newRate: annualRate }]);
  const updateRateChange = (id, field, value) => setRateChanges((prev) => prev.map((rc) => (rc.id === id ? { ...rc, [field]: value } : rc)));
  const removeRateChange = (id) => setRateChanges((prev) => prev.filter((rc) => rc.id !== id));

  const addExtraPayment = () => setExtraPayments((prev) => [...prev, { id: nextId(), atYear: 1, amount: 5000 }]);
  const updateExtraPayment = (id, field, value) => setExtraPayments((prev) => prev.map((ep) => (ep.id === id ? { ...ep, [field]: value } : ep)));
  const removeExtraPayment = (id) => setExtraPayments((prev) => prev.filter((ep) => ep.id !== id));

  const addRecurringPayment = () => setRecurringPayments((prev) => [...prev, { id: nextId(), frequencyType: 'every-payment', startYear: 0, endYear: amortYears, amount: 200 }]);
  const updateRecurringPayment = (id, field, value) => setRecurringPayments((prev) => prev.map((rp) => (rp.id === id ? { ...rp, [field]: value } : rp)));
  const removeRecurringPayment = (id) => setRecurringPayments((prev) => prev.filter((rp) => rp.id !== id));

  const error = useMemo(() => {
    if (!(principal > 0)) return 'Principal must be greater than 0.';
    if (annualRate < 0) return 'Interest rate cannot be negative.';
    if (!(amortYears > 0)) return 'Amortization period must be greater than 0.';
    if (Number.isNaN(startDate.getTime())) return 'Start date is invalid.';
    return null;
  }, [principal, annualRate, amortYears, startDate]);

  const result = useMemo(() => {
    if (error) return null;
    const params = { principal, annualRate, amortYears, frequencyKey, startDate, rateChanges, extraPayments, recurringPayments };
    const actual = buildSchedule(params);
    const baseline = buildSchedule({ ...params, extraPayments: [], recurringPayments: [] });
    return { actual, baseline };
  }, [error, principal, annualRate, amortYears, frequencyKey, startDate, rateChanges, extraPayments, recurringPayments]);

  const yearly = useMemo(() => (result ? yearlyAggregates(result.actual.schedule, result.actual.freqDef.periodsPerYear) : []), [result]);

  const stats = useMemo(() => {
    if (!result) return null;
    const { actual, baseline } = result;
    const totalInterestActual = actual.schedule.reduce((s, r) => s + r.interest, 0);
    const totalInterestBaseline = baseline.schedule.reduce((s, r) => s + r.interest, 0);
    const payoffDate = actual.schedule[actual.schedule.length - 1]?.date;
    const baselinePayoffDate = baseline.schedule[baseline.schedule.length - 1]?.date;
    const periodsSaved = baseline.schedule.length - actual.schedule.length;
    const yearsSaved = periodsSaved / actual.freqDef.periodsPerYear;

    // Split of the payment you're on right now: the next payment due on or
    // after today, or the first payment if the loan hasn't started yet.
    // Extra payments are excluded so the two shares always sum to 100%.
    const now = Date.now();
    const current =
      actual.schedule.find((r) => r.date.getTime() >= now) ||
      actual.schedule[actual.schedule.length - 1];
    const currentScheduled = current ? current.principal + current.interest : 0;
    const principalShare = currentScheduled > 0 ? (current.principal / currentScheduled) * 100 : 0;

    return {
      payment: actual.initialPayment,
      currentDate: current ? current.date : null,
      currentPrincipal: current ? current.principal : 0,
      currentInterest: current ? current.interest : 0,
      principalShare,
      interestShare: currentScheduled > 0 ? 100 - principalShare : 0,
      payoffDate,
      baselinePayoffDate,
      totalInterestActual,
      totalInterestBaseline,
      interestSaved: totalInterestBaseline - totalInterestActual,
      yearsSaved,
    };
  }, [result]);

  return (
    <div style={styles.page}>
      <PageHeader
        title="Mortgage Payoff Calculator"
        subtitle="See how payment frequency, extra payments, and rate changes affect your payoff timeline."
      />

      {error && <div style={styles.errorBox}>{error}</div>}

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Loan Details</h2>
        <div style={styles.grid}>
          <div style={styles.field}>
            <label style={styles.label}>Principal ($)</label>
            <input style={styles.input} type="number" min="0" step="1000" value={principal}
              onChange={(e) => setPrincipal(Number(e.target.value))} />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Interest Rate (%)</label>
            <input style={styles.input} type="number" min="0" step="0.05" value={annualRate}
              onChange={(e) => setAnnualRate(Number(e.target.value))} />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Amortization (years)</label>
            <input style={styles.input} type="number" min="1" step="1" value={amortYears}
              onChange={(e) => setAmortYears(Number(e.target.value))} />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Payment Frequency</label>
            <select style={styles.select} value={frequencyKey} onChange={(e) => setFrequencyKey(e.target.value)}>
              {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Start Date</label>
            <input style={styles.input} type="date" value={startDateStr}
              onChange={(e) => setStartDateStr(e.target.value)} />
          </div>
        </div>
      </div>

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Rate Changes (e.g. Renewal)</h2>
        {rateChanges.length === 0 && (
          <p style={styles.emptyRowNote}>Assumes the initial rate for the full amortization. Add a change if your rate resets at a future renewal.</p>
        )}
        {rateChanges.map((rc) => (
          <div key={rc.id} style={styles.row}>
            <div style={styles.smallField}>
              <label style={styles.label}>After year</label>
              <input style={styles.input} type="number" min="1" max={amortYears - 1} step="1" value={rc.atYear}
                onChange={(e) => updateRateChange(rc.id, 'atYear', Number(e.target.value))} />
            </div>
            <div style={styles.smallField}>
              <label style={styles.label}>New rate (%)</label>
              <input style={styles.input} type="number" min="0" step="0.05" value={rc.newRate}
                onChange={(e) => updateRateChange(rc.id, 'newRate', Number(e.target.value))} />
            </div>
            <button style={styles.removeBtn} onClick={() => removeRateChange(rc.id)}>Remove</button>
          </div>
        ))}
        <button style={styles.addBtn} onClick={addRateChange}>+ Add Rate Change</button>
      </div>

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Regular Extra Payments</h2>
        {recurringPayments.length === 0 && (
          <p style={styles.emptyRowNote}>Add a recurring extra amount — on top of every payment, or once a year — applied to principal over a year range.</p>
        )}
        {recurringPayments.map((rp) => (
          <div key={rp.id} style={styles.row}>
            <div style={styles.smallField}>
              <label style={styles.label}>Frequency</label>
              <select style={styles.select} value={rp.frequencyType}
                onChange={(e) => updateRecurringPayment(rp.id, 'frequencyType', e.target.value)}>
                <option value="every-payment">Every payment</option>
                <option value="annually">Once a year</option>
              </select>
            </div>
            <div style={styles.smallField}>
              <label style={styles.label}>Amount ($)</label>
              <input style={styles.input} type="number" min="0" step="50" value={rp.amount}
                onChange={(e) => updateRecurringPayment(rp.id, 'amount', Number(e.target.value))} />
            </div>
            <div style={styles.smallField}>
              <label style={styles.label}>Start year</label>
              <input style={styles.input} type="number" min="0" max={amortYears} step="0.1" value={rp.startYear}
                onChange={(e) => updateRecurringPayment(rp.id, 'startYear', Number(e.target.value))} />
            </div>
            <div style={styles.smallField}>
              <label style={styles.label}>End year</label>
              <input style={styles.input} type="number" min="0" max={amortYears} step="1" value={rp.endYear}
                onChange={(e) => updateRecurringPayment(rp.id, 'endYear', Number(e.target.value))} />
            </div>
            <button style={styles.removeBtn} onClick={() => removeRecurringPayment(rp.id)}>Remove</button>
          </div>
        ))}
        <button style={styles.addBtn} onClick={addRecurringPayment}>+ Add Regular Extra Payment</button>
      </div>

      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>One-Off Extra Payments</h2>
        {extraPayments.length === 0 && (
          <p style={styles.emptyRowNote}>Add lump-sum payments applied directly to principal at a specific point in the mortgage.</p>
        )}
        {extraPayments.map((ep) => (
          <div key={ep.id} style={styles.row}>
            <div style={styles.smallField}>
              <label style={styles.label}>At year</label>
              <input style={styles.input} type="number" min="0.1" max={amortYears} step="0.1" value={ep.atYear}
                onChange={(e) => updateExtraPayment(ep.id, 'atYear', Number(e.target.value))} />
            </div>
            <div style={styles.smallField}>
              <label style={styles.label}>Amount ($)</label>
              <input style={styles.input} type="number" min="0" step="500" value={ep.amount}
                onChange={(e) => updateExtraPayment(ep.id, 'amount', Number(e.target.value))} />
            </div>
            <button style={styles.removeBtn} onClick={() => removeExtraPayment(ep.id)}>Remove</button>
          </div>
        ))}
        <button style={styles.addBtn} onClick={addExtraPayment}>+ Add Extra Payment</button>
      </div>

      {stats && (
        <div style={styles.statsGrid}>
          <div style={styles.statCard}>
            <div style={styles.statValue}>{formatCurrency(stats.payment, 2)}</div>
            <div style={styles.statLabel}>Payment per period</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statValue}>
              {formatCurrency(stats.currentPrincipal, 2)}
              <span style={styles.statPct}>{stats.principalShare.toFixed(1)}%</span>
            </div>
            <div style={styles.statLabel}>Current principal portion</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statValue}>
              {formatCurrency(stats.currentInterest, 2)}
              <span style={styles.statPct}>{stats.interestShare.toFixed(1)}%</span>
            </div>
            <div style={styles.statLabel}>Current interest portion</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statValue}>{formatDate(stats.payoffDate)}</div>
            <div style={styles.statLabel}>Payoff date</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statValue}>{formatCurrency(stats.totalInterestActual)}</div>
            <div style={styles.statLabel}>Total interest paid</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statValue}>{formatCurrency(stats.interestSaved)}</div>
            <div style={styles.statLabel}>Interest saved vs. no extra payments</div>
          </div>
          <div style={styles.statCard}>
            <div style={styles.statValue}>{stats.yearsSaved > 0 ? `${stats.yearsSaved.toFixed(1)} yrs` : '0 yrs'}</div>
            <div style={styles.statLabel}>Time saved vs. no extra payments</div>
          </div>
        </div>
      )}

      {result && (
        <>
          <BalanceLineChart actual={result.actual.schedule} baseline={result.baseline.schedule} periodsPerYear={result.actual.freqDef.periodsPerYear} />
          <YearlyBreakdownChart yearly={yearly} />
        </>
      )}
    </div>
  );
}
