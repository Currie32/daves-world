import { useState, useCallback, useEffect, useRef } from 'react';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';

// ─── Google Books API ─────────────────────────────────────────────────────────

const GB_KEY = import.meta.env.VITE_GOOGLE_BOOKS_API_KEY || '';
const GB_BASE = 'https://www.googleapis.com/books/v1/volumes';

function normalizeVolume(vol) {
  const info = vol.volumeInfo || {};
  const cover = info.imageLinks?.thumbnail
    ?.replace('http:', 'https:')
    ?.replace('&edge=curl', '') || null;
  return {
    id: vol.id,
    title: info.title || 'Unknown Title',
    subtitle: info.subtitle || '',
    authors: info.authors || [],
    year: info.publishedDate?.slice(0, 4) || null,
    cover,
    categories: info.categories || [],
    rating: info.averageRating || null,
    ratingsCount: info.ratingsCount || 0,
    pageCount: info.pageCount || 0,
    language: info.language || '',
    infoLink: (info.infoLink || `https://books.google.com/books?id=${vol.id}`).replace('http:', 'https:'),
    description: info.description || '',
  };
}

async function gbSearch(params = {}) {
  const url = new URL(GB_BASE);
  if (GB_KEY) url.searchParams.set('key', GB_KEY);
  url.searchParams.set('maxResults', '40');
  url.searchParams.set('printType', 'books');
  url.searchParams.set('langRestrict', 'en');
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, String(v));
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Books ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(normalizeVolume).filter(b => b.cover && b.language === 'en');
}

async function searchForSeed(query) {
  return gbSearch({ q: query, maxResults: '8' });
}

// Fetch the full volume record — search results only return one top-level category,
// but the individual volume endpoint returns all BISAC subcategories + full description.
async function enrichBook(book) {
  try {
    const url = new URL(`${GB_BASE}/${book.id}`);
    if (GB_KEY) url.searchParams.set('key', GB_KEY);
    const res = await fetch(url);
    if (!res.ok) return book;
    return normalizeVolume(await res.json());
  } catch {
    return book;
  }
}

// ─── Discovery ────────────────────────────────────────────────────────────────

// "Business & Economics / Project Management" → "Project Management"
function leafCategory(cat) {
  const generic = new Set(['general','miscellaneous','other','nonfiction','fiction','various','social aspects','technology studies']);
  const parts = cat.split('/').map(s => s.trim());
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!generic.has(parts[i].toLowerCase())) return parts[i];
  }
  return parts[parts.length - 1];
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/:.+$/, '').replace(/[^\w\s]/g, '').trim();
}

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','is','are','was','were','be','been','have','has','had','about','into',
  'that','this','how','what','when','why','which','who','its','their','our',
  'your','his','her','we','you','they','not','so','if','as','up','out','can',
  'get','all','any','both','each','also','more','very','just','now','new','one',
  'two','three','book','author','read','story','world','life','time','work',
  'make','first','take','know','think','people','after','before','where','here',
  'there','then','some','such','even','many','while','every','other','never',
  'only','well','come','back','over','most','through','would','could','should',
  'being','between','under','these','those','much','still','than',
  'sunday','times','bestseller','groundbreaking','brilliant','riveting',
  'extraordinary','compelling','stunning','powerful','important','essential',
  'fascinating','remarkable','acclaimed','award','winner','prize','praise',
  'readers','pages','instant','national','debut','offers','shows','tells',
  'explores','argues','leading','brings','among','gives','draws','takes',
  'based','years','since','without','against','really','whether','because',
  'inside','cover','york','best','selling','called','like','long','does',
  'look','help','turn','around','must','need','want','find','good','great',
]);

// Extract content words from text.
function tokenize(text) {
  return text.replace(/<[^>]+>/g, ' ').toLowerCase().replace(/[^\w\s]/g, ' ')
    .split(/\s+/).filter(w => w.length >= 4 && !STOP_WORDS.has(w));
}

// Extract unigrams and bigrams from text.
function extractNgrams(text) {
  const words = tokenize(text);
  const ngrams = [...words]; // unigrams
  for (let i = 0; i < words.length - 1; i++) {
    ngrams.push(`${words[i]} ${words[i + 1]}`); // bigrams
  }
  return ngrams;
}

// Build n-gram model from seed descriptions. Returns sorted array of { ngram, weight }.
// N-grams appearing in more seed books are weighted higher (document frequency).
function buildSeedNgrams(seeds) {
  const df = {};        // how many seeds contain this n-gram
  const totalTf = {};   // raw count across all seeds
  let total = 0;

  for (const seed of seeds) {
    const text = [seed.subtitle, seed.description].filter(Boolean).join(' ');
    const ngrams = extractNgrams(text);
    const unique = new Set(ngrams);
    for (const ng of unique) {
      df[ng] = (df[ng] || 0) + 1;
    }
    for (const ng of ngrams) {
      totalTf[ng] = (totalTf[ng] || 0) + 1;
      total++;
    }
  }

  const numSeeds = seeds.length;
  const scored = Object.entries(totalTf).map(([ng, count]) => {
    const isBigram = ng.includes(' ');
    const seedOverlap = df[ng] / numSeeds; // 1.0 = appears in every seed
    // Base weight from frequency, boosted by how many seeds share it
    const weight = (count / total) * (isBigram ? 2 : 1) * (1 + seedOverlap);
    return { ngram: ng, weight };
  });
  scored.sort((a, b) => b.weight - a.weight);
  return scored;
}

// Score a candidate book against the seed n-gram model.
function scoreBook(book, seedNgrams) {
  const text = [book.title, book.subtitle, book.description].filter(Boolean).join(' ');
  const bookNgrams = new Set(extractNgrams(text));
  let score = 0;
  let maxPossible = 0;
  for (const { ngram, weight } of seedNgrams) {
    maxPossible += weight;
    if (bookNgrams.has(ngram)) score += weight;
  }
  return maxPossible > 0 ? score / maxPossible : 0;
}

// Deduplicate by title, score, sort, cap per author.
function dedupAndRank(books, exclude, seedTitles, seedNgrams) {
  const seedTitleSet = new Set(seedTitles.map(normalizeTitle));
  const bookMap = {};
  const titleMap = {};

  for (const b of books) {
    if (!b.id || exclude.has(b.id) || !b.cover || (b.language && b.language !== 'en')) continue;
    const nt = normalizeTitle(b.title);
    if (seedTitleSet.has(nt)) continue;
    if (titleMap[nt]) {
      // keep the one with better metadata
      const existingId = titleMap[nt];
      if ((b.ratingsCount || 0) > (bookMap[existingId].ratingsCount || 0)) {
        bookMap[existingId] = b;
      }
    } else {
      titleMap[nt] = b.id;
      bookMap[b.id] = b;
    }
  }

  const currentYear = new Date().getFullYear();

  const scored = Object.values(bookMap).map(b => {
    const topic = scoreBook(b, seedNgrams);

    // Popularity: log-scaled ratings count (0–1), nudged by average rating
    const rc = b.ratingsCount || 0;
    const popularity = rc > 0 ? Math.min(Math.log10(rc) / 5, 1) : 0; // log10(100k)=5 → 1.0
    const ratingBonus = b.rating ? (b.rating - 3) / 5 : 0; // 0 at 3★, 0.4 at 5★

    // Recency: linear decay, books from this year get full boost, 20+ years old get 0
    const year = parseInt(b.year) || 0;
    const recency = year > 0 ? Math.max(0, Math.min(1, (year - (currentYear - 20)) / 20)) : 0;

    // Composite: popularity + topic + recency
    const score = topic * 0.30 + (popularity + ratingBonus) * 0.50 + recency * 0.20;
    return { book: b, topic, popularity, ratingBonus, recency, score };
  });
  scored.sort((a, b) => b.score - a.score);

  console.log('[BookFinder] Ranked results:');
  scored.slice(0, 25).forEach(s => {
    console.log(`  score=${s.score.toFixed(3)} topic=${s.topic.toFixed(3)} pop=${s.popularity.toFixed(2)} rating=${s.ratingBonus.toFixed(2)} recency=${s.recency.toFixed(2)} | ${s.book.title} (${s.book.year || '?'}) by ${s.book.authors[0] || '?'}`);
  });

  // Cap at 2 per author; require some topic relevance
  const authorCount = {};
  return scored
    .filter(s => s.topic > 0)
    .map(s => s.book)
    .filter(b => {
      const author = b.authors[0] || '';
      authorCount[author] = (authorCount[author] || 0) + 1;
      return authorCount[author] <= 2;
    });
}

async function getRecommendations(seedBooks) {
  const seeds = await Promise.all(seedBooks.map(enrichBook));
  const exclude = new Set(seeds.map(b => b.id));
  const seedNgrams = buildSeedNgrams(seeds);

  // Use the top n-grams as Google Books search queries
  // Take the top bigrams first (more specific), then top unigrams
  const topBigrams = seedNgrams.filter(n => n.ngram.includes(' ')).slice(0, 8);
  const topUnigrams = seedNgrams.filter(n => !n.ngram.includes(' ')).slice(0, 6);
  const queries = [...topBigrams, ...topUnigrams].map(n => n.ngram);

  console.log('[BookFinder] Search queries:', queries);

  // Search Google Books with each n-gram query
  const searchResults = await Promise.all(
    queries.map(q => gbSearch({ q, maxResults: '20' }).catch(() => []))
  );
  const allBooks = searchResults.flat();

  return dedupAndRank(allBooks, exclude, seeds.map(b => b.title), seedNgrams);
}

async function refineRecommendations(seedBooks, liked, disliked, seen) {
  const seenIds = new Set([...seen, ...seedBooks.map(b => b.id)]);
  const seeds = await Promise.all(seedBooks.map(enrichBook));
  const enrichedLiked = await Promise.all(liked.map(enrichBook));
  const allPositive = [...seeds, ...enrichedLiked];

  const seedNgrams = buildSeedNgrams(allPositive);
  const topBigrams = seedNgrams.filter(n => n.ngram.includes(' ')).slice(0, 8);
  const topUnigrams = seedNgrams.filter(n => !n.ngram.includes(' ')).slice(0, 6);
  const queries = [...topBigrams, ...topUnigrams].map(n => n.ngram);

  const searchResults = await Promise.all(
    queries.map(q => gbSearch({ q, maxResults: '20' }).catch(() => []))
  );
  const allBooks = searchResults.flat();

  const dislikedCategories = new Set(disliked.flatMap(b => b.categories.map(leafCategory)));
  return dedupAndRank(allBooks, seenIds, allPositive.map(b => b.title), seedNgrams)
    .filter(b => {
      const bookCats = b.categories.map(leafCategory);
      return !bookCats.some(c => dislikedCategories.has(c));
    });
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = {
  container: { maxWidth: 960, margin: '0 auto', padding: '2rem 1rem' },
  section: { marginBottom: '2rem' },
  label: {
    fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', marginBottom: '0.5rem', display: 'block',
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  searchWrap: { position: 'relative' },
  searchInput: {
    width: '100%', padding: '0.75rem 1rem',
    border: '1px solid var(--color-border)', borderRadius: '8px',
    fontFamily: 'var(--font-body)', fontSize: '1rem',
    background: 'var(--color-surface)', color: 'var(--color-text)',
    outline: 'none', boxSizing: 'border-box',
  },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 100,
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)', borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.1)', overflow: 'hidden',
  },
  dropdownItem: {
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    width: '100%', padding: '0.6rem 1rem',
    background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)',
    cursor: 'pointer',
  },
  dropdownEmpty: {
    padding: '0.75rem 1rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', fontSize: '0.875rem',
  },
  seedList: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
  seedChip: {
    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.3rem 0.5rem 0.3rem 0.4rem',
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)', borderRadius: '6px',
    borderLeft: '3px solid var(--color-accent)',
  },
  seedCover: { width: 24, height: 36, objectFit: 'cover', borderRadius: 2, flexShrink: 0 },
  seedTitle: {
    fontFamily: 'var(--font-body)', fontSize: '0.85rem',
    color: 'var(--color-text)', maxWidth: 160,
    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
  },
  seedRemove: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--color-text-muted)', padding: '0 2px',
    fontSize: '1.1rem', lineHeight: 1, flexShrink: 0,
  },
  btn: (disabled) => ({
    padding: '0.75rem 2rem', borderRadius: '8px', border: 'none',
    background: disabled ? 'var(--color-border)' : 'var(--color-accent)',
    color: disabled ? 'var(--color-text-muted)' : '#fff',
    fontFamily: 'var(--font-body)', fontSize: '1rem', fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer', transition: 'background 0.15s',
  }),
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: '1.25rem',
  },
  card: (feedback) => ({
    background: 'var(--color-surface)',
    border: `1px solid ${feedback === 'liked' ? '#22c55e' : feedback === 'disliked' ? '#ef4444' : 'var(--color-border)'}`,
    borderLeft: `4px solid ${feedback === 'liked' ? '#22c55e' : feedback === 'disliked' ? '#ef4444' : 'var(--color-accent)'}`,
    borderRadius: 10, overflow: 'hidden',
    transition: 'transform 0.15s, box-shadow 0.15s',
  }),
  cover: {
    width: '100%', aspectRatio: '2/3', objectFit: 'cover', display: 'block',
    background: 'var(--color-border)',
  },
  cardBody: { padding: '0.65rem' },
  cardTitle: {
    fontFamily: 'var(--font-display)', fontSize: '0.9rem', fontWeight: 700,
    color: 'var(--color-text)', margin: 0, lineHeight: 1.2,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  cardAuthor: {
    fontSize: '0.78rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', marginTop: '0.3rem',
    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
  },
  metaRow: {
    display: 'flex', alignItems: 'center', gap: '0.3rem',
    marginTop: '0.3rem', fontSize: '0.75rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)',
  },
  categoryRow: { display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.3rem' },
  categoryPill: {
    fontSize: '0.65rem', padding: '1px 6px', borderRadius: '9999px',
    background: 'var(--color-bg)', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', border: '1px solid var(--color-border)',
  },
  descOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0, 0, 0, 0.85)', color: '#fff',
    padding: '0.5rem', fontSize: '0.7rem', lineHeight: 1.4,
    fontFamily: 'var(--font-body)', overflow: 'hidden',
    pointerEvents: 'none',
  },
  feedbackBtns: {
    display: 'flex', justifyContent: 'center', gap: '0.5rem',
    marginTop: '0.5rem', paddingTop: '0.5rem',
    borderTop: '1px solid var(--color-border)',
  },
  fbBtn: (active, color) => ({
    background: 'none', border: `2px solid ${color}`, cursor: 'pointer',
    padding: '6px 16px', fontSize: 22, fontWeight: 700, lineHeight: 1,
    borderRadius: 8, color, opacity: active ? 1 : 0.3, transition: 'opacity 0.15s',
  }),
  refineBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: '1rem', margin: '1.5rem 0',
  },
  loading: {
    textAlign: 'center', padding: '3rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)',
  },
  attribution: {
    textAlign: 'center', fontSize: '0.75rem', color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-body)', marginTop: '2rem',
  },
};

// ─── BookSearchInput ──────────────────────────────────────────────────────────

function BookSearchInput({ onAdd, excludeIds }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function handleInput(e) {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(timerRef.current);
    if (!val.trim()) {
      setResults([]);
      setShowDropdown(false);
      return;
    }
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const books = await searchForSeed(val);
        setResults(books.filter(b => !excludeIds.has(b.id)));
        setShowDropdown(true);
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  function handleSelect(book) {
    onAdd(book);
    setQuery('');
    setResults([]);
    setShowDropdown(false);
  }

  const showEmpty = showDropdown && query.trim() && !searching && results.length === 0;

  return (
    <div ref={wrapperRef} style={s.searchWrap}>
      <input
        type="text"
        value={query}
        onChange={handleInput}
        placeholder="Search for a book you love..."
        style={s.searchInput}
        onFocus={() => results.length > 0 && setShowDropdown(true)}
      />
      {(showDropdown && results.length > 0) || showEmpty ? (
        <div style={s.dropdown}>
          {results.map((b, i) => (
            <button
              key={b.id}
              style={{
                ...s.dropdownItem,
                borderBottom: i < results.length - 1 ? '1px solid var(--color-border)' : 'none',
              }}
              onClick={() => handleSelect(b)}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <img
                src={b.cover}
                alt={b.title}
                style={{ width: 32, height: 48, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }}
              />
              <div style={{ textAlign: 'left', minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-display)', fontSize: '0.9rem',
                  fontWeight: 600, color: 'var(--color-text)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {b.title}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-body)' }}>
                  {b.authors[0]}{b.year ? ` · ${b.year}` : ''}
                </div>
              </div>
            </button>
          ))}
          {showEmpty && <div style={s.dropdownEmpty}>No books found</div>}
        </div>
      ) : null}
    </div>
  );
}

// ─── SeedBookList ─────────────────────────────────────────────────────────────

function SeedBookList({ books, onRemove }) {
  if (!books.length) return null;
  return (
    <div style={s.seedList}>
      {books.map(b => (
        <div key={b.id} style={s.seedChip}>
          <img src={b.cover} alt={b.title} style={s.seedCover} />
          <span style={s.seedTitle}>{b.title}</span>
          <button style={s.seedRemove} onClick={() => onRemove(b.id)} title="Remove">×</button>
        </div>
      ))}
    </div>
  );
}

// ─── BookCard ─────────────────────────────────────────────────────────────────

function BookCard({ book, feedback, onLike, onDislike }) {
  const [hovered, setHovered] = useState(false);
  const author = book.authors[0] || 'Unknown';
  const rating = book.rating ? book.rating.toFixed(1) : null;
  const cats = book.categories.map(leafCategory).slice(0, 2);
  const desc = book.description?.replace(/<[^>]+>/g, '') || '';

  return (
    <div
      style={s.card(feedback)}
      onMouseEnter={e => {
        setHovered(true);
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)';
      }}
      onMouseLeave={e => {
        setHovered(false);
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div style={{ position: 'relative' }}>
        <a href={book.infoLink} target="_blank" rel="noopener noreferrer">
          <img src={book.cover} alt={book.title} style={s.cover} />
        </a>
        {hovered && desc && (
          <div style={s.descOverlay}>
            {desc.length > 300 ? desc.slice(0, 300) + '…' : desc}
          </div>
        )}
      </div>
      <div style={s.cardBody}>
        <h3 style={s.cardTitle}>{book.title}</h3>
        <div style={s.cardAuthor}>{author}</div>
        {(book.year || rating) && (
          <div style={s.metaRow}>
            {book.year && <span>{book.year}</span>}
            {book.year && rating && <span>·</span>}
            {rating && <span>★ {rating}</span>}
          </div>
        )}
        {cats.length > 0 && (
          <div style={s.categoryRow}>
            {cats.map(c => <span key={c} style={s.categoryPill}>{c}</span>)}
          </div>
        )}
        <div style={s.feedbackBtns}>
          <button
            style={s.fbBtn(feedback === 'liked', '#22c55e')}
            title="More like this"
            onClick={() => onLike(book)}
          >+</button>
          <button
            style={s.fbBtn(feedback === 'disliked', '#ef4444')}
            title="Less like this"
            onClick={() => onDislike(book)}
          >&minus;</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function BookFinder() {
  const [seedBooks, setSeedBooks] = useState([]);

  const [allBooks, setAllBooks] = useState([]);
  const [visibleCount, setVisibleCount] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);

  const [liked, setLiked] = useState(new Map());
  const [disliked, setDisliked] = useState(new Map());
  const [seen, setSeen] = useState(new Set());

  const seedIds = new Set(seedBooks.map(b => b.id));

  function addSeed(book) {
    setSeedBooks(prev => prev.some(b => b.id === book.id) ? prev : [...prev, book]);
  }

  function removeSeed(id) {
    setSeedBooks(prev => prev.filter(b => b.id !== id));
  }

  const handleFind = useCallback(async () => {
    if (!seedBooks.length) return;
    setLoading(true);
    setError(null);
    try {
      const results = await getRecommendations(seedBooks);
      setAllBooks(results);
      setVisibleCount(20);
      // Reset seen/feedback for a fresh search; seen is only used by Refine
      setSeen(new Set(results.map(b => b.id)));
      setLiked(new Map());
      setDisliked(new Map());
      setHasSearched(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [seedBooks]);

  const handleRefine = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await refineRecommendations(
        seedBooks,
        [...liked.values()],
        [...disliked.values()],
        [...seen],
      );
      setAllBooks(results);
      setVisibleCount(20);
      setSeen(prev => {
        const next = new Set(prev);
        results.forEach(b => next.add(b.id));
        return next;
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [seedBooks, liked, disliked, seen]);

  function handleLike(book) {
    setLiked(prev => {
      const next = new Map(prev);
      if (next.has(book.id)) next.delete(book.id);
      else next.set(book.id, book);
      return next;
    });
    setDisliked(prev => { const next = new Map(prev); next.delete(book.id); return next; });
  }

  function handleDislike(book) {
    setDisliked(prev => {
      const next = new Map(prev);
      if (next.has(book.id)) next.delete(book.id);
      else next.set(book.id, book);
      return next;
    });
    setLiked(prev => { const next = new Map(prev); next.delete(book.id); return next; });
  }

  function getFeedback(id) {
    if (liked.has(id)) return 'liked';
    if (disliked.has(id)) return 'disliked';
    return null;
  }

  const hasFeedback = liked.size > 0 || disliked.size > 0;
  const books = allBooks.slice(0, visibleCount);
  const hasMore = visibleCount < allBooks.length;
  const canFind = seedBooks.length > 0 && !loading;

  return (
    <div style={s.container}>
      <PageHeader
        title="Book Finder"
        subtitle="Add books you love and discover what to read next."
      />

      <div style={s.section}>
        <label style={s.label}>Books you love</label>
        <BookSearchInput onAdd={addSeed} excludeIds={seedIds} />
        {seedBooks.length > 0 && (
          <div style={{ marginTop: '0.75rem' }}>
            <SeedBookList books={seedBooks} onRemove={removeSeed} />
          </div>
        )}
      </div>

      <div style={{ ...s.section, textAlign: 'center' }}>
        <button style={s.btn(!canFind)} disabled={!canFind} onClick={handleFind}>
          {loading ? 'Finding...' : 'Find Similar Books'}
        </button>
        {!seedBooks.length && (
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-body)' }}>
            Add at least one book above to get started
          </p>
        )}
      </div>

      {error && (
        <div style={{ textAlign: 'center', color: '#ef4444', fontFamily: 'var(--font-body)', marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {hasSearched && hasFeedback && !loading && (
        <div style={s.refineBar}>
          <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-body)' }}>
            {liked.size} liked · {disliked.size} disliked
          </span>
          <button style={s.btn(false)} onClick={handleRefine}>Refine</button>
        </div>
      )}

      {loading && <div style={s.loading}>Finding books you'll love...</div>}

      {!loading && hasSearched && allBooks.length === 0 && (
        <EmptyState message="No recommendations found. Try adding different books." />
      )}

      {!loading && books.length > 0 && (
        <>
          <div style={s.grid}>
            {books.map(b => (
              <BookCard
                key={b.id}
                book={b}
                feedback={getFeedback(b.id)}
                onLike={handleLike}
                onDislike={handleDislike}
              />
            ))}
          </div>
          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
              <button style={s.btn(false)} onClick={() => setVisibleCount(n => n + 20)}>
                Load More
              </button>
            </div>
          )}
          <p style={s.attribution}>Book data from Google Books.</p>
        </>
      )}
    </div>
  );
}
