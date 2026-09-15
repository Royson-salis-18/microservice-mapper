interface WelcomeScreenProps {
  onAddProject: () => void;
}

export function WelcomeScreen({ onAddProject }: WelcomeScreenProps) {
  return (
    <div style={{
      width: '100%',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'radial-gradient(circle at center, #1a1a2e 0%, #0f0f1a 100%)',
      fontFamily: 'var(--font-family)',
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Background decorations */}
      <div style={{
        position: 'absolute',
        width: '600px',
        height: '600px',
        background: 'radial-gradient(circle, rgba(0,212,255,0.05) 0%, transparent 70%)',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 1,
        pointerEvents: 'none'
      }} />

      <div style={{ zIndex: 2, textAlign: 'center', maxWidth: '600px' }}>
        <div style={{ 
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '64px',
          height: '64px',
          borderRadius: '16px',
          background: 'linear-gradient(135deg, var(--color-accent-cyan), var(--color-accent-blue))',
          boxShadow: '0 0 32px rgba(0,212,255,0.4)',
          color: '#fff',
          fontSize: '32px',
          marginBottom: '24px'
        }}>⎈</div>
        
        <h1 style={{ 
          fontSize: '32px', 
          fontWeight: 800, 
          color: '#fff', 
          letterSpacing: '2px',
          marginBottom: '16px',
          textShadow: '0 0 20px rgba(255,255,255,0.2)'
        }}>
          MICROSERVICE MAPPER
        </h1>
        
        <p style={{ 
          fontSize: '16px', 
          color: 'var(--color-text-muted)', 
          lineHeight: 1.6,
          marginBottom: '40px'
        }}>
          Your dynamic observability platform. Connect a remote environment via SSH to automatically discover, map, and analyze your microservice architecture in real-time.
        </p>

        <button 
          onClick={onAddProject}
          style={{
            background: 'linear-gradient(135deg, rgba(224,64,251,0.8), rgba(0,212,255,0.8))',
            border: '1px solid var(--color-accent-magenta)',
            color: '#fff',
            padding: '16px 32px',
            borderRadius: '30px',
            fontWeight: 700,
            fontSize: '14px',
            letterSpacing: '1px',
            cursor: 'pointer',
            boxShadow: '0 10px 30px rgba(224,64,251,0.3)',
            transition: 'all 0.3s ease',
            textTransform: 'uppercase'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 15px 40px rgba(224,64,251,0.5)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'none';
            e.currentTarget.style.boxShadow = '0 10px 30px rgba(224,64,251,0.3)';
          }}
        >
          <span>☁️</span> ADD YOUR FIRST AWS PROJECT
        </button>
      </div>

      <div style={{
        position: 'absolute',
        bottom: '32px',
        color: 'rgba(255,255,255,0.2)',
        fontSize: '12px',
        letterSpacing: '1px'
      }}>
        Zero Configuration Required • Autonomous SSH Discovery • Real-Time Telemetry
      </div>
    </div>
  );
}
