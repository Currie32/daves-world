export default function TagPill({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '0.25rem 0.75rem',
        borderRadius: '9999px',
        border: '1px solid var(--color-accent)',
        background: active ? 'var(--color-accent)' : 'transparent',
        color: active ? '#fff' : 'var(--color-accent)',
        fontSize: '0.8rem',
        fontFamily: 'var(--font-body)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      {label}
    </button>
  );
}
