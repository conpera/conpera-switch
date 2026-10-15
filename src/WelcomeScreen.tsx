import { ArrowRight, ArrowUpRight, Check, LoaderCircle } from 'lucide-react';
import { ConperaMark } from './BrandMarks';
import './welcome.css';

type WelcomeScreenProps = {
  phase: 'ready' | 'connecting' | 'connected';
  error: string;
  onLogin: () => void;
  onCancel: () => void;
  onContinueHere?: () => void;
  edition?: 'DEMO' | 'BETA';
};

export default function WelcomeScreen({ phase, error, onLogin, onCancel, onContinueHere, edition = 'DEMO' }: WelcomeScreenProps) {
  const connecting = phase === 'connecting';
  const connected = phase === 'connected';

  return <div className="welcome-stage"><main className={`welcome-screen is-${phase}`} aria-busy={connecting} aria-labelledby="welcome-heading">
    <div className="welcome-grid">
      <header className="welcome-topbar"><span className="welcome-brand"><ConperaMark size={28}/><span>CONPERA SWITCH</span></span><span className="welcome-edition">{edition}</span></header>
      <h1 id="welcome-heading"><span>欢迎使用</span><strong>conpera switch</strong></h1>
      <div className="welcome-actions">
        {error && <p className="welcome-error" role="alert">{error}</p>}
        <button className="welcome-primary" aria-label="登录 Conpera" onClick={onLogin} disabled={connecting || connected}>
          <span className="welcome-button-content" key={phase}>
            {connecting ? <><span>等待授权</span><LoaderCircle className="welcome-spinner" size={18}/></> : connected ? <><span>已连接</span><Check size={19}/></> : <><span>登录</span><ArrowRight size={19}/></>}
          </span>
        </button>
        <div className="welcome-secondary" aria-live="polite">
          {connecting && <><button className="welcome-cancel" onClick={onCancel}>取消连接</button>{onContinueHere && <button className="welcome-fallback" onClick={onContinueHere}>在此继续<ArrowUpRight size={12}/></button>}</>}
          {connected && <span>正在进入工作台</span>}
        </div>
      </div>
    </div>
  </main></div>;
}
