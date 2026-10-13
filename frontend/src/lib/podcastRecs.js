// Podcast recommendations: "Because you listened to <episode>" sections, using
// sentence embeddings (see embeddings.js).
//
// For each recently played episode:
// 1. Queries: named entities from its title/description (guests, companies,
//    books — other podcasts covering the same person or story are the best
//    match signal available), plus a topic phrase. Entities that belong to the
//    show itself (hosts, branding) are skipped.
// 2. Search Spotify episodes for each query.
// 3. Rank every result by embedding similarity to that specific episode, drop
//    weak matches, fetch show details for the best, and drop followed shows.
// Each candidate is assigned to the source episode it matches best, so the
// same episode never appears in two sections.
import { spGet } from './spotify';
import { embed, dot } from './embeddings';

const MAX_SOURCES = 8;
const ENTITY_QUERIES = 2;
const DETAILS_PER_SOURCE = 5;
const RECS_PER_SOURCE = 4;
const MIN_SIMILARITY = 0.35;
const MAX_AGE_DAYS = 90;

const STOPWORDS = new Set(`a about above after again against all also am an and any are as at be because been
before being below between both but by can could did do does doing down during each few for from further get
gets got had has have having he her here hers herself him himself his how i if in into is it its itself just
let me more most my myself no nor not now of off on once only or other our ours ourselves out over own really
same she should so some such than that the their theirs them themselves then there these they this those
through to too under until up very was we were what when where which while who whom why will with would you
your yours yourself yourselves episode episodes podcast podcasts show shows today week weeks talk talks talking
discuss discusses discussing join joins joined guest guests host hosts hosted new interview interviews part ep
listen listening listeners also back way things thing lot much many one two three first last next going go goes
make makes made know like well time year years day days look looks looking take takes chat chats conversation
conversations season series bonus full plus via edition special weekly daily latest every best world people
stories story life everything anything something award winning bring brings brought each fantastic amazing
great awesome incredible devoted dedicated researched online magazine global era hilarious funny fun deep dive
dives inside behind biggest smartest top insightful thoughtful honest candid real weekday ideas insights
explore explores exploring covering covers cover news hottest trending brand subject topics topic`.split(/\s+/));

// Capitalised words that start entities but aren't names on their own.
const NOT_ENTITIES = new Set(`the a an in on at for and but or this that these those we i you he she it they my our
your his her its their what why how when where who which episode part today plus also then now so if is are
was were be ep chapter season bonus special live new ad ads sponsored mr mrs ms dr ceo cfo cto founder
cofounder co-founder president professor author economist director editor host`.split(/\s+/));

const JUNK = /https?:|www\.|\.com\b|\.co\b|@|promo|\bcode\b|sponsor|patreon|subscribe|advertis|privacy|newsletter|follow (us|me|the)|discount|% off|ad ?choices|megaphone|acast|simplecast|omny|art19|libsyn|learn more|sign up|free trial|support (the|this|our)|leave (a|us) (review|rating)|rate and review|transcript|timestamps|chapters/i;

export function cleanDescription(text, max = 600) {
  return (text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s && !JUNK.test(s))
    .join(' ')
    .slice(0, max);
}

const episodeText = ep => `${ep.name}. ${cleanDescription(ep.description)}`;

function parseRelease(d) {
  const [y, m = 1, day = 1] = (d || '').split('-').map(Number);
  return y ? new Date(y, m - 1, day).getTime() : 0;
}

// Re-published feeds ("Freakonomics Radio | SiriusXM Podcasts+") have different
// show IDs, so also match shows by base name and episodes by title.
const coreShowName = n => (n || '').toLowerCase()
  .split(/\s+[|–—-]\s+|\s*\(|:\s/)[0]
  .replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const titleKey = t => (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const langsOf = x => (x.languages || [x.language]).filter(Boolean).map(l => l.split('-')[0]);
const CONNECTOR = /^(of|the|de|von|van)$/;

// Runs of Capitalised Words (allowing "of"/"the" inside), e.g. "Sam Altman",
// "Bank of Canada". Single words at the start of a sentence are ambiguous, so skipped.
function extractEntities(text, out = new Map(), atStart = new Set()) {
  for (const sentence of (text || '').split(/(?<=[.!?:,;])\s+|\s[|•—–-]\s|\n+|[()"“”[\]]/)) {
    const tokens = sentence.trim().split(/\s+/)
      .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/[’']s$/, ''));
    let run = [];
    const flush = () => {
      while (run.length && CONNECTOR.test(run[run.length - 1].w)) run.pop();
      const words = run.map(r => r.w);
      const single = words.length === 1 && run[0].i === 0;
      if (words.length && words.length <= 4 && !single && !NOT_ENTITIES.has(words[0].toLowerCase())) {
        const name = words.join(' ');
        if (name.length >= 3) out.set(name, (out.get(name) || 0) + 1);
        if (run[0].i === 0) atStart.add(name);
      }
      run = [];
    };
    tokens.forEach((w, i) => {
      // Capitalised word; long ALL-CAPS words are usually shouting, not names.
      if (/^\p{Lu}[\p{L}\p{N}.&-]*$/u.test(w) && !(w.length > 4 && w === w.toUpperCase())) run.push({ w, i });
      else if (run.length && CONNECTOR.test(w)) run.push({ w, i });
      else flush();
    });
    flush();
  }
  return out;
}

// "Economist Claudia Sahm" at a sentence start → fold into "Claudia Sahm".
function foldSentenceStarts(counts, atStart) {
  for (const name of atStart) {
    const rest = name.split(' ').slice(1).join(' ');
    if (rest && counts.has(rest) && counts.has(name)) {
      counts.set(rest, counts.get(rest) + counts.get(name));
      counts.delete(name);
    }
  }
  return counts;
}

// Title Case titles capitalise every word, so only trust title entities that
// also appear capitalised in the description.
function episodeEntities(ep) {
  const desc = cleanDescription(ep.description, 1200);
  const atStart = new Set();
  const counts = extractEntities(desc, new Map(), atStart);
  const words = ep.name.split(/\s+/).filter(w => /^\p{L}{4,}/u.test(w));
  const titleCase = words.length >= 3 && words.filter(w => /^\p{Lu}/u.test(w)).length / words.length > 0.6;
  for (const [name] of extractEntities(ep.name)) {
    if (titleCase && !desc.includes(name)) continue;
    counts.set(name, (counts.get(name) || 0) + 3);
  }
  return foldSentenceStarts(counts, atStart);
}

// 1–2 word lowercase topic phrases, skipping stopwords/numbers/contractions.
function topicPhrases(text, banned) {
  const words = cleanDescription(text, 800).toLowerCase().replace(/[’']s\b/g, '')
    .split(/[^\p{L}\p{N}'-]+/u).map(w => w.replace(/^[-']+|[-']+$/g, '')).filter(Boolean);
  const seen = new Map();
  for (let n = 1; n <= 2; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n);
      if (STOPWORDS.has(gram[0]) || STOPWORDS.has(gram[n - 1])) continue;
      if (gram.some(w => banned.has(w) || /\d|'/.test(w) || w.length < 3)) continue;
      const phrase = gram.join(' ');
      seen.set(phrase, (seen.get(phrase) || 0) + 1);
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([p]) => p);
}

async function mapLimit(items, limit, fn, errors) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) {
        out[i] = null;
        errors?.push(`${e.status || ''} ${e.message}`.trim());
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function pickBest(options, vec, vecs, taken) {
  let best = null, bestScore = -Infinity;
  for (const o of options) {
    if (taken.has(o.toLowerCase())) continue;
    const sc = dot(vecs.get(o), vec);
    if (sc > bestScore) { best = o; bestScore = sc; }
  }
  return best;
}

// Returns { sections: [{ source, recs }], debug }.
export async function recommendEpisodes({ token, listened, followedShows, onProgress = () => {} }) {
  const debug = { listenedEpisodes: listened.length, errors: [] };
  const done = sections => ({ sections, debug: { ...debug, errors: [...new Set(debug.errors)].slice(0, 3) } });

  // Most recent first (release date is the best recency proxy Spotify exposes);
  // at most one source per show so a single show can't dominate.
  const seenShows = new Set();
  const sources = [...listened]
    .sort((a, b) => b._date - a._date)
    .filter(ep => {
      if (!ep._show || seenShows.has(ep._show.id)) return false;
      seenShows.add(ep._show.id);
      return true;
    })
    .slice(0, MAX_SOURCES);
  debug.sources = sources.length;
  if (!sources.length) return done([]);

  onProgress('Reading the episodes you played…');
  const sourceVecs = await embed(sources.map(episodeText));

  // ── 1. Queries per source episode ──
  onProgress('Finding guests and topics…');
  const followedIds = new Set(followedShows.map(s => s.id));
  const followedNames = new Set(followedShows.map(s => coreShowName(s.name)));
  const knownTitles = new Set([
    ...listened.map(ep => titleKey(ep.name)),
    ...followedShows.map(s => s._latest?.name).filter(Boolean).map(titleKey),
  ]);
  const perSource = sources.map(ep => {
    const showText = `${ep._show.name} ${ep._show.publisher || ''} ${ep._show.description || ''}`.toLowerCase();
    const showWords = new Set(ep._show.name.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const entityCounts = episodeEntities(ep);
    // Hosts and show branding appear in the show's own description — skip them.
    const entities = [...entityCounts.entries()]
      .filter(([name]) => !showText.includes(name.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name]) => name);
    // Topics shouldn't repeat entity words — entities are searched separately.
    const banned = new Set([...showWords, ...entities.flatMap(e => e.toLowerCase().split(/\s+/))]);
    return { entities, topics: topicPhrases(`${ep.name}. ${ep.description}`, banned) };
  });
  const allTerms = [...new Set(perSource.flatMap(p => [...p.entities, ...p.topics]))];
  const termVecs = new Map((await embed(allTerms)).map((v, i) => [allTerms[i], v]));

  const taken = new Set();
  const queries = []; // { q, source }
  perSource.forEach((p, si) => {
    const vec = sourceVecs[si];
    for (let k = 0; k < ENTITY_QUERIES; k++) {
      const e = pickBest(p.entities, vec, termVecs, taken);
      if (!e) break;
      taken.add(e.toLowerCase());
      queries.push({ q: e, source: si });
    }
    const t = pickBest(p.topics, vec, termVecs, taken);
    if (t) { taken.add(t.toLowerCase()); queries.push({ q: t, source: si }); }
  });
  debug.queries = queries.map(x => x.q);

  // ── 2. Search episodes ──
  onProgress(`Searching Spotify for ${queries.length} guests and topics…`);
  const languages = new Set(sources.flatMap(langsOf));
  const listenedIds = new Set(listened.map(e => e.id));
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const results = await mapLimit(queries, 3, ({ q }) =>
    spGet(`/search?type=episode&market=from_token&limit=10&q=${encodeURIComponent(q)}`, token)
      .then(d => (d.episodes?.items || []).filter(Boolean)),
    debug.errors,
  );
  debug.searchResults = results.reduce((n, r) => n + (r?.length || 0), 0);

  const candidates = new Map();
  results.forEach(items => (items || []).forEach(ep => {
    if (candidates.has(ep.id) || listenedIds.has(ep.id) || knownTitles.has(titleKey(ep.name))) return;
    const date = parseRelease(ep.release_date);
    if (date < cutoff) return;
    const langs = langsOf(ep);
    if (languages.size && langs.length && !langs.some(l => languages.has(l))) return;
    candidates.set(ep.id, { ...ep, _date: date });
  }));
  debug.candidates = candidates.size;
  if (!candidates.size) return done([]);

  // ── 3. Rank against each source; assign each candidate to its best source ──
  onProgress(`Ranking ${candidates.size} episodes…`);
  const cands = [...candidates.values()];
  const candVecs = await embed(cands.map(episodeText));
  const buckets = sources.map(() => []);
  cands.forEach((ep, ci) => {
    let bestSi = -1, bestSim = MIN_SIMILARITY;
    sourceVecs.forEach((sv, si) => {
      const sim = dot(candVecs[ci], sv);
      if (sim > bestSim) { bestSi = si; bestSim = sim; }
    });
    if (bestSi >= 0) buckets[bestSi].push({ ep, sim: bestSim });
  });
  debug.aboveThreshold = buckets.reduce((n, b) => n + b.length, 0);

  // Search results lack the show, so fetch details for the best per source.
  const shortlist = buckets.flatMap((b, si) =>
    b.sort((a, c) => c.sim - a.sim).slice(0, DETAILS_PER_SOURCE).map(x => ({ ...x, si })));
  onProgress('Checking shows…');
  const details = await mapLimit(shortlist, 4, x => spGet(`/episodes/${x.ep.id}?market=from_token`, token), debug.errors);

  const sections = sources.map(source => ({ source: { id: source.id, name: source.name, show: source._show.name }, recs: [] }));
  const usedShows = new Set();
  shortlist.forEach((x, i) => {
    const full = details[i];
    const show = full?.show;
    if (!show || followedIds.has(show.id) || followedNames.has(coreShowName(show.name))) return;
    const section = sections[x.si];
    const key = `${x.si}:${show.id}`;
    if (section.recs.length >= RECS_PER_SOURCE || usedShows.has(key)) return;
    usedShows.add(key);
    section.recs.push({ ...x.ep, ...full, show: undefined, _date: x.ep._date, _show: show });
  });
  debug.recommended = sections.reduce((n, s) => n + s.recs.length, 0);
  return done(sections.filter(s => s.recs.length));
}
