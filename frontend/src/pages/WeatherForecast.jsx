import { useState, useEffect, useCallback, useRef } from 'react';
import PageHeader from '../components/PageHeader';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_LOCATION = { name: 'Port Moody, BC', lat: 49.2838, lon: -122.8508 };
const CACHE_KEY = 'weather_cache';
const LOCATION_KEY = 'weather_location';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ─── WMO Weather Codes → Emoji + Description ────────────────────────────────

const WMO_CODES = {
  0: { emoji: '\u2600\uFE0F', desc: 'Clear sky' },
  1: { emoji: '\uD83C\uDF24\uFE0F', desc: 'Mainly clear' },
  2: { emoji: '\u26C5', desc: 'Partly cloudy' },
  3: { emoji: '\u2601\uFE0F', desc: 'Overcast' },
  45: { emoji: '\uD83C\uDF2B\uFE0F', desc: 'Fog' },
  48: { emoji: '\uD83C\uDF2B\uFE0F', desc: 'Rime fog' },
  51: { emoji: '\uD83C\uDF26\uFE0F', desc: 'Light drizzle' },
  53: { emoji: '\uD83C\uDF26\uFE0F', desc: 'Drizzle' },
  55: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Heavy drizzle' },
  56: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Freezing drizzle' },
  57: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Heavy freezing drizzle' },
  61: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Light rain' },
  63: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Rain' },
  65: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Heavy rain' },
  66: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Freezing rain' },
  67: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Heavy freezing rain' },
  71: { emoji: '\uD83C\uDF28\uFE0F', desc: 'Light snow' },
  73: { emoji: '\uD83C\uDF28\uFE0F', desc: 'Snow' },
  75: { emoji: '\u2744\uFE0F', desc: 'Heavy snow' },
  77: { emoji: '\u2744\uFE0F', desc: 'Snow grains' },
  80: { emoji: '\uD83C\uDF26\uFE0F', desc: 'Light showers' },
  81: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Showers' },
  82: { emoji: '\uD83C\uDF27\uFE0F', desc: 'Heavy showers' },
  85: { emoji: '\uD83C\uDF28\uFE0F', desc: 'Light snow showers' },
  86: { emoji: '\uD83C\uDF28\uFE0F', desc: 'Heavy snow showers' },
  95: { emoji: '\u26C8\uFE0F', desc: 'Thunderstorm' },
  96: { emoji: '\u26C8\uFE0F', desc: 'Thunderstorm with hail' },
  99: { emoji: '\u26C8\uFE0F', desc: 'Thunderstorm with heavy hail' },
};

function getWeatherInfo(code) {
  return WMO_CODES[code] || { emoji: '\u2753', desc: 'Unknown' };
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  page: {
    maxWidth: '720px',
    margin: '0 auto',
    padding: '2rem 1.5rem',
  },
  tabs: {
    display: 'flex',
    gap: '0.25rem',
    marginBottom: '2rem',
    borderBottom: '2px solid var(--color-border)',
  },
  tab: (active) => ({
    padding: '0.6rem 1.25rem',
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent',
    marginBottom: '-2px',
    fontFamily: 'var(--font-body)',
    fontSize: '0.95rem',
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
    cursor: 'pointer',
    transition: 'color 0.15s',
  }),
  locationBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '1.5rem',
    flexWrap: 'wrap',
  },
  locationName: {
    fontSize: '1.1rem',
    fontWeight: 600,
    fontFamily: 'var(--font-display)',
    color: 'var(--color-text)',
  },
  smallBtn: {
    padding: '0.35rem 0.75rem',
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '6px',
    fontFamily: 'var(--font-body)',
    fontSize: '0.82rem',
    cursor: 'pointer',
    color: 'var(--color-text-muted)',
  },
  updatedText: {
    fontSize: '0.8rem',
    color: 'var(--color-text-muted)',
    marginLeft: 'auto',
  },
  hero: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '12px',
    padding: '2rem',
    marginBottom: '2rem',
    display: 'flex',
    alignItems: 'center',
    gap: '2rem',
    flexWrap: 'wrap',
  },
  heroEmoji: {
    fontSize: '4rem',
    lineHeight: 1,
  },
  heroTemp: {
    fontSize: '3rem',
    fontWeight: 700,
    fontFamily: 'var(--font-display)',
    margin: 0,
    lineHeight: 1,
  },
  heroRange: {
    fontSize: '1rem',
    color: 'var(--color-text-muted)',
    fontWeight: 400,
  },
  heroDetail: {
    fontSize: '0.9rem',
    color: 'var(--color-text-muted)',
    margin: '0.25rem 0 0',
  },
  forecastCard: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '10px',
    padding: '0.75rem 1rem',
  },
  forecastRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  forecastLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    minWidth: '140px',
  },
  forecastStats: {
    display: 'flex',
    flex: 1,
    justifyContent: 'flex-end',
    gap: '1.5rem',
  },
  statCell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  statValue: {
    fontSize: '0.92rem',
    fontWeight: 600,
    fontFamily: 'var(--font-display)',
    lineHeight: 1.2,
  },
  statLabel: {
    fontSize: '0.7rem',
    color: 'var(--color-text-muted)',
    lineHeight: 1.2,
  },
  distRow: {
    display: 'flex',
    gap: '0.75rem',
    marginTop: '0.4rem',
    paddingTop: '0.4rem',
    borderTop: '1px solid var(--color-border)',
  },
  searchOverlay: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    zIndex: 100,
    marginTop: '0.25rem',
    maxHeight: '240px',
    overflowY: 'auto',
  },
  searchResult: (highlighted) => ({
    display: 'block',
    width: '100%',
    padding: '0.65rem 1rem',
    background: highlighted ? 'var(--color-border)' : 'none',
    border: 'none',
    borderBottom: '1px solid var(--color-border)',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'var(--font-body)',
    fontSize: '0.9rem',
    color: 'var(--color-text)',
  }),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTemp(c) {
  return `${Math.round(c)}\u00B0C`;
}

function formatPrecip(mm) {
  if (mm < 0.05) return '0 mm';
  if (mm < 1) return `${mm.toFixed(1)} mm`;
  return `${Math.round(mm)} mm`;
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: 'numeric', hour12: true });
}

function formatDay(isoString) {
  const d = new Date(isoString + 'T12:00:00');
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function mode(arr) {
  const freq = {};
  arr.forEach((v) => { freq[v] = (freq[v] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeEnsembleStats(hourlyData, variable) {
  const times = hourlyData.time;
  const meanKey = variable;
  const stats = [];

  // Find member keys
  const memberKeys = Object.keys(hourlyData).filter(
    (k) => k.startsWith(variable + '_member')
  );

  for (let i = 0; i < times.length; i++) {
    const members = memberKeys.map((k) => hourlyData[k][i]).filter((v) => v != null);
    if (members.length === 0) {
      const fallback = hourlyData[meanKey]?.[i] ?? 0;
      stats.push({ time: times[i], mean: fallback, p5: fallback, p10: fallback, p25: fallback, p50: fallback, p75: fallback, p90: fallback, p95: fallback, members: [] });
      continue;
    }
    members.sort((a, b) => a - b);
    stats.push({
      time: times[i],
      mean: members.reduce((s, v) => s + v, 0) / members.length,
      p5: percentile(members, 5),
      p10: percentile(members, 10),
      p25: percentile(members, 25),
      p50: percentile(members, 50),
      p75: percentile(members, 75),
      p90: percentile(members, 90),
      p95: percentile(members, 95),
      members,
    });
  }
  return stats;
}

function extractMemberTimeseries(hourlyData, variable) {
  const memberKeys = Object.keys(hourlyData).filter(
    (k) => k.startsWith(variable + '_member')
  );
  return memberKeys.map((k) => hourlyData[k]);
}

function buildHourlyData(ensembleHourly, regularHourly) {
  const tempStats = computeEnsembleStats(ensembleHourly, 'temperature_2m');
  const feelsStats = computeEnsembleStats(ensembleHourly, 'apparent_temperature');
  const windStats = computeEnsembleStats(ensembleHourly, 'wind_speed_10m');
  const rainStats = computeEnsembleStats(ensembleHourly, 'rain');
  const snowStats = computeEnsembleStats(ensembleHourly, 'snowfall');

  // Weather code: use mean/first available
  const weatherCodes = ensembleHourly.weather_code || [];

  // Precipitation probability from regular API
  const precipProb = regularHourly?.precipitation_probability || [];
  const regularTimes = regularHourly?.time || [];
  const precipProbMap = {};
  regularTimes.forEach((t, i) => { precipProbMap[t] = precipProb[i]; });

  const distFrom = (s) => ({ p5: s?.p5 ?? 0, p10: s?.p10 ?? 0, p25: s?.p25 ?? 0, p50: s?.p50 ?? 0, p75: s?.p75 ?? 0, p90: s?.p90 ?? 0, p95: s?.p95 ?? 0 });

  return tempStats.map((t, i) => ({
    time: t.time,
    temp: t.mean,
    tempP10: t.p10,
    tempP90: t.p90,
    tempDist: { p5: t.p5, p10: t.p10, p25: t.p25, p50: t.p50, p75: t.p75, p90: t.p90, p95: t.p95 },
    feelsLike: feelsStats[i]?.mean ?? t.mean,
    wind: windStats[i]?.mean ?? 0,
    windP10: windStats[i]?.p10 ?? 0,
    windP90: windStats[i]?.p90 ?? 0,
    rain: rainStats[i]?.mean ?? 0,
    rainDist: distFrom(rainStats[i]),
    snow: snowStats[i]?.mean ?? 0,
    snowDist: distFrom(snowStats[i]),
    weatherCode: weatherCodes[i] ?? 0,
    precipProb: precipProbMap[t.time] ?? null,
  }));
}

function buildDailyData(hourly, regularDaily, ensembleHourly) {
  // Group hourly indices by date
  const byDate = {};
  hourly.forEach((h, idx) => {
    const date = h.time.slice(0, 10);
    if (!byDate[date]) byDate[date] = { hours: [], indices: [] };
    byDate[date].hours.push(h);
    byDate[date].indices.push(idx);
  });

  const dailyPrecipProbMax = {};
  if (regularDaily?.time) {
    regularDaily.time.forEach((t, i) => {
      dailyPrecipProbMax[t] = regularDaily.precipitation_probability_max?.[i] ?? null;
    });
  }

  // Get member timeseries for per-member daily aggregation
  const tempMembers = extractMemberTimeseries(ensembleHourly, 'temperature_2m');
  const feelsMembers = extractMemberTimeseries(ensembleHourly, 'apparent_temperature');
  const rainMembers = extractMemberTimeseries(ensembleHourly, 'rain');
  const snowMembers = extractMemberTimeseries(ensembleHourly, 'snowfall');

  const distFromSorted = (arr) => arr.length > 0
    ? { p5: percentile(arr, 5), p10: percentile(arr, 10), p25: percentile(arr, 25), p50: percentile(arr, 50), p75: percentile(arr, 75), p90: percentile(arr, 90), p95: percentile(arr, 95) }
    : null;

  return Object.entries(byDate).map(([date, { hours, indices }]) => {
    const afternoonHours = hours.filter((h) => {
      const hr = new Date(h.time).getHours();
      return hr >= 9 && hr <= 18;
    });
    const codeSource = afternoonHours.length > 0 ? afternoonHours : hours;
    const weatherCode = parseInt(mode(codeSource.map((h) => h.weatherCode)), 10) || 0;

    // Per-member daily high/low
    const memberHighs = tempMembers.map((series) =>
      Math.max(...indices.map((i) => series[i]).filter((v) => v != null))
    ).filter((v) => isFinite(v));
    memberHighs.sort((a, b) => a - b);

    const memberLows = tempMembers.map((series) =>
      Math.min(...indices.map((i) => series[i]).filter((v) => v != null))
    ).filter((v) => isFinite(v));
    memberLows.sort((a, b) => a - b);

    // Per-member daily feels-like high/low
    const feelsHighs = feelsMembers.map((series) =>
      Math.max(...indices.map((i) => series[i]).filter((v) => v != null))
    ).filter((v) => isFinite(v));
    feelsHighs.sort((a, b) => a - b);
    const feelsLows = feelsMembers.map((series) =>
      Math.min(...indices.map((i) => series[i]).filter((v) => v != null))
    ).filter((v) => isFinite(v));
    feelsLows.sort((a, b) => a - b);

    // Per-member daily total rain (mm) and snow (cm)
    const memberRainTotals = rainMembers.map((series) =>
      indices.reduce((s, i) => s + (series[i] ?? 0), 0)
    );
    memberRainTotals.sort((a, b) => a - b);

    const memberSnowTotals = snowMembers.map((series) =>
      indices.reduce((s, i) => s + (series[i] ?? 0), 0)
    );
    memberSnowTotals.sort((a, b) => a - b);

    return {
      date,
      high: memberHighs.length > 0 ? percentile(memberHighs, 50) : Math.max(...hours.map((h) => h.temp)),
      low: memberLows.length > 0 ? percentile(memberLows, 50) : Math.min(...hours.map((h) => h.temp)),
      feelsHigh: feelsHighs.length > 0 ? percentile(feelsHighs, 50) : Math.max(...hours.map((h) => h.feelsLike)),
      feelsLow: feelsLows.length > 0 ? percentile(feelsLows, 50) : Math.min(...hours.map((h) => h.feelsLike)),
      highDist: distFromSorted(memberHighs),
      lowDist: distFromSorted(memberLows),
      rainDist: distFromSorted(memberRainTotals),
      snowDist: distFromSorted(memberSnowTotals),
      weatherCode,
      precipProb: dailyPrecipProbMax[date] ?? Math.max(...hours.map((h) => h.precipProb ?? 0)),
      wind: Math.max(...hours.map((h) => h.wind)),
    };
  });
}

// ─── Cache Helpers ───────────────────────────────────────────────────────────

function getCachedData(lat, lon) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (cached.lat !== lat || cached.lon !== lon) return null;
    if (Date.now() - cached.timestamp > CACHE_TTL) return null;
    return cached;
  } catch {
    return null;
  }
}

function setCachedData(lat, lon, data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ lat, lon, timestamp: Date.now(), ...data }));
  } catch { /* ignore quota errors */ }
}

function getSavedLocation() {
  try {
    const raw = localStorage.getItem(LOCATION_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_LOCATION;
  } catch {
    return DEFAULT_LOCATION;
  }
}

function saveLocation(loc) {
  try {
    localStorage.setItem(LOCATION_KEY, JSON.stringify(loc));
  } catch { /* ignore */ }
}

// ─── API Fetchers ────────────────────────────────────────────────────────────

async function fetchWeatherData(lat, lon) {
  const ensembleUrl = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,apparent_temperature,rain,snowfall,wind_speed_10m,weather_code&models=gfs_seamless&forecast_days=14&timezone=auto`;
  const regularUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability&daily=precipitation_probability_max&forecast_days=14&timezone=auto`;

  const [ensembleRes, regularRes] = await Promise.all([
    fetch(ensembleUrl),
    fetch(regularUrl),
  ]);

  if (!ensembleRes.ok) throw new Error(`Ensemble API error: ${ensembleRes.status}`);
  if (!regularRes.ok) throw new Error(`Forecast API error: ${regularRes.status}`);

  const ensemble = await ensembleRes.json();
  const regular = await regularRes.json();

  return { ensemble, regular };
}

async function searchLocations(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((r) => ({
    name: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

// ─── LocationSearch ──────────────────────────────────────────────────────────

function LocationSearch({ onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      const locs = await searchLocations(query);
      setResults(locs);
      setHighlightedIndex(0);
      setSearching(false);
    }, 350);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  function handleKeyDown(e) {
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[highlightedIndex]) onSelect(results[highlightedIndex]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search for a city..."
        style={{
          width: '100%',
          padding: '0.5rem 0.75rem',
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          fontFamily: 'var(--font-body)',
          fontSize: '0.9rem',
          background: 'var(--color-bg)',
          color: 'var(--color-text)',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      {query && results.length > 0 && (
        <div style={styles.searchOverlay}>
          {results.map((loc, i) => (
            <button
              key={`${loc.lat}-${loc.lon}`}
              style={styles.searchResult(i === highlightedIndex)}
              onMouseEnter={() => setHighlightedIndex(i)}
              onClick={() => onSelect(loc)}
            >
              {loc.name}
            </button>
          ))}
        </div>
      )}
      {searching && (
        <div style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
          ...
        </div>
      )}
    </div>
  );
}

// ─── DistributionBar ─────────────────────────────────────────────────────────
// Renders a compact SVG box plot: whiskers at p5–p95, box at p25–p75, line at p50

function DistributionBar({ dist, height = 10, color = 'var(--color-accent)', label, unit = '' }) {
  if (!dist || dist.p95 === dist.p5) return null;
  const svgW = 100;
  const pad = 2;
  const innerW = svgW - pad * 2;
  const scale = (v) => pad + ((v - dist.p5) / (dist.p95 - dist.p5)) * innerW;
  const midY = height / 2;
  const boxH = height - 4;
  const boxY = (height - boxH) / 2;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flex: 1, minWidth: 0 }}>
      {label && <span style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', flexShrink: 0 }}>{label}</span>}
      <svg viewBox={`0 0 ${svgW} ${height}`} preserveAspectRatio="none" style={{ display: 'block', flex: 1, height: `${height}px`, minWidth: 0 }}>
        <line x1={scale(dist.p5)} y1={midY} x2={scale(dist.p95)} y2={midY} stroke={color} strokeWidth={1} opacity={0.4} />
        <line x1={scale(dist.p5)} y1={boxY + 1} x2={scale(dist.p5)} y2={boxY + boxH - 1} stroke={color} strokeWidth={1} opacity={0.4} />
        <line x1={scale(dist.p95)} y1={boxY + 1} x2={scale(dist.p95)} y2={boxY + boxH - 1} stroke={color} strokeWidth={1} opacity={0.4} />
        <rect x={scale(dist.p25)} y={boxY} width={scale(dist.p75) - scale(dist.p25)} height={boxH} rx={2} fill={color} opacity={0.25} />
        <line x1={scale(dist.p50)} y1={boxY} x2={scale(dist.p50)} y2={boxY + boxH} stroke={color} strokeWidth={2} strokeLinecap="round" />
      </svg>
      <span style={{ fontSize: '0.55rem', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {Math.round(dist.p5)}{unit}{' – '}{Math.round(dist.p95)}{unit}
      </span>
    </div>
  );
}

// ─── CurrentConditions ───────────────────────────────────────────────────────

function CurrentConditions({ hourly }) {
  if (!hourly || hourly.length === 0) return null;
  const now = new Date();
  // Find the closest hour
  let closest = hourly[0];
  let minDiff = Infinity;
  for (const h of hourly) {
    const diff = Math.abs(new Date(h.time) - now);
    if (diff < minDiff) { minDiff = diff; closest = h; }
  }

  const weather = getWeatherInfo(closest.weatherCode);

  return (
    <div style={styles.hero}>
      <div style={styles.heroEmoji}>{weather.emoji}</div>
      <div>
        <p style={styles.heroTemp}>
          {formatTemp(closest.temp)}{' '}
          <span style={styles.heroRange}>({formatTemp(closest.tempP10)}{' – '}{formatTemp(closest.tempP90)})</span>
        </p>
        <p style={styles.heroDetail}>
          Feels like {formatTemp(closest.feelsLike)} · {weather.desc}
        </p>
        <p style={styles.heroDetail}>
          Wind {Math.round(closest.wind)} km/h
          {closest.precipProb != null ? ` · ${closest.precipProb}% precip` : ''}
        </p>
      </div>
    </div>
  );
}

// ─── HourlyCard ──────────────────────────────────────────────────────────────

function HourlyCard({ hour }) {
  const weather = getWeatherInfo(hour.weatherCode);
  const now = new Date();
  const hourDate = new Date(hour.time);
  const isNow = Math.abs(hourDate - now) < 30 * 60 * 1000;
  const hasRain = hour.rainDist && hour.rainDist.p95 > 0.05;
  const hasSnow = hour.snowDist && hour.snowDist.p95 > 0.05;

  return (
    <div style={{
      ...styles.forecastCard,
      borderColor: isNow ? 'var(--color-accent)' : 'var(--color-border)',
      borderWidth: isNow ? '2px' : '1px',
    }}>
      {/* Row 1: main info */}
      <div style={styles.forecastRow}>
        <div style={styles.forecastLeft}>
          <span style={{ fontSize: '1.4rem' }}>{weather.emoji}</span>
          <div>
            <div style={{ fontWeight: 600, fontFamily: 'var(--font-display)', fontSize: '0.92rem' }}>
              {isNow ? 'Now' : formatTime(hour.time)}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
              {weather.desc}
            </div>
          </div>
        </div>
        <div style={styles.forecastStats}>
          <div style={styles.statCell}>
            <span style={styles.statValue}>{formatTemp(hour.temp)}</span>
            <span style={styles.statLabel}>Feels {formatTemp(hour.feelsLike)}</span>
          </div>
          <div style={styles.statCell}>
            <span style={styles.statValue}>{Math.round(hour.wind)} km/h</span>
            <span style={styles.statLabel}>Wind</span>
          </div>
          {(hour.precipProb != null && hour.precipProb > 0) && (
            <div style={styles.statCell}>
              <span style={styles.statValue}>{hour.precipProb}%</span>
              <span style={styles.statLabel}>Precip</span>
            </div>
          )}
        </div>
      </div>
      {/* Row 2: distribution bars */}
      <div style={styles.distRow}>
        <DistributionBar dist={hour.tempDist} height={10} color="var(--color-accent)" label="Temp" unit={'\u00B0'} />
        {hasRain && <DistributionBar dist={hour.rainDist} height={10} color="#5b9bd5" label="Rain" unit="mm" />}
        {hasSnow && <DistributionBar dist={hour.snowDist} height={10} color="#7eb8d0" label="Snow" unit="cm" />}
      </div>
    </div>
  );
}

// ─── DailyCard ───────────────────────────────────────────────────────────────

function DailyCard({ day }) {
  const weather = getWeatherInfo(day.weatherCode);
  const hasRain = day.rainDist && day.rainDist.p95 > 0.05;
  const hasSnow = day.snowDist && day.snowDist.p95 > 0.05;

  return (
    <div style={styles.forecastCard}>
      {/* Row 1: main info */}
      <div style={styles.forecastRow}>
        <div style={styles.forecastLeft}>
          <span style={{ fontSize: '1.4rem' }}>{weather.emoji}</span>
          <div>
            <div style={{ fontWeight: 600, fontFamily: 'var(--font-display)', fontSize: '0.92rem' }}>
              {formatDay(day.date)}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
              {weather.desc}
            </div>
          </div>
        </div>
        <div style={styles.forecastStats}>
          <div style={styles.statCell}>
            <span style={styles.statValue}>{formatTemp(day.high)} / {formatTemp(day.low)}</span>
            <span style={styles.statLabel}>Feels {formatTemp(day.feelsHigh)} / {formatTemp(day.feelsLow)}</span>
          </div>
          <div style={styles.statCell}>
            <span style={styles.statValue}>{Math.round(day.wind)} km/h</span>
            <span style={styles.statLabel}>Wind</span>
          </div>
          {day.precipProb > 0 && (
            <div style={styles.statCell}>
              <span style={styles.statValue}>{day.precipProb}%</span>
              <span style={styles.statLabel}>Precip</span>
            </div>
          )}
        </div>
      </div>
      {/* Row 2: distribution bars */}
      <div style={styles.distRow}>
        {day.highDist && <DistributionBar dist={day.highDist} height={10} color="var(--color-accent)" label="High" unit={'\u00B0'} />}
        {day.lowDist && <DistributionBar dist={day.lowDist} height={10} color="#6baed6" label="Low" unit={'\u00B0'} />}
        {hasRain && <DistributionBar dist={day.rainDist} height={10} color="#5b9bd5" label="Rain" unit="mm" />}
        {hasSnow && <DistributionBar dist={day.snowDist} height={10} color="#7eb8d0" label="Snow" unit="cm" />}
      </div>
    </div>
  );
}

// ─── WeatherForecast (Page) ──────────────────────────────────────────────────

export default function WeatherForecast() {
  const [location, setLocation] = useState(getSavedLocation);
  const [hourlyData, setHourlyData] = useState(null);
  const [dailyData, setDailyData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeTab, setActiveTab] = useState('hourly');
  const [showSearch, setShowSearch] = useState(false);

  const loadWeather = useCallback(async (loc, bypassCache = false) => {
    setLoading(true);
    setError(null);

    if (!bypassCache) {
      const cached = getCachedData(loc.lat, loc.lon);
      if (cached) {
        setHourlyData(cached.hourlyData);
        setDailyData(cached.dailyData);
        setLastUpdated(cached.timestamp);
        setLoading(false);
        return;
      }
    }

    try {
      const { ensemble, regular } = await fetchWeatherData(loc.lat, loc.lon);
      const hourly = buildHourlyData(ensemble.hourly, regular.hourly);
      const daily = buildDailyData(hourly, regular.daily, ensemble.hourly);

      setHourlyData(hourly);
      setDailyData(daily);
      setLastUpdated(Date.now());
      setCachedData(loc.lat, loc.lon, { hourlyData: hourly, dailyData: daily });
    } catch (err) {
      setError(err.message || 'Failed to load weather data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWeather(location);
  }, [location, loadWeather]);

  function handleLocationSelect(loc) {
    setLocation(loc);
    saveLocation(loc);
    setShowSearch(false);
  }

  // Find current hour for inline summary
  const currentHour = hourlyData ? (() => {
    const now = new Date();
    let closest = hourlyData[0];
    let minDiff = Infinity;
    for (const h of hourlyData) {
      const diff = Math.abs(new Date(h.time) - now);
      if (diff < minDiff) { minDiff = diff; closest = h; }
    }
    return closest;
  })() : null;

  // Get 48 hours from now
  const hourly48 = hourlyData
    ? hourlyData.filter((h) => {
        const t = new Date(h.time);
        const now = new Date();
        return t >= new Date(now.getTime() - 30 * 60 * 1000) && t <= new Date(now.getTime() + 48 * 60 * 60 * 1000);
      })
    : [];

  return (
    <div style={styles.page}>
      <PageHeader
        title="Weather Forecast"
        subtitle="Hourly and 14-day forecast with uncertainty ranges from ensemble models."
      />

      {/* Location bar with inline current conditions */}
      <div style={styles.locationBar}>
        {showSearch ? (
          <>
            <LocationSearch
              onSelect={handleLocationSelect}
              onClose={() => setShowSearch(false)}
            />
            <button style={styles.smallBtn} onClick={() => setShowSearch(false)}>Cancel</button>
          </>
        ) : (
          <>
            <span style={styles.locationName}>{location.name}</span>
            {!loading && !error && currentHour && (
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem', color: 'var(--color-text-muted)' }}>
                <span style={{ fontSize: '1.2rem' }}>{getWeatherInfo(currentHour.weatherCode).emoji}</span>
                <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>{formatTemp(currentHour.temp)}</span>
                <span>Feels {formatTemp(currentHour.feelsLike)}</span>
                <span>{Math.round(currentHour.wind)} km/h</span>
                {currentHour.precipProb != null && currentHour.precipProb > 0 && <span>{currentHour.precipProb}%</span>}
              </span>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {lastUpdated && <span style={styles.updatedText}>Updated {timeAgo(lastUpdated)}</span>}
              <button style={styles.smallBtn} onClick={() => setShowSearch(true)}>Change</button>
              <button style={styles.smallBtn} onClick={() => loadWeather(location, true)}>Refresh</button>
            </span>
          </>
        )}
      </div>

      {/* Loading / Error */}
      {loading && (
        <p style={{ color: 'var(--color-text-muted)' }}>Loading forecast...</p>
      )}

      {error && (
        <div style={{
          background: 'var(--color-surface)',
          border: '1px solid #c0392b',
          borderRadius: '8px',
          padding: '1rem 1.25rem',
          color: '#c0392b',
          fontSize: '0.9rem',
          marginBottom: '1.5rem',
        }}>
          {error}
        </div>
      )}

      {!loading && !error && hourlyData && (
        <>
          <div style={styles.tabs}>
            <button style={styles.tab(activeTab === 'hourly')} onClick={() => setActiveTab('hourly')}>
              48-Hour Forecast
            </button>
            <button style={styles.tab(activeTab === 'daily')} onClick={() => setActiveTab('daily')}>
              14-Day Outlook
            </button>
          </div>

          {activeTab === 'hourly' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {hourly48.map((h) => (
                <HourlyCard key={h.time} hour={h} />
              ))}
            </div>
          )}

          {activeTab === 'daily' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {dailyData.map((d) => (
                <DailyCard key={d.date} day={d} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
