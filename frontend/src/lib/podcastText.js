// Episode description cleanup, shared by the episode list (previews) and podcast
// recommendations. Kept separate from podcastRecs.js, which loads the embedding model.

// Sentences that are sponsor reads, links or housekeeping rather than what the episode is about.
const JUNK = /https?:|www\.|\.com\b|\.co\b|@|promo|\bcode\b|sponsor|patreon|subscribe|advertis|privacy|newsletter|follow (us|me|the)|discount|% off|ad ?choices|megaphone|acast|simplecast|omny|art19|libsyn|learn more|sign up|free trial|support (the|this|our)|leave (a|us) (review|rating)|rate and review|transcript|timestamps|chapters|brought to you|presented by|thanks to our|our partners?\b/i;

// Description without those sentences, cut to `max` characters.
export function cleanDescription(text, max = 600) {
  return (text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s && !JUNK.test(s))
    .join(' ')
    .slice(0, max);
}
