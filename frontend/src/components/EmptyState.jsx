export default function EmptyState({ message }) {
  return (
    <div style={{
      textAlign: 'center',
      padding: '4rem 2rem',
      color: 'var(--color-text-muted)',
      fontFamily: 'var(--font-body)',
    }}>
      <p style={{ fontSize: '1.1rem', margin: 0 }}>{message}</p>
    </div>
  );
}
