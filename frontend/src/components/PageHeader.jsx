export default function PageHeader({ title, subtitle }) {
  return (
    <header style={{ marginBottom: '2.5rem' }}>
      <h1 style={{ fontSize: '2.5rem', margin: '0 0 0.5rem', color: 'var(--color-text)' }}>
        {title}
      </h1>
      {subtitle && (
        <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '1.1rem' }}>
          {subtitle}
        </p>
      )}
    </header>
  );
}
