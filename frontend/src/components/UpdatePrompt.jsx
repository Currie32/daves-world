import { useRegisterSW } from 'virtual:pwa-register/react';

export default function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.25rem',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: '0.9rem',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderLeft: '4px solid var(--color-accent)',
        borderRadius: '10px',
        padding: '0.75rem 1rem',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
        fontFamily: 'var(--font-body)',
        fontSize: '0.9rem',
        color: 'var(--color-text)',
        maxWidth: 'calc(100vw - 2rem)',
      }}
    >
      <span>A new version is ready.</span>
      <button
        onClick={() => updateServiceWorker(true)}
        style={{
          background: 'var(--color-accent)',
          color: '#fff',
          border: 'none',
          borderRadius: '6px',
          padding: '0.4rem 0.75rem',
          fontSize: '0.85rem',
          fontFamily: 'var(--font-body)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        Reload
      </button>
      <button
        onClick={() => setNeedRefresh(false)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-text-muted)',
          fontSize: '0.85rem',
          fontFamily: 'var(--font-body)',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        Later
      </button>
    </div>
  );
}
