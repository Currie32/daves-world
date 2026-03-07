import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { collection, getDocs, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app, db } from '../lib/firebase';
import PageHeader from '../components/PageHeader';
import SearchInput from '../components/SearchInput';
import TagPill from '../components/TagPill';
import EmptyState from '../components/EmptyState';
import { createSearch, search } from '../lib/fuzzySearch';
import cookbooksIndex from '../data/cookbooks-index.json';

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  page: {
    maxWidth: '1100px',
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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '1rem',
    marginTop: '1.5rem',
  },
  cookbookCard: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderLeft: '4px solid var(--color-accent)',
    borderRadius: '8px',
    padding: '1.25rem',
    cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s',
  },
  recipeCard: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderLeft: '4px solid var(--color-accent)',
    borderRadius: '8px',
    padding: '1rem 1.25rem',
  },
  webCard: (expanded) => ({
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderLeft: '4px solid var(--color-accent)',
    borderRadius: '8px',
    padding: '1.25rem',
    cursor: 'pointer',
  }),
  filterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    margin: '1rem 0',
  },
  resultsCount: {
    fontSize: '0.85rem',
    color: 'var(--color-text-muted)',
    marginTop: '0.5rem',
  },
  backLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    color: 'var(--color-accent)',
    fontSize: '0.9rem',
    fontWeight: 500,
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
    fontFamily: 'var(--font-body)',
    marginBottom: '1.5rem',
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useHover() {
  const [hovered, setHovered] = useState(false);
  return {
    hovered,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };
}

function pillsFrom(items, limit = 3) {
  return items.slice(0, limit);
}

// ─── CookbookCard ─────────────────────────────────────────────────────────────

function CookbookCard({ book, onClick }) {
  const { hovered, ...hoverProps } = useHover();
  return (
    <div
      style={{
        ...styles.cookbookCard,
        transform: hovered ? 'translateY(-2px)' : 'none',
        boxShadow: hovered ? '0 4px 16px rgba(0,0,0,0.1)' : 'none',
      }}
      onClick={onClick}
      {...hoverProps}
    >
      <h3 style={{ margin: '0 0 0.25rem', fontSize: '1.05rem', fontFamily: 'var(--font-display)' }}>
        {book.title}
      </h3>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
        {book.author} · {book.recipeCount} recipes
      </p>
    </div>
  );
}

// ─── RecipeCard ───────────────────────────────────────────────────────────────

function RecipeCard({ recipe }) {
  const author = cookbooksIndex.find((b) => b.id === recipe.bookId)?.author;
  return (
    <div style={styles.recipeCard}>
      <h3 style={{ margin: '0 0 0.2rem', fontSize: '0.95rem', fontFamily: 'var(--font-display)' }}>
        {recipe.title}
      </h3>
      <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
        {recipe.book}{author ? ` · ${author}` : ''}
        {recipe.page ? ` · p. ${recipe.page}` : ''}
      </p>
      <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
        {recipe.ingredients.join(', ')}
      </p>
    </div>
  );
}

// ─── CookbookIndex ────────────────────────────────────────────────────────────

const TYPE_LABEL = {
  ingredient: 'Ingredient',
  category: 'Category',
  book: 'Book',
  author: 'Author',
};

function CookbookIndex({ onSelectBook, allRecipes }) {
  const [query, setQuery] = useState('');
  const [activeCuisine, setActiveCuisine] = useState(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedFilters, setSelectedFilters] = useState([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef(null);
  const dropdownRef = useRef(null);

  // Build facet lists sorted by frequency in recipes
  const { ingredientOptions, categoryOptions } = useMemo(() => {
    if (!allRecipes) return { ingredientOptions: [], categoryOptions: [] };
    const ingCount = new Map();
    const catSet = new Set();
    allRecipes.forEach((r) => {
      (r.ingredientsStandardised || r.ingredients || []).forEach((i) => {
        ingCount.set(i, (ingCount.get(i) || 0) + 1);
      });
      (r.categories || []).forEach((c) => catSet.add(c));
    });
    return {
      ingredientOptions: [...ingCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([v]) => v),
      categoryOptions: [...catSet].sort(),
    };
  }, [allRecipes]);

  const bookOptions = useMemo(
    () => [...cookbooksIndex].sort((a, b) => b.recipeCount - a.recipeCount).map((b) => b.title),
    []
  );
  const authorOptions = useMemo(() => {
    const counts = {};
    cookbooksIndex.forEach((b) => { counts[b.author] = (counts[b.author] || 0) + b.recipeCount; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, []);

  // author → Set<bookId> for recipe filtering
  const authorToBookIds = useMemo(() => {
    const map = {};
    cookbooksIndex.forEach((b) => {
      if (!map[b.author]) map[b.author] = new Set();
      map[b.author].add(b.id);
    });
    return map;
  }, []);

  const allCuisines = useMemo(() => {
    const set = new Set();
    cookbooksIndex.forEach((b) => b.cuisines.forEach((c) => set.add(c)));
    return [...set].sort();
  }, []);

  // Autocomplete suggestions: ingredients, categories, books, authors matching query
  const suggestions = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    const results = [];
    const alreadySelected = new Set(selectedFilters.map((f) => `${f.type}:${f.value}`));
    function add(type, list, limit) {
      list
        .filter((v) => v.toLowerCase().includes(q) && !alreadySelected.has(`${type}:${v}`))
        .slice(0, limit)
        .forEach((v) => results.push({ type, value: v }));
    }
    add('ingredient', ingredientOptions, Infinity);
    add('book', bookOptions, Infinity);
    add('author', authorOptions, Infinity);
    return results;
  }, [query, ingredientOptions, categoryOptions, bookOptions, authorOptions, selectedFilters]);

  // Recipe results: AND logic across all selected filters
  const recipeResults = useMemo(() => {
    if (!allRecipes || selectedFilters.length === 0) return [];
    return allRecipes
      .filter((recipe) =>
        selectedFilters.every((filter) => {
          switch (filter.type) {
            case 'ingredient':
              return (recipe.ingredientsStandardised || recipe.ingredients || [])
                .some((i) => i.toLowerCase().includes(filter.value.toLowerCase()));
            case 'category':
              return (recipe.categories || []).includes(filter.value);
            case 'book':
              return recipe.book === filter.value;
            case 'author':
              return (authorToBookIds[filter.value] || new Set()).has(recipe.bookId);
            default:
              return true;
          }
        })
      )
      .sort((a, b) => a.ingredients.length - b.ingredients.length);
  }, [allRecipes, selectedFilters, authorToBookIds]);

  function addFilter(filter) {
    setSelectedFilters((prev) => {
      if (prev.some((f) => f.type === filter.type && f.value === filter.value)) return prev;
      return [...prev, filter];
    });
    setQuery('');
    setShowDropdown(false);
  }

  function removeFilter(filter) {
    setSelectedFilters((prev) =>
      prev.filter((f) => !(f.type === filter.type && f.value === filter.value))
    );
  }

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    function handleEscape(e) {
      if (e.key === 'Escape') setShowDropdown(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const hasFilters = selectedFilters.length > 0;

  return (
    <div>
      <div ref={containerRef} style={{ position: 'relative' }}>
        <SearchInput
          placeholder="Filter by ingredient, category, book, or author…"
          value={query}
          onChange={(v) => { setQuery(v); setShowDropdown(true); setHighlightedIndex(0); }}
          onKeyDown={(e) => {
            if (!showDropdown || suggestions.length === 0) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlightedIndex((i) => {
                const next = Math.min(i + 1, suggestions.length - 1);
                dropdownRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
                return next;
              });
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlightedIndex((i) => {
                const next = Math.max(i - 1, 0);
                dropdownRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
                return next;
              });
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (suggestions[highlightedIndex]) addFilter(suggestions[highlightedIndex]);
            }
          }}
        />
        {showDropdown && query && suggestions.length > 0 && (
          <div style={{
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
            maxHeight: '320px',
            overflowY: 'scroll',
          }}
          ref={dropdownRef}
          >
            {suggestions.map((s, i) => (
              <button
                key={`${s.type}:${s.value}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  width: '100%',
                  padding: '0.65rem 1rem',
                  background: i === highlightedIndex ? 'var(--color-border)' : 'none',
                  border: 'none',
                  borderBottom: '1px solid var(--color-border)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                }}
                onMouseEnter={() => setHighlightedIndex(i)}
                onClick={() => addFilter(s)}
              >
                <span style={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  minWidth: '4.5rem',
                }}>
                  {TYPE_LABEL[s.type]}
                </span>
                <span style={{ fontSize: '0.9rem', color: 'var(--color-text)' }}>{s.value}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Active filter chips */}
      {hasFilters && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '0.75rem 0' }}>
          {selectedFilters.map((f) => (
            <button
              key={`${f.type}:${f.value}`}
              onClick={() => removeFilter(f)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.3rem 0.65rem',
                background: 'var(--color-accent)',
                color: '#fff',
                border: 'none',
                borderRadius: '999px',
                fontFamily: 'var(--font-body)',
                fontSize: '0.82rem',
                cursor: 'pointer',
              }}
            >
              <span style={{ opacity: 0.75, fontSize: '0.75rem' }}>{TYPE_LABEL[f.type]}</span>
              {f.value}
              <span style={{ opacity: 0.75, marginLeft: '0.1rem' }}>×</span>
            </button>
          ))}
        </div>
      )}

      {/* Cookbook grid when no filters active */}
      {!hasFilters && (
        <>
          <p style={styles.resultsCount}>{cookbooksIndex.length} cookbook{cookbooksIndex.length !== 1 ? 's' : ''}</p>
          <div style={styles.grid}>
            {cookbooksIndex.map((book) => (
              <CookbookCard key={book.id} book={book} onClick={() => onSelectBook(book.id)} />
            ))}
          </div>
        </>
      )}

      {/* Recipe results when filters active */}
      {hasFilters && (
        <>
          <p style={styles.resultsCount}>{recipeResults.length} recipe{recipeResults.length !== 1 ? 's' : ''}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
            {recipeResults.slice(0, 200).map((r) => (
              <RecipeCard key={r.id} recipe={r} />
            ))}
            {recipeResults.length > 200 && (
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', textAlign: 'center' }}>
                Showing 200 of {recipeResults.length} results. Refine your search to see more.
              </p>
            )}
          </div>
          {recipeResults.length === 0 && <EmptyState message="No recipes match all selected filters." />}
        </>
      )}
    </div>
  );
}

// ─── RecipeBrowser ────────────────────────────────────────────────────────────

function RecipeBrowser({ bookId, onBack, allRecipes }) {
  const [query, setQuery] = useState('');

  const book = bookId ? cookbooksIndex.find((b) => b.id === bookId) : null;

  const bookRecipes = useMemo(() => {
    if (!allRecipes) return [];
    return bookId ? allRecipes.filter((r) => r.bookId === bookId) : allRecipes;
  }, [allRecipes, bookId]);

  const fuse = useMemo(
    () => createSearch(bookRecipes, ['title', 'ingredients', 'ingredientsStandardised', 'categories', 'book']),
    [bookRecipes]
  );

  const results = useMemo(() => {
    let items = query ? search(fuse, query) : bookRecipes;
    if (!items) items = bookRecipes;
    return [...items].sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity));
  }, [query, fuse, bookRecipes]);

  if (allRecipes === null) {
    return <p style={{ color: 'var(--color-text-muted)' }}>Loading recipes…</p>;
  }

  if (allRecipes.length === 0) {
    return (
      <EmptyState message="Recipe data not found. Run scripts/generate_cookbook_index.py to generate recipes.json." />
    );
  }

  return (
    <div>
      <button style={styles.backLink} onClick={onBack}>
        ← {book ? `All cookbooks` : 'Back'}
      </button>
      {book && (
        <div style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ margin: '0 0 0.2rem', fontSize: '1.5rem', fontFamily: 'var(--font-display)' }}>
            {book.title}
          </h2>
          <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
            {book.author}
          </p>
        </div>
      )}
      <SearchInput
        placeholder="Search by title, ingredient, or category…"
        value={query}
        onChange={setQuery}
      />
      <p style={styles.resultsCount}>
        {results.length} recipe{results.length !== 1 ? 's' : ''}
        {book ? ` in ${book.title}` : ''}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
        {results.slice(0, 200).map((r) => (
          <RecipeCard key={r.id} recipe={r} />
        ))}
        {results.length > 200 && (
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', textAlign: 'center' }}>
            Showing 200 of {results.length} results. Refine your search to see more.
          </p>
        )}
      </div>
      {results.length === 0 && <EmptyState message="No recipes match your search." />}
    </div>
  );
}

// ─── WebRecipeCard ────────────────────────────────────────────────────────────

function WebRecipeCard({ recipe, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const times = [
    recipe.prepTime ? { label: 'Prep', value: recipe.prepTime } : null,
    recipe.cookTime ? { label: 'Cook', value: recipe.cookTime } : null,
    recipe.totalTime ? { label: 'Total', value: recipe.totalTime } : null,
  ].filter(Boolean);

  const sectionLabel = {
    fontSize: '0.7rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--color-accent)',
    marginBottom: '0.75rem',
  };

  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: '12px',
        overflow: 'hidden',
        cursor: 'pointer',
      }}
      onClick={() => setExpanded((e) => !e)}
    >
      {/* Hero image */}
      {expanded && recipe.image && (
        <img
          src={recipe.image}
          alt={recipe.title}
          style={{ width: '100%', height: '240px', objectFit: 'cover', display: 'block' }}
        />
      )}

      {/* Title row */}
      <div style={{ padding: '1.25rem 1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontFamily: 'var(--font-display)', fontWeight: 600 }}>
          {recipe.title || recipe.source || recipe.host || recipe.url || 'Untitled Recipe'}
        </h3>
        <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', flexShrink: 0, marginLeft: '1rem' }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {expanded && (
        <div onClick={(e) => e.stopPropagation()}>
          {/* Meta strip */}
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1.5rem',
            padding: '1rem 1.5rem',
            borderTop: '1px solid var(--color-border)',
            borderBottom: '1px solid var(--color-border)',
            background: 'var(--color-bg)',
          }}>
            {(recipe.source || recipe.host) && recipe.url && (
              <a
                href={recipe.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: '0.82rem', color: 'var(--color-accent)', fontWeight: 500, textDecoration: 'none' }}
                onMouseEnter={e => e.target.style.textDecoration = 'underline'}
                onMouseLeave={e => e.target.style.textDecoration = 'none'}
              >
                {recipe.source || recipe.host} ↗
              </a>
            )}
            {times.map(({ label, value }) => (
              <div key={label}>
                <div style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: '0.1rem' }}>{label}</div>
                <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>{value} min</div>
              </div>
            ))}
            {recipe.servings && (
              <div>
                <div style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: '0.1rem' }}>Serves</div>
                <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>{recipe.servings}</div>
              </div>
            )}
          </div>

          {/* Ingredients + Instructions */}
          <div style={{ display: 'flex', alignItems: 'flex-start', padding: '1.5rem' }}>
            {recipe.ingredients?.length > 0 && (
              <div style={{ flex: '0 0 280px', paddingRight: '2rem', borderRight: '1px solid var(--color-border)' }}>
                <div style={sectionLabel}>Ingredients</div>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {recipe.ingredients.map((ing, i) => (
                    <li key={i} style={{
                      fontSize: '0.85rem',
                      lineHeight: 1.5,
                      padding: '0.4rem 0',
                      borderBottom: '1px solid var(--color-border)',
                      color: 'var(--color-text)',
                    }}>
                      {ing}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {recipe.instructions?.length > 0 && (
              <div style={{ flex: 1, paddingLeft: recipe.ingredients?.length > 0 ? '2rem' : 0 }}>
                <div style={sectionLabel}>Instructions</div>
                <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {recipe.instructions.map((step, i) => (
                    <li key={i} style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                      <span style={{
                        flexShrink: 0,
                        width: '1.6rem',
                        height: '1.6rem',
                        borderRadius: '50%',
                        background: 'var(--color-accent)',
                        color: '#fff',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginTop: '0.1rem',
                      }}>
                        {i + 1}
                      </span>
                      <span style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--color-text)' }}>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>

          {/* Delete */}
          <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--color-border)', display: 'flex', justifyContent: 'flex-end' }}>
            {confirmDelete ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>Delete this recipe?</span>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                  style={{ padding: '0.35rem 0.85rem', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: '6px', fontFamily: 'var(--font-body)', fontSize: '0.82rem', cursor: 'pointer', color: 'var(--color-text-muted)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(recipe.id); }}
                  style={{ padding: '0.35rem 0.85rem', background: '#c0392b', border: 'none', borderRadius: '6px', fontFamily: 'var(--font-body)', fontSize: '0.82rem', cursor: 'pointer', color: '#fff', fontWeight: 500 }}
                >
                  Delete
                </button>
              </div>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                style={{ padding: '0.35rem 0.85rem', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: '6px', fontFamily: 'var(--font-body)', fontSize: '0.82rem', cursor: 'pointer', color: 'var(--color-text-muted)' }}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── WebRecipes ───────────────────────────────────────────────────────────────

function WebRecipes() {
  const [recipes, setRecipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState(null);

  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    getDocs(collection(db, 'website_recipes'))
      .then((snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        docs.sort((a, b) => (b.addedAt?.seconds ?? 0) - (a.addedAt?.seconds ?? 0));
        setRecipes(docs);
      })
      .catch(() => setRecipes([]))
      .finally(() => setLoading(false));
  }, []);

  const allTags = useMemo(() => {
    const set = new Set();
    recipes.forEach((r) => (r.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
  }, [recipes]);

  const fuse = useMemo(
    () => createSearch(recipes, ['title', 'source', 'tags']),
    [recipes]
  );

  const results = useMemo(() => {
    let items = query ? search(fuse, query) : recipes;
    if (!items) items = recipes;
    if (activeTag) items = items.filter((r) => (r.tags || []).includes(activeTag));
    return items;
  }, [query, activeTag, fuse, recipes]);

  async function handleImport() {
    if (!url.trim()) return;
    setImporting(true);
    setImportError('');
    setPreview(null);
    try {
      const fn = httpsCallable(getFunctions(app, 'us-west1'), 'scrape_recipe');
      const result = await fn({ url: url.trim() });
      setPreview({ ...result.data, url: url.trim(), tags: [], addedAt: null });
    } catch (err) {
      setImportError(err.message || 'Failed to import recipe.');
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(id) {
    try {
      await deleteDoc(doc(db, 'website_recipes', id));
      setRecipes((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      console.error('Failed to delete recipe:', err);
    }
  }

  async function handleSave() {
    if (!preview) return;
    try {
      const docRef = await addDoc(collection(db, 'website_recipes'), {
        ...preview,
        addedAt: serverTimestamp(),
      });
      setRecipes((prev) => [{ id: docRef.id, ...preview, addedAt: { seconds: Date.now() / 1000 } }, ...prev]);
      setPreview(null);
      setUrl('');
    } catch (err) {
      setImportError(err.message || 'Failed to save recipe.');
    }
  }

  return (
    <div>
      <div
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: '8px',
          padding: '1.25rem',
          marginBottom: '2rem',
        }}
      >
        <h3 style={{ margin: '0 0 1rem', fontSize: '1rem', fontFamily: 'var(--font-display)' }}>
          Import a Recipe
        </h3>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a recipe URL…"
            style={{
              flex: 1,
              padding: '0.7rem 1rem',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              fontFamily: 'var(--font-body)',
              fontSize: '0.95rem',
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
              outline: 'none',
            }}
          />
          <button
            onClick={handleImport}
            disabled={importing || !url.trim()}
            style={{
              padding: '0.7rem 1.25rem',
              background: 'var(--color-accent)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontFamily: 'var(--font-body)',
              fontSize: '0.95rem',
              fontWeight: 500,
              cursor: importing ? 'wait' : 'pointer',
              opacity: importing || !url.trim() ? 0.6 : 1,
            }}
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
        {importError && (
          <p style={{ margin: '0.75rem 0 0', fontSize: '0.85rem', color: '#c0392b' }}>{importError}</p>
        )}
        {preview && (
          <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--color-bg)', borderRadius: '6px' }}>
            <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>{preview.title}</p>
            <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
              {preview.source || preview.host}
              {preview.totalTime ? ` · ${preview.totalTime} min` : ''}
            </p>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={handleSave}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'var(--color-accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Save to collection
              </button>
              <button
                onClick={() => setPreview(null)}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'transparent',
                  color: 'var(--color-text-muted)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '6px',
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      <SearchInput
        placeholder="Search saved recipes…"
        value={query}
        onChange={setQuery}
      />
      {allTags.length > 0 && (
        <div style={styles.filterRow}>
          {allTags.map((t) => (
            <TagPill
              key={t}
              label={t}
              active={activeTag === t}
              onClick={() => setActiveTag(activeTag === t ? null : t)}
            />
          ))}
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--color-text-muted)', marginTop: '1rem' }}>Loading…</p>
      ) : results.length === 0 ? (
        <EmptyState message="No saved recipes yet." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
          {results.map((r) => (
            <WebRecipeCard key={r.id} recipe={r} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Cookbooks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('cookbooks');
  const [allRecipes, setAllRecipes] = useState(null);
  const bookId = searchParams.get('book');

  useEffect(() => {
    fetch('/recipes.json')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setAllRecipes)
      .catch(() => setAllRecipes([]));
  }, []);

  function selectBook(id) {
    setSearchParams({ book: id });
    setActiveTab('cookbooks');
  }

  function clearBook() {
    setSearchParams({});
  }

  return (
    <div style={styles.page}>
      <PageHeader
        title="Cookbooks"
        subtitle="Browse my cookbook collection and recipes saved from the web."
      />

      <div style={styles.tabs}>
        <button
          style={styles.tab(activeTab === 'cookbooks')}
          onClick={() => { setActiveTab('cookbooks'); clearBook(); }}
        >
          My Cookbooks
        </button>
        <button
          style={styles.tab(activeTab === 'web')}
          onClick={() => setActiveTab('web')}
        >
          Saved from Web
        </button>
      </div>

      {activeTab === 'cookbooks' && (
        bookId
          ? <RecipeBrowser bookId={bookId} onBack={clearBook} allRecipes={allRecipes} />
          : <CookbookIndex onSelectBook={selectBook} allRecipes={allRecipes} />
      )}
      {activeTab === 'web' && <WebRecipes />}
    </div>
  );
}
