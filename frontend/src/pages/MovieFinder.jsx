import { useState, useEffect, useRef, useCallback } from 'react';
import PageHeader from '../components/PageHeader';
import TagPill from '../components/TagPill';
import EmptyState from '../components/EmptyState';

// ─── TMDB Config ────────────────────────────────────────────────────────────

const API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';

async function tmdbFetch(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_key', API_KEY);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, String(v));
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${res.statusText}`);
  return res.json();
}

// ─── Mood Mapping ───────────────────────────────────────────────────────────

const MOODS = [
  { label: 'Date Night', genres: [10749, 35], sort: 'vote_average.desc', minVotes: 200 },
  { label: 'Something Light', genres: [35, 10751], sort: 'popularity.desc' },
  { label: 'Thriller Night', genres: [53, 80], sort: 'vote_average.desc', minVotes: 150 },
  { label: 'Mind-Bending', genres: [878, 9648], sort: 'vote_average.desc', minVotes: 100 },
  { label: 'Feel Good', genres: [35, 10402], sort: 'popularity.desc' },
  { label: 'Edge of Your Seat', genres: [28, 53], sort: 'popularity.desc' },
  { label: 'Epic Adventure', genres: [12, 14], sort: 'popularity.desc' },
  { label: 'Scare Me', genres: [27], sort: 'vote_average.desc', minVotes: 100 },
  { label: 'Learn Something', genres: [99], sort: 'vote_average.desc', minVotes: 50 },
  { label: 'Nostalgic', genres: [10751, 18], sort: 'vote_average.desc', minVotes: 200, maxYear: 2005 },
  { label: 'Tearjerker', genres: [18, 10749], sort: 'vote_average.desc', minVotes: 200 },
  { label: 'Laugh Out Loud', genres: [35], sort: 'vote_average.desc', minVotes: 500 },
  { label: 'Visually Stunning', genres: [878, 14, 12], sort: 'vote_average.desc', minVotes: 300 },
  { label: 'Based on True Events', genres: [36, 18], sort: 'vote_average.desc', minVotes: 100 },
  { label: 'Animated', genres: [16], sort: 'popularity.desc' },
  { label: 'World Cinema', genres: [18], sort: 'vote_average.desc', minVotes: 200, language: 'exclude_en' },
  { label: 'Cult Classic', genres: [878, 27, 53], sort: 'vote_average.desc', minVotes: 100, maxYear: 2000 },
  { label: 'Heist & Crime', genres: [80, 53], sort: 'vote_average.desc', minVotes: 150 },
];

// ─── Genre List (TMDB IDs) ─────────────────────────────────────────────────

const GENRES = [
  { id: 28, name: 'Action' },
  { id: 12, name: 'Adventure' },
  { id: 16, name: 'Animation' },
  { id: 35, name: 'Comedy' },
  { id: 80, name: 'Crime' },
  { id: 99, name: 'Documentary' },
  { id: 18, name: 'Drama' },
  { id: 10751, name: 'Family' },
  { id: 14, name: 'Fantasy' },
  { id: 36, name: 'History' },
  { id: 27, name: 'Horror' },
  { id: 10402, name: 'Music' },
  { id: 9648, name: 'Mystery' },
  { id: 10749, name: 'Romance' },
  { id: 878, name: 'Sci-Fi' },
  { id: 53, name: 'Thriller' },
  { id: 10752, name: 'War' },
  { id: 37, name: 'Western' },
];

// ─── Algorithm ──────────────────────────────────────────────────────────────

async function discoverMultiStrategy(genreIds, extraParams = {}) {
  const genreStr = genreIds.join(',');
  const currentYear = new Date().getFullYear();
  const base = { with_genres: genreStr, include_adult: false, ...extraParams };
  const hasMaxYear = !!base['primary_release_date.lte'];

  // Strategy 1: All-time best (high rating, very high vote count)
  const acclaimed = tmdbFetch('/discover/movie', {
    ...base,
    sort_by: 'vote_average.desc',
    'vote_count.gte': 1000,
    page: 1 + Math.floor(Math.random() * 2),
  });

  // Strategy 2: Popular (well-known movies)
  const popular = tmdbFetch('/discover/movie', {
    ...base,
    sort_by: 'popularity.desc',
    'vote_count.gte': 500,
    page: 1,
  });

  const fetches = [acclaimed, popular];

  if (!hasMaxYear) {
    // Strategy 3: Recent acclaimed (last 5 years, well-rated)
    fetches.push(tmdbFetch('/discover/movie', {
      ...base,
      sort_by: 'vote_average.desc',
      'vote_count.gte': 200,
      'primary_release_date.gte': `${currentYear - 5}-01-01`,
      page: 1,
    }));

    // Strategy 4: Recent popular (last 3 years)
    fetches.push(tmdbFetch('/discover/movie', {
      ...base,
      sort_by: 'popularity.desc',
      'vote_count.gte': 100,
      'primary_release_date.gte': `${currentYear - 3}-01-01`,
      page: 1,
    }));

    // Strategy 5: Very recent (last year, lower threshold to catch new releases)
    fetches.push(tmdbFetch('/discover/movie', {
      ...base,
      sort_by: 'popularity.desc',
      'vote_count.gte': 50,
      'primary_release_date.gte': `${currentYear - 1}-01-01`,
      page: 1,
    }));
  }

  const results = await Promise.all(fetches);
  return dedup(results.flatMap(d => d.results || []));
}

async function discoverByMood(mood) {
  const extra = {};
  if (mood.maxYear) extra['primary_release_date.lte'] = `${mood.maxYear}-12-31`;
  if (mood.language === 'exclude_en') extra.with_original_language = 'fr|es|ko|ja|de|it|pt|zh|hi|sv';
  return discoverMultiStrategy(mood.genres, extra);
}

async function discoverByGenres(genreIds) {
  return discoverMultiStrategy(genreIds);
}

async function getRecommendations(movieId) {
  const data = await tmdbFetch(`/movie/${movieId}/recommendations`);
  return data.results || [];
}

async function getTrending() {
  const data = await tmdbFetch('/trending/movie/week');
  return data.results || [];
}

function dedup(movies) {
  const seen = new Set();
  return movies.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

async function searchByDescription(description) {
  // Try keyword-based discovery + direct search
  const results = [];

  // Direct title/overview search
  const searchData = await tmdbFetch('/search/movie', {
    query: description, include_adult: false,
  });
  results.push(...(searchData.results || []));

  // Search for TMDB keywords to use in discover
  const words = description.split(/\s+/).filter(w => w.length > 3);
  const keyPhrase = words.slice(0, 3).join(' ');
  if (keyPhrase) {
    try {
      const kwData = await tmdbFetch('/search/keyword', { query: keyPhrase });
      const kwIds = (kwData.results || []).slice(0, 3).map(k => k.id);
      if (kwIds.length) {
        const discData = await tmdbFetch('/discover/movie', {
          with_keywords: kwIds.join('|'),
          sort_by: 'vote_average.desc',
          'vote_count.gte': 50,
          include_adult: false,
        });
        results.push(...(discData.results || []));
      }
    } catch { /* keyword search is best-effort */ }
  }

  return results;
}

async function generateMovies({ mood, selectedGenres, description, excludeIds }) {
  const exclude = new Set(excludeIds || []);
  let results = [];

  if (mood) {
    const discovered = await discoverByMood(mood);
    results.push(...discovered);
  }

  if (selectedGenres?.length) {
    const discovered = await discoverByGenres(selectedGenres);
    results.push(...discovered);
  }

  if (description?.trim()) {
    const descResults = await searchByDescription(description);
    results.push(...descResults);
  }

  if (!mood && !selectedGenres?.length && !description?.trim()) {
    results = await getTrending();
  }

  return dedup(results).filter(m => !exclude.has(m.id) && m.poster_path);
}

async function refineMovies({ liked, disliked, mood, selectedGenres, description, seen }) {
  const dislikedGenres = {};
  disliked.forEach(m => {
    (m.genre_ids || []).forEach(g => {
      dislikedGenres[g] = (dislikedGenres[g] || 0) + 1;
    });
  });
  const heavyDislikedGenres = new Set(
    Object.entries(dislikedGenres).filter(([, c]) => c >= 2).map(([g]) => Number(g))
  );

  let results = [];

  if (liked.length) {
    const recPromises = liked.map(m => getRecommendations(m.id));
    const recResults = await Promise.all(recPromises);
    recResults.forEach(recs => results.push(...recs));
  }

  if (mood) {
    const discovered = await discoverByMood(mood);
    results.push(...discovered);
  }

  if (selectedGenres?.length) {
    const discovered = await discoverByGenres(selectedGenres);
    results.push(...discovered);
  }

  if (description?.trim()) {
    const descResults = await searchByDescription(description);
    results.push(...descResults);
  }

  if (!results.length) {
    results = await getTrending();
  }

  const excludeIds = new Set(seen);
  return dedup(results)
    .filter(m => {
      if (excludeIds.has(m.id)) return false;
      if (!m.poster_path) return false;
      const genres = m.genre_ids || [];
      const heavyCount = genres.filter(g => heavyDislikedGenres.has(g)).length;
      if (heavyCount === genres.length && genres.length > 0) return false;
      return true;
    });
}

// ─── Watch Providers ────────────────────────────────────────────────────────

async function fetchProviders(movieId) {
  const data = await tmdbFetch(`/movie/${movieId}/watch/providers`);
  return data.results?.CA || null;
}

async function batchFetchProviders(movieIds, cache, onUpdate) {
  const toFetch = movieIds.filter(id => !cache.current.has(id));
  const chunks = [];
  for (let i = 0; i < toFetch.length; i += 5) {
    chunks.push(toFetch.slice(i, i + 5));
  }
  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async id => {
        try {
          const p = await fetchProviders(id);
          return [id, p];
        } catch {
          return [id, null];
        }
      })
    );
    results.forEach(([id, p]) => cache.current.set(id, p));
    onUpdate();
  }
}

// ─── Trailers ───────────────────────────────────────────────────────────────

async function fetchTrailer(movieId) {
  const data = await tmdbFetch(`/movie/${movieId}/videos`);
  const videos = data.results || [];
  const trailer = videos.find(v => v.site === 'YouTube' && v.type === 'Trailer')
    || videos.find(v => v.site === 'YouTube');
  return trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null;
}

async function batchFetchTrailers(movieIds, cache, onUpdate) {
  const toFetch = movieIds.filter(id => !cache.current.has(id));
  const chunks = [];
  for (let i = 0; i < toFetch.length; i += 5) {
    chunks.push(toFetch.slice(i, i + 5));
  }
  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async id => {
        try {
          const url = await fetchTrailer(id);
          return [id, url];
        } catch {
          return [id, null];
        }
      })
    );
    results.forEach(([id, url]) => cache.current.set(id, url));
    onUpdate();
  }
}

// ─── OMDB Ratings ───────────────────────────────────────────────────────────

const OMDB_KEY = import.meta.env.VITE_OMDB_API_KEY || '';

async function fetchOMDBRatings(title, year) {
  const params = new URLSearchParams({ apikey: OMDB_KEY, t: title, type: 'movie' });
  if (year) params.set('y', year);
  const res = await fetch(`https://www.omdbapi.com/?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.Response === 'False') return null;
  const ratings = {};
  if (data.imdbRating && data.imdbRating !== 'N/A') ratings.imdb = data.imdbRating;
  (data.Ratings || []).forEach(r => {
    if (r.Source === 'Rotten Tomatoes') ratings.rt = r.Value;
    if (r.Source === 'Metacritic') ratings.mc = r.Value;
  });
  return Object.keys(ratings).length ? ratings : null;
}

async function batchFetchRatings(movies, cache, onUpdate) {
  const toFetch = movies.filter(m => !cache.current.has(m.id));
  const chunks = [];
  for (let i = 0; i < toFetch.length; i += 5) {
    chunks.push(toFetch.slice(i, i + 5));
  }
  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async m => {
        try {
          const year = m.release_date?.slice(0, 4);
          const ratings = await fetchOMDBRatings(m.title, year);
          return [m.id, ratings];
        } catch {
          return [m.id, null];
        }
      })
    );
    results.forEach(([id, r]) => cache.current.set(id, r));
    onUpdate();
  }
}

// ─── Scoring ────────────────────────────────────────────────────────────────

function averageScore(ratings) {
  if (!ratings) return 0;
  const scores = [];
  if (ratings.imdb) scores.push(parseFloat(ratings.imdb)); // out of 10
  if (ratings.rt) scores.push(parseFloat(ratings.rt) / 10); // "93%" → 9.3
  if (ratings.mc) {
    const parts = ratings.mc.split('/');
    scores.push(parseFloat(parts[0]) / 10); // "74/100" → 7.4
  }
  if (!scores.length) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// Genre fit: ratio of a movie's genres that match the target genres.
// A pure comedy (genre_ids=[35]) matching target [35] scores 1.0.
// A comedy-drama ([35,18]) matching target [35] scores 0.5.
function genreFitScore(movie, targetGenreIds) {
  if (!targetGenreIds?.length) return 1; // no filter = no penalty
  const movieGenres = movie.genre_ids || [];
  if (!movieGenres.length) return 0;
  const target = new Set(targetGenreIds);
  const matching = movieGenres.filter(g => target.has(g)).length;
  return matching / movieGenres.length;
}

// Recency boost: movies from the last few years get a bump.
// 2026 → 1.15, 2024 → 1.12, 2020 → 1.06, 2010 → ~1.0, older → 1.0
function recencyBoost(movie) {
  const year = parseInt(movie.release_date?.slice(0, 4));
  if (!year) return 1;
  const age = new Date().getFullYear() - year;
  if (age <= 0) return 1.15;
  if (age >= 20) return 1;
  return 1 + 0.15 * ((20 - age) / 20);
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const s = {
  container: { maxWidth: 960, margin: '0 auto', padding: '2rem 1rem' },
  section: { marginBottom: '2rem' },
  label: {
    fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', marginBottom: '0.5rem', display: 'block',
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  moodRow: {
    display: 'flex', flexWrap: 'wrap', gap: '0.5rem',
  },
  textarea: {
    width: '100%', padding: '0.75rem 1rem', minHeight: 80, resize: 'vertical',
    border: '1px solid var(--color-border)', borderRadius: '8px',
    fontFamily: 'var(--font-body)', fontSize: '1rem',
    background: 'var(--color-surface)', color: 'var(--color-text)', outline: 'none',
    boxSizing: 'border-box',
  },
  btn: (disabled) => ({
    padding: '0.75rem 2rem', borderRadius: '8px', border: 'none',
    background: disabled ? 'var(--color-border)' : 'var(--color-accent)',
    color: disabled ? 'var(--color-text-muted)' : '#fff',
    fontFamily: 'var(--font-body)', fontSize: '1rem', fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background 0.15s, transform 0.1s',
  }),
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: '1.25rem',
  },
  card: (feedbackState) => ({
    background: 'var(--color-surface)',
    border: `1px solid ${feedbackState === 'liked' ? '#22c55e' : feedbackState === 'disliked' ? '#ef4444' : 'var(--color-border)'}`,
    borderLeft: `4px solid ${feedbackState === 'liked' ? '#22c55e' : feedbackState === 'disliked' ? '#ef4444' : 'var(--color-accent)'}`,
    borderRadius: 10, overflow: 'hidden',
    transition: 'transform 0.15s, box-shadow 0.15s',
  }),
  poster: {
    width: '100%', aspectRatio: '2/3', objectFit: 'cover', display: 'block',
    background: 'var(--color-border)',
  },
  cardBody: { padding: '0.75rem' },
  cardTitle: {
    fontFamily: 'var(--font-display)', fontSize: '0.95rem', fontWeight: 700,
    color: 'var(--color-text)', margin: 0, lineHeight: 1.2,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  cardMeta: {
    display: 'flex', alignItems: 'center', gap: '0.4rem',
    marginTop: '0.35rem', fontSize: '0.8rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)',
  },
  ratingsRow: {
    display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.4rem',
    alignItems: 'center',
  },
  ratingPill: {
    display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
    padding: '1px 5px', borderRadius: 4, fontSize: '0.65rem', fontWeight: 600,
    fontFamily: 'var(--font-body)', lineHeight: 1.4,
  },
  genreRow: {
    display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.4rem',
  },
  genrePill: {
    fontSize: '0.65rem', padding: '1px 6px', borderRadius: '9999px',
    background: 'var(--color-bg)', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', border: '1px solid var(--color-border)',
  },
  providerRow: {
    display: 'flex', alignItems: 'center', gap: '0.25rem',
    marginTop: '0.4rem', minHeight: 24,
  },
  providerLogo: {
    width: 24, height: 24, borderRadius: 6, objectFit: 'cover',
  },
  providerNA: {
    fontSize: '0.7rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', fontStyle: 'italic',
  },
  trailerLink: {
    display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
    fontSize: '0.75rem', fontFamily: 'var(--font-body)', fontWeight: 600,
    color: '#e00', textDecoration: 'none', marginTop: '0.4rem',
    transition: 'opacity 0.15s',
  },
  feedbackBtns: {
    display: 'flex', justifyContent: 'center', gap: '0.5rem',
    marginTop: '0.5rem', paddingTop: '0.5rem',
    borderTop: '1px solid var(--color-border)',
  },
  fbBtn: (active, color) => ({
    background: 'none', border: `2px solid ${color}`, cursor: 'pointer',
    padding: '6px 16px', fontSize: 22, fontWeight: 700, lineHeight: 1,
    borderRadius: 8, color, opacity: active ? 1 : 0.3,
    transition: 'opacity 0.15s, transform 0.1s',
  }),
  refineBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: '1rem', margin: '1.5rem 0',
  },
  attribution: {
    textAlign: 'center', fontSize: '0.75rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', marginTop: '2rem',
  },
  loading: {
    textAlign: 'center', padding: '3rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)',
  },
};

// ─── Sub-components ─────────────────────────────────────────────────────────

function MoodSelector({ selected, onSelect }) {
  return (
    <div style={s.moodRow}>
      {MOODS.map(m => (
        <TagPill
          key={m.label}
          label={m.label}
          active={selected?.label === m.label}
          onClick={() => onSelect(selected?.label === m.label ? null : m)}
        />
      ))}
    </div>
  );
}

function GenreSelector({ selected, onToggle }) {
  return (
    <div style={s.moodRow}>
      {GENRES.map(g => (
        <TagPill
          key={g.id}
          label={g.name}
          active={selected.includes(g.id)}
          onClick={() => onToggle(g.id)}
        />
      ))}
    </div>
  );
}

function Ratings({ ratings }) {
  if (!ratings) return null;
  const items = [];
  if (ratings.imdb) items.push({ label: 'IMDb', value: ratings.imdb, bg: '#f5c518', color: '#000' });
  if (ratings.rt) items.push({ label: 'RT', value: ratings.rt, bg: '#fa320a', color: '#fff' });
  if (ratings.mc) items.push({ label: 'MC', value: ratings.mc, bg: '#ffcc34', color: '#000' });
  if (!items.length) return null;
  return (
    <div style={s.ratingsRow}>
      {items.map(r => (
        <span key={r.label} style={{ ...s.ratingPill, background: r.bg, color: r.color }}>
          {r.label} {r.value}
        </span>
      ))}
    </div>
  );
}

function WatchProviders({ providers }) {
  if (providers === undefined) {
    return <div style={s.providerRow}><span style={s.providerNA}>Loading...</span></div>;
  }
  if (!providers) {
    return <div style={s.providerRow}><span style={s.providerNA}>Not available in Canada</span></div>;
  }
  const flat = providers.flatrate || [];
  const rent = providers.rent || [];
  const all = [...flat, ...rent].slice(0, 5);
  if (!all.length) {
    return <div style={s.providerRow}><span style={s.providerNA}>Not available in Canada</span></div>;
  }
  return (
    <div style={s.providerRow}>
      {all.map(p => (
        <img
          key={p.provider_id}
          src={`${IMG}w92${p.logo_path}`}
          alt={p.provider_name}
          title={p.provider_name}
          style={s.providerLogo}
        />
      ))}
    </div>
  );
}

function MovieCard({ movie, genreMap, providers, trailerUrl, ratings, feedbackState, onLike, onDislike }) {
  const year = movie.release_date?.slice(0, 4);
  const genres = (movie.genre_ids || []).slice(0, 3).map(g => genreMap[g]).filter(Boolean);

  return (
    <div
      style={s.card(feedbackState)}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      {movie.poster_path
        ? <img src={`${IMG}w342${movie.poster_path}`} alt={movie.title} style={s.poster} />
        : <div style={{ ...s.poster, background: 'var(--color-border)' }} />}
      <div style={s.cardBody}>
        <h3 style={s.cardTitle}>{movie.title}</h3>
        <div style={s.cardMeta}>
          {year && <span>{year}</span>}
        </div>
        <Ratings ratings={ratings} />
        {genres.length > 0 && (
          <div style={s.genreRow}>
            {genres.map(g => <span key={g} style={s.genrePill}>{g}</span>)}
          </div>
        )}
        <WatchProviders providers={providers} />
        {trailerUrl && (
          <a href={trailerUrl} target="_blank" rel="noopener noreferrer" style={s.trailerLink}
            onMouseEnter={e => e.currentTarget.style.opacity = 0.7}
            onMouseLeave={e => e.currentTarget.style.opacity = 1}>
            &#9654; Trailer
          </a>
        )}
        <div style={s.feedbackBtns}>
          <button
            style={s.fbBtn(feedbackState === 'liked', '#22c55e')}
            title="More like this"
            onClick={() => onLike(movie)}
          >+</button>
          <button
            style={s.fbBtn(feedbackState === 'disliked', '#ef4444')}
            title="Less like this"
            onClick={() => onDislike(movie)}
          >&minus;</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function MovieFinder() {
  // Genre map
  const [genreMap, setGenreMap] = useState({});

  // Inputs
  const [selectedMood, setSelectedMood] = useState(null);
  const [selectedGenres, setSelectedGenres] = useState([]);
  const [description, setDescription] = useState('');

  // Results
  const [allMovies, setAllMovies] = useState([]); // full result set
  const [visibleCount, setVisibleCount] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);

  // Feedback (session only)
  const [liked, setLiked] = useState(new Map()); // id → movie obj
  const [disliked, setDisliked] = useState(new Map()); // id → movie obj
  const [seen, setSeen] = useState(new Set()); // all shown IDs

  // Provider, trailer, and ratings caches
  const providerCache = useRef(new Map());
  const trailerCache = useRef(new Map());
  const ratingsCache = useRef(new Map());
  const [, forceUpdate] = useState(0);

  // Fetch genre list on mount
  useEffect(() => {
    tmdbFetch('/genre/movie/list').then(data => {
      const map = {};
      (data.genres || []).forEach(g => { map[g.id] = g.name; });
      setGenreMap(map);
    }).catch(() => {});
  }, []);

  // Fetch providers, trailers, and ratings when results change
  useEffect(() => {
    if (!allMovies.length) return;
    const ids = allMovies.map(m => m.id);
    const update = () => forceUpdate(n => n + 1);
    batchFetchProviders(ids, providerCache, update);
    batchFetchTrailers(ids, trailerCache, update);
    batchFetchRatings(allMovies, ratingsCache, update);
  }, [allMovies]);

  // Combine mood + selected genre IDs for genre-fit scoring
  const targetGenreIds = [
    ...(selectedMood?.genres || []),
    ...selectedGenres,
  ];

  // Sort by combined score: rating * genre fit * recency
  const sortedMovies = [...allMovies].sort((a, b) => {
    const ra = averageScore(ratingsCache.current.get(a.id));
    const rb = averageScore(ratingsCache.current.get(b.id));
    const ga = 0.85 + 0.15 * genreFitScore(a, targetGenreIds);
    const gb = 0.85 + 0.15 * genreFitScore(b, targetGenreIds);
    return (rb * gb * recencyBoost(b)) - (ra * ga * recencyBoost(a));
  });
  const movies = sortedMovies.slice(0, visibleCount);
  const hasMore = visibleCount < allMovies.length;

  function toggleGenre(id) {
    setSelectedGenres(prev =>
      prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]
    );
  }

  const handleFind = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await generateMovies({
        mood: selectedMood,
        selectedGenres,
        description,
        excludeIds: [...seen],
      });
      setAllMovies(results);
      setVisibleCount(20);
      setSeen(prev => {
        const next = new Set(prev);
        results.forEach(m => next.add(m.id));
        return next;
      });
      setHasSearched(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [selectedMood, selectedGenres, description, seen]);

  const handleRefine = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await refineMovies({
        liked: [...liked.values()],
        disliked: [...disliked.values()],
        mood: selectedMood,
        selectedGenres,
        description,
        seen: [...seen],
      });
      setAllMovies(results);
      setVisibleCount(20);
      setSeen(prev => {
        const next = new Set(prev);
        results.forEach(m => next.add(m.id));
        return next;
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [liked, disliked, selectedMood, selectedGenres, description, seen]);

  function handleLike(movie) {
    setLiked(prev => {
      const next = new Map(prev);
      if (next.has(movie.id)) next.delete(movie.id);
      else next.set(movie.id, movie);
      return next;
    });
    setDisliked(prev => {
      const next = new Map(prev);
      next.delete(movie.id);
      return next;
    });
  }

  function handleDislike(movie) {
    setDisliked(prev => {
      const next = new Map(prev);
      if (next.has(movie.id)) next.delete(movie.id);
      else next.set(movie.id, movie);
      return next;
    });
    setLiked(prev => {
      const next = new Map(prev);
      next.delete(movie.id);
      return next;
    });
  }

  function getFeedback(id) {
    if (liked.has(id)) return 'liked';
    if (disliked.has(id)) return 'disliked';
    return null;
  }

  const hasFeedback = liked.size > 0 || disliked.size > 0;

  return (
    <div style={s.container}>
      <PageHeader
        title="Movie Finder"
        subtitle="Pick a mood, choose genres, or describe what you want to watch."
      />

      {/* Mood selector */}
      <div style={s.section}>
        <label style={s.label}>Mood</label>
        <MoodSelector selected={selectedMood} onSelect={setSelectedMood} />
      </div>

      {/* Genre selector */}
      <div style={s.section}>
        <label style={s.label}>Genres</label>
        <GenreSelector selected={selectedGenres} onToggle={toggleGenre} />
      </div>

      {/* Description */}
      <div style={s.section}>
        <label style={s.label}>Describe what you want to watch</label>
        <textarea
          style={s.textarea}
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="e.g. a heist movie with a twist ending, something like Ocean's Eleven..."
        />
      </div>

      {/* Find button */}
      <div style={{ ...s.section, textAlign: 'center' }}>
        <button
          style={s.btn(loading)}
          disabled={loading}
          onClick={handleFind}
        >
          {loading ? 'Finding...' : 'Find Movies'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ textAlign: 'center', color: '#ef4444', fontFamily: 'var(--font-body)', marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {/* Refine bar */}
      {hasSearched && hasFeedback && !loading && (
        <div style={s.refineBar}>
          <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-body)' }}>
            {liked.size} liked, {disliked.size} disliked
          </span>
          <button style={s.btn(false)} onClick={handleRefine}>
            Refine
          </button>
        </div>
      )}

      {/* Results */}
      {loading && <div style={s.loading}>Searching for movies...</div>}

      {!loading && hasSearched && allMovies.length === 0 && (
        <EmptyState message="No movies found. Try a different mood, genre, or description." />
      )}

      {!loading && movies.length > 0 && (
        <>
          <div style={s.grid}>
            {movies.map(m => (
              <MovieCard
                key={m.id}
                movie={m}
                genreMap={genreMap}
                providers={providerCache.current.get(m.id)}
                trailerUrl={trailerCache.current.get(m.id)}
                ratings={ratingsCache.current.get(m.id)}
                feedbackState={getFeedback(m.id)}
                onLike={handleLike}
                onDislike={handleDislike}
              />
            ))}
          </div>
          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
              <button
                style={s.btn(false)}
                onClick={() => setVisibleCount(n => n + 20)}
              >
                Load More
              </button>
            </div>
          )}
          <p style={s.attribution}>
            Movie data from TMDB. Streaming data from JustWatch.
          </p>
        </>
      )}
    </div>
  );
}
