export default function StarRating({ rating }) {
  return (
    <span className="star-rating">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ color: i < rating ? 'var(--color-accent)' : 'var(--color-border)', fontSize: '1rem' }}>
          ★
        </span>
      ))}
    </span>
  );
}
