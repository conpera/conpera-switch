import { useRef, useState } from 'react';
import { Download, LoaderCircle, X } from 'lucide-react';
import { isBeta, isNative, nativeCall } from './native';
import './update.css';

export default function UpdateButton({ version, disabled = false }: { version?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  if (!isNative || isBeta) return version ? <span className="welcome-edition">{version}</span> : null;
  async function check() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await nativeCall('checkForUpdates'); }
    catch (error) { setError((error as Error).message || '无法检查更新，请稍后重试。'); }
    finally { locked.current = false; setBusy(false); }
  }
  return <div className="update-control">
    <button className={`update-button ${version ? 'with-version' : ''}`} aria-label="检查更新" title="检查 Conpera Switch 更新" disabled={disabled || busy} onClick={() => void check()}>
      {version && <span>{version}</span>}{busy ? <LoaderCircle size={13} className="spin"/> : <Download size={13}/>}<span>检查更新</span>
    </button>
    {error && <div className="update-error" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭更新提示" onClick={() => setError('')}><X size={13}/></button></div>}
  </div>;
}
