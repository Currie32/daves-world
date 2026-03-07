export default function SearchInput({ placeholder, onChange, value, onKeyDown }) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      style={{
        width: '100%',
        padding: '0.75rem 1rem',
        border: '1px solid var(--color-border)',
        borderRadius: '8px',
        fontFamily: 'var(--font-body)',
        fontSize: '1rem',
        background: 'var(--color-surface)',
        color: 'var(--color-text)',
        outline: 'none',
      }}
    />
  );
}
