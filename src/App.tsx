import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, ArrowRight, ArrowLeftRight, Check, ChevronRight, CircleHelp, Coins, ExternalLink, KeyRound, LoaderCircle, LogOut, Plus, RefreshCw, RotateCcw, SquareTerminal, X } from 'lucide-react';
import ConperaSelect from './ConperaSelect';
import ChannelSelect, { isAdvancedChannel } from './ChannelSelect';
import { ClaudeMark, ConperaMark } from './BrandMarks';
import WelcomeScreen from './WelcomeScreen';
import { AccountMenu, AnimatedBalance, Presence, Toast, cardHover, reducedMotion } from './Motion';
import { isNative, edition, nativeCall, NativeError } from './native';

type Tool = 'codex' | 'claude';
type Mode = 'original' | 'conpera';
type DemoKey = { id: string; name: string; tool: Tool; channel: string; suffix: string };
type ToolState = { mode: Mode | 'conflict' | 'unavailable'; keyId: string };
type NativeStatus = { tools: Record<Tool, { mode: Mode | 'conflict'; keyId?: string }> };
type User = { name: string; email: string };
type Session = { user: User; expiresAt: string };
const AUTH_FALLBACK = 'conpera-switch-demo:pending-authorization';
const isMacApp = navigator.userAgent.includes('ConperaSwitchMac/');
type PendingAuthorization = { requestId: string; state: string; verifier: string; expiresAt: number };
function readPendingAuthorization(): PendingAuthorization | null {
  try { const value = JSON.parse(sessionStorage.getItem(AUTH_FALLBACK) || 'null'); if (value && value.expiresAt > Date.now() && typeof value.verifier === 'string') return value; } catch { /* Expired or malformed demo data. */ }
  sessionStorage.removeItem(AUTH_FALLBACK); return null;
}
const toolNames: Record<Tool, string> = { codex: 'Codex', claude: 'Claude Code' };
const initialKeys: DemoKey[] = [
  { id: 'codex-personal', name: '个人开发', tool: 'codex', channel: '标准渠道', suffix: '8f2a' },
  { id: 'codex-work', name: '工作项目', tool: 'codex', channel: '优先渠道', suffix: '9c4e' },
  { id: 'claude-personal', name: '个人开发', tool: 'claude', channel: '标准渠道', suffix: '3b7d' },
  { id: 'claude-work', name: '工作项目', tool: 'claude', channel: '优先渠道', suffix: '6a1f' },
];
const initialTools: Record<Tool, ToolState> = { codex: { mode: 'original', keyId: 'codex-personal' }, claude: { mode: 'original', keyId: 'claude-personal' } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
class ApiError extends Error { constructor(public status: number, message: string, public code = '') { super(message); } }
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (isNative) {
    try {
      if (path === '/session') return await nativeCall<T>(init.method === 'DELETE' ? 'logout' : 'session');
      if (path === '/balance') return await nativeCall<T>('balance');
      throw new ApiError(400, '当前客户端不支持此演示操作。');
    } catch (error) {
      if (error instanceof NativeError) throw new ApiError(error.status, error.message, error.code);
      throw error;
    }
  }
  const response = await fetch(`/api/demo${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers }, credentials: 'same-origin' });
  if (!response.ok) throw new ApiError(response.status, response.status === 401 ? '登录已过期，请重新连接账户。' : '暂时无法完成，请稍后再试。');
  return response.status === 204 ? undefined as T : response.json();
}
function readTools(): Record<Tool, ToolState> {
  if (isNative) return { codex: { mode: 'unavailable', keyId: '' }, claude: { mode: 'unavailable', keyId: '' } };
  try {
    const value = JSON.parse(localStorage.getItem('conpera-switch-demo:tools') || 'null');
    if (value && ['codex', 'claude'].every(t => ['original', 'conpera'].includes(value[t]?.mode))) {
      return Object.fromEntries((['codex', 'claude'] as Tool[]).map(t => [t, { mode: value[t].mode, keyId: initialKeys.some(k => k.tool === t && k.id === value[t].keyId) ? value[t].keyId : initialTools[t].keyId }])) as Record<Tool, ToolState>;
    }
  } catch { /* Discard stale demo data. */ }
  return initialTools;
}
function Wordmark() { return <span className="brand-lockup"><ConperaMark/><span className="wordmark">CONPERA</span></span>; }
function ToolIcon({ tool }: { tool: Tool }) {
  return <div className={`tool-icon ${tool}`} aria-hidden="true">{tool === 'codex' ? <SquareTerminal size={25} strokeWidth={1.7}/> : <ClaudeMark size={27}/>}</div>;
}
function Modal({ title, children, onClose, wide = false, exiting = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; exiting?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current!; el.showModal(); return () => el.close(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''} ${exiting ? 'is-exiting' : ''}`} inert={exiting || undefined} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}>
    <div className="modal-header"><Wordmark/><button className="icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={18} /></button></div>
    <h2>{title}</h2>{children}
  </dialog>;
}

function Authorization() {
  const requestId = new URLSearchParams(location.search).get('request');
  const [request, setRequest] = useState<{ account: User; state: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!requestId) { setError('此授权链接无效，请回到客户端重新发起。'); return; }
    api<{ account: User; state: string }>(`/authorizations/${encodeURIComponent(requestId)}`).then(setRequest).catch(() => setError('授权请求已过期，请回到客户端重新发起。'));
  }, [requestId]);
  async function approve() {
    if (!request || busy) return;
    const pending = readPendingAuthorization();
    const sameTab = pending?.requestId === requestId && pending.state === request.state;
    if (!window.opener && !sameTab) { setError('请从 Conpera Switch 的登录按钮打开此页面。'); return; }
    setBusy(true); setError('');
    try {
      const result = await api<{ code: string; state: string }>(`/authorizations/${requestId}/approve`, { method: 'POST' });
      if (sameTab && pending) {
        if (result.state !== pending.state) throw new Error('授权信息不匹配，请重新连接。');
        await api('/session', { method: 'POST', body: JSON.stringify({ code: result.code, codeVerifier: pending.verifier }) });
        sessionStorage.removeItem(AUTH_FALLBACK);
      } else window.opener.postMessage({ type: 'conpera:authorized', ...result }, location.origin);
      setDone(true);
      setTimeout(() => sameTab ? location.replace('/') : window.close(), 900);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function cancel() {
    if (busy) return;
    if (requestId) await api(`/authorizations/${requestId}`, { method: 'DELETE' }).catch(() => {});
    if (readPendingAuthorization()?.requestId === requestId) { sessionStorage.removeItem(AUTH_FALLBACK); location.replace('/'); return; }
    window.opener?.postMessage({ type: 'conpera:cancelled', state: request?.state }, location.origin);
    window.close();
    setError('已取消授权，可以关闭此页面。');
  }
  return <main className="auth-page"><div className="auth-top"><Wordmark /><span className="demo-tag">本地授权演示</span></div><section className="auth-card">
    <h1>{done ? '已确认授权。' : '连接您的账户'}</h1>
    <p className="muted">{done ? '正在返回客户端，完成账户连接。' : '授权读取账户与余额。'}</p>
    {request && !done && <>
      <div className="permissions"><span className="eyebrow">此应用将获得</span><p><Check size={15} /> 读取账户基本信息</p><p><Check size={15} /> 查询余额</p></div>
      <p className="auth-note">演示账户 · 无需密码</p>
      <button className="button primary block" onClick={approve} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <>允许连接 <ArrowRight size={16} /></>}</button>
      <button className="button text-button block" onClick={cancel} disabled={busy}>取消</button></>}
    {!request && !error && <LoaderCircle className="spin" size={22} />}
    {done && <div className="auth-complete"><Check size={28} /><p>你可以关闭这个窗口。</p></div>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </section></main>;
}

function Dashboard() {
  const [welcomeVisible, setWelcomeVisible] = useState(true);
  const [welcomePhase, setWelcomePhase] = useState<'ready' | 'connected'>('ready');
  const welcomeRef = useRef(welcomeVisible);
  welcomeRef.current = welcomeVisible;
  const welcomeTimer = useRef<number>(undefined);
  useEffect(() => {
    const native = window as Window & { webkit?: { messageHandlers?: { windowLayout?: { postMessage: (layout: string) => void } } } };
    native.webkit?.messageHandlers?.windowLayout?.postMessage(welcomeVisible ? 'welcome' : 'dashboard');
  }, [welcomeVisible]);
  const [tools, setTools] = useState(readTools);
  const [keys, setKeys] = useState<DemoKey[]>(isNative ? [] : initialKeys);
  const [configurationError, setConfigurationError] = useState('');
  const nativeLoginLocked = useRef(false);
  const nativeLoginId = useRef(0);
  const [busy, setBusy] = useState<Tool | 'all' | null>(null);
  const [lastAction, setLastAction] = useState(() => Object.values(readTools()).some(t => t.mode === 'conpera') ? '已恢复上次的演示配置' : '原机配置已就绪');
  const [toast, setToast] = useState('');
  const [keyTool, setKeyTool] = useState<Tool | null>(null);
  const [newName, setNewName] = useState('');
  const [newChannel, setNewChannel] = useState('标准渠道');
  const [keyError, setKeyError] = useState('');
  const [help, setHelp] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'loading' | 'guest' | 'connected' | 'expired' | 'offline'>('loading');
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceCurrency, setBalanceCurrency] = useState<'CNY' | 'USD' | null>(isNative ? null : 'CNY');
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [balanceError, setBalanceError] = useState('');

  const [accountBusy, setAccountBusy] = useState(false);
  const authRef = useRef<{ popup: Window | null; state: string; verifier: string; requestId: string; phase: 'preparing' | 'waiting' | 'exchanging'; timer?: number } | null>(null);
  const sessionEpoch = useRef(0);
  const sessionReadId = useRef(0);
  const initializingSession = useRef(true);
  const balanceLocked = useRef<number | null>(null);
  const accountLocked = useRef(false);
  const toastTimer = useRef<number>(undefined);
  const switchLocked = useRef(false);
  const numActive = Object.values(tools).filter(t => t.mode === 'conpera').length;
  function notify(message: string) { setToast(message); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(''), 3600); }
  useEffect(() => { if (!isNative) localStorage.setItem('conpera-switch-demo:tools', JSON.stringify(tools)); }, [tools]);
  useEffect(() => () => { window.clearTimeout(toastTimer.current); window.clearTimeout(welcomeTimer.current); }, []);
  function expireSession(message = '') { if (message) { setLoginError(message); setConfigurationError(message); } sessionEpoch.current++; if (isNative) { setKeys([]); setBalanceCurrency(null); } setSession(null); setSessionStatus('expired'); setBalance(null); setBalanceError(''); setBalanceBusy(false); }
  async function loadSession(initial = false) {
    if (authRef.current || nativeLoginLocked.current || accountLocked.current) return;
    const epoch = sessionEpoch.current; const readId = ++sessionReadId.current;
    const current = () => epoch === sessionEpoch.current && readId === sessionReadId.current;
    try { const next = await api<Session>('/session'); if (current()) { setSession(next); setSessionStatus('connected'); if (initializingSession.current) setWelcomeVisible(false); initializingSession.current = false; } }
    catch (err) { if (!current()) return; if (err instanceof ApiError && [401, 403].includes(err.status)) { sessionEpoch.current++; if (isNative) { setKeys([]); setBalanceCurrency(null); } if (err.status === 403) { setLoginError(err.message); setConfigurationError(err.message); } setBalanceBusy(false); setSession(null); setBalance(null); setSessionStatus(status => initial || status === 'guest' || status === 'loading' || status === 'offline' ? 'guest' : 'expired'); } else if (initializingSession.current) setSessionStatus('offline'); initializingSession.current = false; }
  }
  useEffect(() => { void loadSession(true); const focus = () => void loadSession(); window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, []);
  async function refreshBalance() {
    const epoch = sessionEpoch.current;
    if (balanceLocked.current === epoch || accountLocked.current) return;
    balanceLocked.current = epoch;
    setBalanceBusy(true); setBalanceError('');
    try { const data = await api<{ balance: number; updatedAt: string; currency?: 'CNY' | 'USD' }>('/balance'); if (epoch === sessionEpoch.current) { setBalance(data.balance); setBalanceCurrency(data.currency || (isNative ? null : 'CNY')); } }
    catch (err) { if (epoch !== sessionEpoch.current) return; if (err instanceof ApiError && [401, 403].includes(err.status)) expireSession(err.status === 403 ? err.message : ''); else setBalanceError('余额暂不可用，请重试'); }
    finally { if (balanceLocked.current === epoch) balanceLocked.current = null; if (epoch === sessionEpoch.current) setBalanceBusy(false); }
  }
  useEffect(() => { if (session) void refreshBalance(); }, [session?.user.email]);
  function adoptStatus(status: NativeStatus, available?: DemoKey[]) {
    setTools(previous => Object.fromEntries((['codex', 'claude'] as Tool[]).map(tool => {
      const current = status.tools[tool];
      const candidates = available?.filter(k => k.tool === tool);
      const keyId = current.keyId || (current.mode === 'original' && candidates
        ? candidates.find(k => k.id === previous[tool].keyId)?.id || candidates.find(k => !isAdvancedChannel(k.channel))?.id || candidates[0]?.id
        : previous[tool].keyId) || '';
      return [tool, { mode: current.mode, keyId }];
    })) as Record<Tool, ToolState>);
  }
  useEffect(() => {
    if (!isNative || !session) return;
    const epoch = sessionEpoch.current;
    let cancelled = false;
    setConfigurationError('');
    Promise.allSettled([nativeCall<{ keys: DemoKey[] }>('keys'), nativeCall<NativeStatus>('status')]).then(([keyResult, statusResult]) => {
      if (cancelled || epoch !== sessionEpoch.current) return;
      if (statusResult.status === 'fulfilled') adoptStatus(statusResult.value, keyResult.status === 'fulfilled' ? keyResult.value.keys : undefined);
      if (keyResult.status === 'fulfilled') setKeys(keyResult.value.keys);
      const errors = [keyResult, statusResult].filter(result => result.status === 'rejected').map(result => result.reason as Error);
      const denied = errors.find(error => error instanceof NativeError && [401, 403].includes(error.status));
      if (denied) expireSession(denied.message);
      if (errors.length) setConfigurationError(errors.map(error => error.message || '无法读取配置与密钥，请重新连接。').join(' '));
    });
    return () => { cancelled = true; };
  }, [session?.user.email]);
  function cleanupAuth(cancel: boolean) {
    const current = authRef.current;
    if (current) { window.clearInterval(current.timer); current.popup?.close(); if (cancel && current.requestId) void api(`/authorizations/${current.requestId}`, { method: 'DELETE' }).catch(() => {}); }
    authRef.current = null; setLoginBusy(false);
  }
  function closeLogin() {
    if (isNative) { nativeLoginId.current++; nativeLoginLocked.current = false; void nativeCall('cancelLogin').catch(() => {}); setLoginBusy(false); setLoginOpen(false); setLoginError(''); return; }
    if (authRef.current?.phase === 'exchanging') { setLoginError('正在完成连接，请稍候。连接后可从账户菜单退出。'); return; }
    cleanupAuth(true); setLoginOpen(false); setLoginError('');
  }
  function continueHere() {
    const current = authRef.current;
    if (!current || current.phase !== 'waiting') return;
    sessionStorage.setItem(AUTH_FALLBACK, JSON.stringify({ requestId: current.requestId, state: current.state, verifier: current.verifier, expiresAt: Date.now() + 300_000 }));
    window.clearInterval(current.timer); current.popup?.close(); authRef.current = null;
    location.assign(`/authorize?request=${encodeURIComponent(current.requestId)}`);
  }
  async function startLogin() {
    if (isNative) {
      if (nativeLoginLocked.current || accountLocked.current) return;
      nativeLoginLocked.current = true;
      const attempt = ++nativeLoginId.current;
      sessionEpoch.current++; setLoginBusy(true); setLoginError('');
      try {
        const next = await nativeCall<Session>('login');
        if (attempt !== nativeLoginId.current) return;
        sessionEpoch.current++; setSession(next); setSessionStatus('connected'); setLoginOpen(false);
        if (welcomeRef.current) {
          setWelcomePhase('connected');
          welcomeTimer.current = window.setTimeout(() => { setWelcomeVisible(false); setWelcomePhase('ready'); }, reducedMotion() ? 0 : 950);
        } else notify('账户已连接');
      } catch (error) {
        if (attempt === nativeLoginId.current) setLoginError((error as Error).message || '连接失败，请重试。');
      } finally {
        if (attempt === nativeLoginId.current) { nativeLoginLocked.current = false; setLoginBusy(false); }
      }
      return;
    }
    if (loginBusy || authRef.current || accountLocked.current) return;
    setLoginBusy(true); setLoginError('');
    const popup = window.open('about:blank', 'conpera-authorization', 'popup,width=480,height=460');
    if (!popup) { setLoginBusy(false); setLoginError('授权窗口被拦截。请允许弹出窗口后重试。'); return; }
    const attempt = { popup, verifier: '', state: '', requestId: '', phase: 'preparing' as 'preparing' | 'waiting' | 'exchanging', timer: undefined as number | undefined };
    authRef.current = attempt;
    sessionEpoch.current++;
    try {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
      const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      if (authRef.current !== attempt) return;
      if (popup.closed) { cleanupAuth(true); setLoginError('授权窗口已关闭，可以重新连接。'); return; }
      const { requestId, authorizationUrl } = await api<{ requestId: string; authorizationUrl: string }>('/authorizations', { method: 'POST', body: JSON.stringify({ codeChallenge: base64url(new Uint8Array(digest)), state }) });
      if (authRef.current !== attempt || popup.closed) { await api(`/authorizations/${requestId}`, { method: 'DELETE' }); if (authRef.current === attempt) cleanupAuth(true); return; }
      Object.assign(attempt, { verifier, state, requestId, phase: 'waiting' });
      popup.location.href = authorizationUrl;
      const start = Date.now();
      authRef.current.timer = window.setInterval(() => {
        if (!authRef.current) return;
        if (popup.closed || Date.now() - start > 300_000) { cleanupAuth(true); setLoginError(popup.closed ? '授权窗口已关闭，可以重新连接。' : '授权请求已过期，请重试。'); }
      }, 500);
    } catch (err) { popup.close(); if (authRef.current === attempt) { cleanupAuth(true); setLoginError((err as Error).message); } }
  }
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      const current = authRef.current;
      if (!current || event.origin !== location.origin || event.source !== current.popup || !event.data || event.data.state !== current.state) return;
      if (event.data.type === 'conpera:cancelled') { cleanupAuth(true); setLoginError('你已取消连接。'); return; }
      if (event.data.type !== 'conpera:authorized' || typeof event.data.code !== 'string' || current.phase !== 'waiting') return;
      window.clearInterval(current.timer); current.phase = 'exchanging';
      try {
        const next = await api<Session>('/session', { method: 'POST', body: JSON.stringify({ code: event.data.code, codeVerifier: current.verifier }) });
        sessionEpoch.current++; setSession(next); setSessionStatus('connected'); setLoginOpen(false); setLoginBusy(false); setLoginError('');
        if (welcomeRef.current) {
          setWelcomePhase('connected');
          welcomeTimer.current = window.setTimeout(() => { setWelcomeVisible(false); setWelcomePhase('ready'); }, reducedMotion() ? 0 : 950);
        } else notify('演示账户已连接');
      } catch (err) { setLoginBusy(false); setLoginError((err as Error).message); }
      authRef.current = null;
      current.popup?.close();
    };
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); };
  }, []);
  useEffect(() => () => { const current = authRef.current; if (current) { window.clearInterval(current.timer); current.popup?.close(); } }, []);
  async function switchMode(target: Tool | 'all', mode: Mode) {
    if (switchLocked.current) return;
    switchLocked.current = true; setBusy(target);
    if (isNative) {
      setConfigurationError('');
      let completed = 0;
      try {
        for (const tool of (target === 'all' ? ['codex', 'claude'] : [target]) as Tool[]) {
          if (mode === 'conpera') {
            if (!session || !keys.some(k => k.tool === tool && k.id === tools[tool].keyId)) throw new Error('请先为工具选择当前账户的可用密钥。');
            await nativeCall('apply', { tool, keyId: tools[tool].keyId });
          } else await nativeCall('restore', { tool });
          completed++;
        }
        notify(mode === 'conpera' ? '配置已写入并核验，请重启对应客户端。' : '原机配置已恢复。');
      } catch (error) { setConfigurationError(`${completed ? '部分工具已完成，请按下方实际状态检查。' : ''}${(error as Error).message || '配置操作未完成。'}`); if (error instanceof NativeError && [401, 403].includes(error.status)) expireSession(error.status === 403 ? error.message : ''); }
      finally {
        try { adoptStatus(await nativeCall<NativeStatus>('status')); } catch { setConfigurationError('无法核验本机配置状态，请重试。'); }
        setBusy(null); switchLocked.current = false;
      }
      return;
    }
    await sleep(550);
    setTools(previous => {
      const next = { ...previous };
      for (const t of (target === 'all' ? ['codex', 'claude'] : [target]) as Tool[]) next[t] = { ...previous[t], mode };
      return next;
    });
    const label = target === 'all' ? '全部工具' : toolNames[target];
    const action = mode === 'conpera' ? `${label}已切换至 Conpera` : `${label}已恢复原机配置`;
    setLastAction(action); notify(`${action} · 演示`); setBusy(null); switchLocked.current = false;
  }
  async function selectKey(tool: Tool, keyId: string) {
    if (tools[tool].keyId === keyId) return;
    if (isNative) {
      if (switchLocked.current || tools[tool].mode === 'unavailable' || !keys.some(k => k.tool === tool && k.id === keyId)) return;
      if (tools[tool].mode === 'original') { setTools(previous => ({ ...previous, [tool]: { ...previous[tool], keyId } })); return; }
      switchLocked.current = true; setBusy(tool); setConfigurationError('');
      try { await nativeCall('apply', { tool, keyId }); adoptStatus(await nativeCall<NativeStatus>('status')); notify('新密钥配置已写入，请重启对应客户端。'); }
      catch (error) { setConfigurationError((error as Error).message || '密钥切换未完成。'); }
      finally { try { adoptStatus(await nativeCall<NativeStatus>('status')); } catch { setConfigurationError('无法核验本机配置状态，请重试。'); } switchLocked.current = false; setBusy(null); }
      return;
    }
    setTools(previous => ({ ...previous, [tool]: { ...previous[tool], keyId } }));
    const selected = keys.find(k => k.id === keyId)!;
    setLastAction(`${toolNames[tool]} · ${selected.channel} / ${selected.name}`);
    notify(tools[tool].mode === 'conpera' ? `${selected.name}已应用 · 演示` : `${selected.name}已选好，启用 Conpera 后应用`);
  }
  function addKey() {
    const name = newName.trim();
    if (!name) { setKeyError('请输入一个便于识别的密钥名称。'); return; }
    if (!keyTool) return;
    const item: DemoKey = { id: crypto.randomUUID(), name: name.slice(0, 24), tool: keyTool, channel: newChannel, suffix: base64url(crypto.getRandomValues(new Uint8Array(3))).toLowerCase() };
    setKeys(current => [...current, item]);
    setTools(current => ({ ...current, [keyTool]: { ...current[keyTool], keyId: item.id } }));
    setNewName(''); setKeyError(''); notify('演示密钥已添加并选中');
  }
  async function logout(expire = false) {
    if (accountLocked.current || authRef.current || nativeLoginLocked.current || busy) return;
    accountLocked.current = true; sessionEpoch.current++; setBalanceBusy(false); balanceLocked.current = null;
    setAccountBusy(true);
    try { await api(expire ? '/session/expire' : '/session', { method: expire ? 'POST' : 'DELETE' }); setSession(null); if (isNative) { setKeys([]); setBalanceCurrency(null); setTools(readTools()); setConfigurationError(''); } setSessionStatus(expire ? 'expired' : 'guest'); setBalance(null); setBalanceError(''); if (expire) notify('已模拟登录过期'); else { setWelcomePhase('ready'); setLoginError(''); setWelcomeVisible(true); } }
    catch (error) { if (isNative && error instanceof ApiError && error.code === 'logout_remote_unconfirmed') { setSession(null); setKeys([]); setBalanceCurrency(null); setTools(readTools()); setBalance(null); setSessionStatus('guest'); setWelcomePhase('ready'); setWelcomeVisible(true); setLoginError((error as Error).message || '本机已退出，远端撤销未完成。'); } else notify((error as Error).message || '暂时无法退出，请重试'); } finally { accountLocked.current = false; setAccountBusy(false); }
  }
  return <>
    {welcomeVisible ? sessionStatus === 'loading' ? <main className="startup-screen" aria-label="正在载入 Conpera"><Wordmark/><span className="startup-line"/></main> : <WelcomeScreen phase={loginBusy ? 'connecting' : welcomePhase} error={loginError || (sessionStatus === 'offline' ? '账户服务暂不可用，请重试。' : '')} onLogin={() => void startLogin()} onCancel={closeLogin} onContinueHere={isNative ? undefined : continueHere} edition={edition}/> : <div className="app-shell view-enter">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Conpera Switch 首页"><Wordmark/><span className="product-name">Switch</span></a>
      <div className="topbar-actions">
        <span className="demo-tag" title={isNative ? 'Conpera Switch · 连接您的账户' : '仅演示，不读取或修改本机配置'}>{edition}</span>
        <button className="icon-button" aria-label={numActive === 2 ? '全部恢复原机' : '全部启用 Conpera'} title={numActive === 2 ? '全部恢复原机' : '全部启用 Conpera'} onClick={() => void switchMode('all', numActive === 2 ? 'original' : 'conpera')} disabled={!!busy || (isNative && numActive !== 2 && (!session || Object.values(tools).some(t => t.mode === 'unavailable')))}>{busy === 'all' ? <LoaderCircle className="spin" size={18}/> : <ArrowLeftRight size={18}/>}</button>
        <button className="icon-button" aria-label={isNative ? '关于 Conpera Switch' : '关于此演示'} title={isNative ? '使用说明' : '演示说明'} onClick={() => setHelp(true)}><CircleHelp size={18}/></button>
      </div>
    </header>
    <main className="workspace">
      <section className="tools-panel" aria-label="工具配置切换">
        {(['codex', 'claude'] as Tool[]).map(tool => {
          const state = tools[tool]; const active = state.mode === 'conpera'; const selected = keys.find(k => k.id === state.keyId) || (isNative ? { id: '', suffix: '—', name: '暂无可用密钥', channel: '' } : initialKeys.find(k => k.tool === tool)!);
          const waiting = busy === tool || busy === 'all';
          return <article className={`tool-card ${active ? 'is-active' : ''} ${waiting ? 'is-busy' : ''}`} key={tool} aria-busy={waiting} data-testid={`tool-${tool}`} {...cardHover}>
            <div className="card-top"><ToolIcon tool={tool}/><span className={`status ${active ? 'active' : ''}`} title={waiting ? '切换中' : active ? 'Conpera 已启用' : state.mode === 'conflict' ? '配置已在外部修改' : state.mode === 'unavailable' ? '配置未读取' : '原机配置'}>{waiting ? <LoaderCircle className="spin" size={14}/> : <i/>}<span className="sr-only">{waiting ? '切换中' : active ? 'Conpera 已启用' : state.mode === 'conflict' ? '配置已在外部修改' : state.mode === 'unavailable' ? '配置未读取' : '原机配置'}</span></span></div>
            <h2 className="card-title">{toolNames[tool]}</h2>
            <div className={`switch-track ${active ? 'at-conpera' : state.mode === 'original' ? 'at-original' : 'at-unknown'}`} aria-label={`${toolNames[tool]} 配置来源`}>
              <span className="switch-thumb" aria-hidden="true"/>
              <button aria-label="原机配置" aria-pressed={state.mode === 'original'} disabled={!!busy} onClick={() => state.mode === 'original' || void switchMode(tool, 'original')} className={state.mode === 'original' ? 'selected' : ''}>原机{state.mode === 'original' && <Check size={13}/>}</button>
              <button aria-label="Conpera" aria-pressed={active} disabled={!!busy || (isNative && (!session || !selected.id || state.mode === 'unavailable'))} onClick={() => active || void switchMode(tool, 'conpera')} className={active ? 'selected conpera-selected' : ''}>Conpera{active && <Check size={13}/>}</button>
            </div>
            <ChannelSelect label={toolNames[tool]} value={selected.channel} channels={keys.filter(k => k.tool === tool).map(k => k.channel)}
              disabled={!!busy || (isNative && (!session || state.mode === 'unavailable'))}
              onChange={channel => {
                const key = keys.find(k => k.tool === tool && k.channel === channel && k.id === selected.id)
                  || keys.find(k => k.tool === tool && k.channel === channel);
                if (key) void selectKey(tool, key.id);
              }}/>
            <div className="key-selection"><KeyRound size={16} aria-hidden="true"/>
              <ConperaSelect className="key-select" label={`${toolNames[tool]} 密钥`} value={selected.id}
                disabled={!!busy || (isNative && (!session || state.mode === 'unavailable'))}
                options={keys.filter(k => k.tool === tool && k.channel === selected.channel).map(k => ({ value: k.id, label: `${k.name} · ${k.suffix}` }))}
                onChange={keyId => void selectKey(tool, keyId)}/>
              <button className="icon-button key-manage" onClick={() => { setKeyTool(tool); setKeyError(''); }} aria-label={`管理 ${toolNames[tool]} 密钥`} title="查看密钥详情"><ChevronRight size={17}/></button>
            </div>
          </article>;
        })}
      </section>
      <aside className={`account-panel ${balanceBusy ? 'is-refreshing' : ''}`} {...cardHover}>
        <div className="card-top"><Coins size={25} strokeWidth={1.7}/>{session && <button className="icon-button" onClick={() => void refreshBalance()} disabled={balanceBusy} aria-label="刷新余额" title="刷新余额"><RefreshCw className={balanceBusy ? 'spin' : ''} size={16}/></button>}</div>
        <h2 className="card-title">余额</h2>
        <div className={`balance-number ${!session ? 'empty' : ''}`}><span className="currency" aria-label={balanceCurrency || undefined}>{balanceCurrency === 'USD' ? '$' : balanceCurrency === 'CNY' ? '¥' : ''}</span><AnimatedBalance value={session ? balance : null} currency={balanceCurrency}/></div>
        {session ? <>
          {balanceError && <p className="error-text" role="alert">{balanceError}</p>}
          <div className="account-footer">
            <AccountMenu email={session.user.email}><p className="menu-caption">{session.user.name}</p>{isNative && <p className="menu-caption">退出后保留客户端配置</p>}{!isNative && <button onClick={() => void logout(true)} disabled={accountBusy}><RotateCcw size={14}/>模拟登录过期</button>}</AccountMenu>
            <button className="account-logout" aria-label="退出登录" aria-busy={accountBusy} title={isNative ? '退出登录，保留已应用的客户端配置' : '退出登录'} onClick={() => void logout()} disabled={accountBusy || !!busy}>{accountBusy ? <LoaderCircle className="spin" size={14}/> : <LogOut size={14}/>}<span>{accountBusy ? '退出中…' : '退出登录'}</span></button>
          </div>
        </> : <>
          {sessionStatus === 'expired' && <p className="session-warning" role="status">登录已过期</p>}
          {sessionStatus === 'offline' && <p className="session-warning" role="status">账户服务暂不可用</p>}
          <button className="login-link" onClick={() => { setLoginError(''); setLoginOpen(true); }} aria-label={sessionStatus === 'expired' ? '重新连接账户' : '登录 Conpera'} disabled={sessionStatus === 'loading'}>{sessionStatus === 'loading' ? <LoaderCircle className="spin" size={16}/> : <><span>{sessionStatus === 'expired' ? '重新登录' : '登录'}</span><ArrowUpRight size={18}/></>}</button>
        </>}
      </aside>
    </main>
    {configurationError && <p className="configuration-notice" role="alert">{configurationError}</p>}
    {isNative && Object.values(tools).some(tool => tool.mode === 'conflict') && <p className="configuration-notice" role="alert">检测到外部配置修改，已暂停覆盖。原机备份仍保留。</p>}
    <p className="sr-only" role="status">{lastAction}</p>
    </div>}
    <Presence visible={!!toast && !welcomeVisible}><Toast message={toast}/></Presence>
    <Presence visible={loginOpen}><Modal title="登录 Conpera" onClose={closeLogin}>
      <p className="modal-copy">{isNative ? '在系统浏览器中登录 Conpera，连接账户与密钥。' : '登录后查看余额。'}</p>
      {loginError && <p className="error-text" role="alert">{loginError}</p>}
      <button className="button primary block" disabled={loginBusy} onClick={() => void startLogin()}>{loginBusy ? <><LoaderCircle className="spin" size={16}/>等待授权</> : <>{isNative ? '在系统浏览器中继续' : isMacApp ? '打开授权窗口' : '在浏览器中继续'}<ExternalLink size={15}/></>}</button>
      {loginBusy && !isNative && <button className="button text-button block" onClick={continueHere}>授权窗口未出现？在此继续<ArrowUpRight size={14}/></button>}
      {!isNative && <p className="modal-footnote">演示账户 · 无需密码</p>}
    </Modal></Presence>
    <Presence visible={!!keyTool}>{keyTool && <Modal title={`${toolNames[keyTool]} · 密钥`} onClose={() => setKeyTool(null)} wide>
      <div className="key-list">{keys.filter(k => k.tool === keyTool && (!keys.some(item => item.id === tools[keyTool].keyId) || k.channel === keys.find(item => item.id === tools[keyTool].keyId)?.channel)).map(k => <button className={`key-item ${tools[keyTool].keyId === k.id ? 'chosen' : ''}`} key={k.id} onClick={() => selectKey(keyTool, k.id)}><KeyRound size={18}/><span><strong>{k.name}</strong><small>{k.channel} <span>· ···· {k.suffix}</span></small></span>{tools[keyTool].keyId === k.id ? <Check size={17}/> : <ArrowRight size={17}/>}</button>)}</div>
      {!isNative && <form className="add-key" onSubmit={e => { e.preventDefault(); addKey(); }}><div className="add-key-fields"><label>名称<input value={newName} maxLength={24} onChange={e => { setNewName(e.target.value); setKeyError(''); }} placeholder="新密钥"/></label><div className="field"><span>渠道</span><ConperaSelect className="form-select" label="新密钥渠道" value={newChannel} onChange={setNewChannel} options={['标准渠道', '优先渠道'].map(channel => ({ value: channel, label: channel }))}/></div></div>{keyError && <p role="alert" className="error-text">{keyError}</p>}<button type="submit" className="button block">添加并选择<Plus size={14}/></button></form>}
      <p className="modal-footnote">{isNative ? '密钥从当前账户同步，仅显示尾号；可在 Conpera 网站管理。' : '仅演示，不接收真实 API Key。'}</p>
    </Modal>}</Presence>
    <Presence visible={help}><Modal title={isNative ? '使用说明' : '演示说明'} onClose={() => setHelp(false)}><p className="modal-copy">{isNative ? <>连接您的 Conpera 账户，选择本人密钥。<br/>切换前保存原机备份，写入后请重启对应客户端。<br/>检测到外部修改时会停止覆盖。退出登录后可从应用菜单恢复原机配置。</> : <>配置、密钥和余额均为演示数据。<br/>不会读取或修改本机配置。</>}</p><button className="button primary block" onClick={() => setHelp(false)}>知道了<Check size={15}/></button></Modal></Presence>
  </>;
}
export default function App() { return location.pathname === '/authorize' ? <Authorization/> : <Dashboard/>; }
