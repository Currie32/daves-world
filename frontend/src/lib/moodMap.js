const moodMap = {
  chill:   { energy: 0.3, valence: 0.5, tempo: 90 },
  happy:   { energy: 0.8, valence: 0.9, tempo: 120 },
  focus:   { energy: 0.5, valence: 0.4, instrumentalness: 0.7 },
  sad:     { energy: 0.2, valence: 0.2, tempo: 75 },
  party:   { energy: 0.95, valence: 0.85, tempo: 130 },
  workout: { energy: 0.9, danceability: 0.8, tempo: 140 },
};

export function getMoodFeatures(description) {
  const lower = description.toLowerCase();
  const matches = Object.entries(moodMap).filter(([keyword]) =>
    lower.includes(keyword)
  );

  if (matches.length === 0) return { energy: 0.5, valence: 0.5 };

  const merged = {};
  matches.forEach(([, features]) => {
    Object.entries(features).forEach(([key, val]) => {
      merged[key] = (merged[key] ?? 0) + val / matches.length;
    });
  });

  return merged;
}
