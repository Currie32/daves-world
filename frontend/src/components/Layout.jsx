import { Link, useLocation } from 'react-router-dom';
import { signInWithPopup, signOut, GoogleAuthProvider } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { useAuth } from '../hooks/useAuth';

export default function Layout({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const isHome = location.pathname === '/';

  function handleSignIn() {
    signInWithPopup(auth, new GoogleAuthProvider()).catch(() => {});
  }

  function handleSignOut() {
    signOut(auth).catch(() => {});
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {!isHome && (
        <nav style={{
          padding: '0.75rem 1.5rem',
          borderBottom: '1px solid var(--color-border)',
        }}>
          <Link to="/" style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.1rem',
            color: 'var(--color-text)',
            textDecoration: 'none',
            transition: 'color 0.15s',
          }}
            onMouseEnter={e => e.target.style.color = 'var(--color-accent)'}
            onMouseLeave={e => e.target.style.color = 'var(--color-text)'}
          >
            Dave's World
          </Link>
        </nav>
      )}
      <div style={{ flex: 1 }}>{children}</div>
      <footer style={{
        borderTop: '1px solid var(--color-border)',
        padding: '1.25rem 1.5rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        color: 'var(--color-text-muted)',
        fontSize: '0.85rem',
      }}>
        <a
          href="https://github.com/Currie32"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--color-text-muted)', transition: 'color 0.15s' }}
          onMouseEnter={e => e.target.style.color = 'var(--color-accent)'}
          onMouseLeave={e => e.target.style.color = 'var(--color-text-muted)'}
        >
          GitHub
        </a>
        {!loading && (
          user ? (
            <button
              onClick={handleSignOut}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-text-muted)',
                fontSize: '0.85rem',
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
                padding: 0,
              }}
            >
              Sign out
            </button>
          ) : (
            <button
              onClick={handleSignIn}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-text-muted)',
                fontSize: '0.85rem',
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
                padding: 0,
              }}
            >
              Sign in
            </button>
          )
        )}
      </footer>
    </div>
  );
}
