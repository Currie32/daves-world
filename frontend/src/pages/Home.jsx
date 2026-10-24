import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import projects from '../data/projects.json';

const MOBILE_QUERY = '(max-width: 640px)';

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = e => setMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

export default function Home() {
  const mobile = useIsMobile();
  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: mobile ? '2rem 1rem' : '3rem 1.5rem' }}>
      <header style={{ marginBottom: mobile ? '1.5rem' : '2.5rem' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: mobile ? '2.5rem' : '3.25rem',
          margin: 0,
          lineHeight: 1.1,
        }}>
          Dave's World
        </h1>
      </header>

      <main>
        <div style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'minmax(0, 1fr)' : 'repeat(auto-fill, minmax(300px, 1fr))',
          gridAutoRows: '1fr', // every card the same height
          gap: mobile ? '0.5rem' : '1rem',
        }}>
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} mobile={mobile} />
          ))}
        </div>
      </main>
    </div>
  );
}

// Mobile: one compact full-width row per tool (description clipped to one line).
// Desktop: a medium card — emoji + title on one line, description (two lines reserved) below,
// so every card is the same height.
function ProjectCard({ project, mobile }) {
  const description = (
    <p style={{
      color: 'var(--color-text-muted)',
      fontSize: mobile ? '0.82rem' : '0.9rem',
      margin: mobile ? '0.1rem 0 0' : '0.5rem 0 0',
      lineHeight: 1.45,
      overflow: 'hidden',
      ...(mobile
        ? { whiteSpace: 'nowrap', textOverflow: 'ellipsis' }
        : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', minHeight: '2.9em' }),
    }}>
      {project.comingSoon ? 'Coming soon' : project.description}
    </p>
  );
  const title = (
    <h2 style={{
      fontFamily: 'var(--font-display)',
      fontSize: mobile ? '1.05rem' : '1.2rem',
      margin: 0,
      lineHeight: 1.25,
      color: 'var(--color-text)',
      flex: 1,
      minWidth: 0,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}>
      {project.title}
    </h2>
  );
  const emoji = <div style={{ fontSize: mobile ? '1.4rem' : '1.6rem', lineHeight: 1, flexShrink: 0 }}>{project.emoji}</div>;
  const arrow = !project.comingSoon && <span style={{ color: 'var(--color-accent)', flexShrink: 0 }}>→</span>;

  const inner = (
    <div
      style={{
        height: '100%',
        boxSizing: 'border-box',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderLeft: '4px solid var(--color-accent)',
        borderRadius: mobile ? '10px' : '12px',
        padding: mobile ? '0.6rem 0.85rem' : '1.1rem 1.25rem',
        opacity: project.comingSoon ? 0.6 : 1,
        transition: 'transform 0.15s, box-shadow 0.15s',
        ...(mobile ? { display: 'flex', alignItems: 'center', gap: '0.75rem' } : {}),
      }}
      onMouseEnter={e => {
        if (!project.comingSoon && !mobile) {
          e.currentTarget.style.transform = 'translateY(-3px)';
          e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.08)';
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {mobile ? (
        <>
          {emoji}
          <div style={{ flex: 1, minWidth: 0 }}>{title}{description}</div>
          {arrow}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>{emoji}{title}</div>
          {description}
        </>
      )}
    </div>
  );

  if (project.comingSoon) return inner;
  return <Link to={project.route} style={{ textDecoration: 'none', display: 'block', minWidth: 0 }}>{inner}</Link>;
}
