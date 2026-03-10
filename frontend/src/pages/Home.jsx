import { Link } from 'react-router-dom';
import projects from '../data/projects.json';

export default function Home() {
  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '4rem 1.5rem' }}>
      <header style={{ marginBottom: '4rem' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(2.5rem, 5vw, 4rem)',
          margin: '0 0 0.75rem',
          lineHeight: 1.1,
        }}>
          Dave's World
        </h1>
        <p style={{
          fontSize: '1.2rem',
          color: 'var(--color-text-muted)',
          margin: 0,
          fontFamily: 'var(--font-body)',
        }}>
          Dave's World, Dave's World. Vibe coding time, excellent.
        </p>
        <div style={{
          marginTop: '1.5rem',
          width: '3rem',
          height: '3px',
          background: 'var(--color-accent)',
          borderRadius: '2px',
        }} />
      </header>

      <main>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1.5rem',
        }}>
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      </main>

    </div>
  );
}

function ProjectCard({ project }) {
  const cardStyle = {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '12px',
    padding: '1.75rem',
    borderLeft: '4px solid var(--color-accent)',
    transition: 'transform 0.15s, box-shadow 0.15s',
    opacity: project.comingSoon ? 0.6 : 1,
    position: 'relative',
  };

  const inner = (
    <div
      style={cardStyle}
      onMouseEnter={e => {
        if (!project.comingSoon) {
          e.currentTarget.style.transform = 'translateY(-3px)';
          e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.08)';
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>{project.emoji}</div>
      <h2 style={{
        fontFamily: 'var(--font-display)',
        fontSize: '1.3rem',
        margin: '0 0 0.5rem',
      }}>
        {project.title}
      </h2>
      <p style={{
        color: 'var(--color-text-muted)',
        fontSize: '0.95rem',
        margin: '0 0 1.25rem',
        lineHeight: 1.5,
      }}>
        {project.description}
      </p>
      {project.comingSoon ? (
        <span style={{
          fontSize: '0.8rem',
          color: 'var(--color-text-muted)',
          fontStyle: 'italic',
        }}>
          Coming soon
        </span>
      ) : (
        <span style={{
          fontSize: '0.9rem',
          color: 'var(--color-accent)',
          fontWeight: 500,
        }}>
          Explore →
        </span>
      )}
    </div>
  );

  if (project.comingSoon) return inner;
  return <Link to={project.route} style={{ textDecoration: 'none' }}>{inner}</Link>;
}

