import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, RotateCcw, X } from 'lucide-react';
import { ClaudeMark, CodexMark } from './BrandMarks';
import { nativeCall } from './native';
import './configuration.css';

type Tool = 'codex' | 'claude';
type Fields = Record<string, string>;
type Preview = { content: string; fields: Fields };
type Details = Preview & { revision: string; mode: 'original' | 'conpera' | 'conflict'; canUndo: boolean };
type Props = { tool: Tool; onClose: () => void; onSaved: () => void };

export default function ConfigurationEditor({ tool, onClose, onSaved }: Props) {
  const name = tool === 'codex' ? 'Codex' : 'Claude Code';
  const [details, setDetails] = useState<Details | null>(null);
  const [content, setContent] = useState('');
  const [fields, setFields] = useState<Fields>({});
  const [parsed, setParsed] = useState<Fields>({});
  const [view, setView] = useState<'form' | 'raw'>('form');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'close' | 'reload' | 'undo' | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const locked = useRef(false);
  const alive = useRef(true);
  const dirty = !!details && (content !== details.content || Object.keys(fields).some(key => fields[key] !== parsed[key]));

  function adopt(next: Details) {
    setDetails(next); setContent(next.content); setFields(next.fields); setParsed(next.fields);
  }
  async function run(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (error) { if (alive.current) setError((error as Error).message || '配置操作未完成，请重试。'); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function read() {
    await run(async () => {
      const next = await nativeCall<Details>('configurationDetails', { tool });
      if (alive.current) adopt(next);
    });
  }
  useEffect(() => {
    alive.current = true;
    const el = dialog.current!; el.showModal();
    void read();
    return () => { alive.current = false; el.close(); };
  }, []);

  async function prepare(): Promise<Preview> {
    const updates = view === 'form' ? Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== parsed[key])) : {};
    return nativeCall<Preview>('previewConfiguration', { tool, content, updates });
  }
  function switchView(next: 'form' | 'raw') {
    if (view === next || busy) return;
    void run(async () => {
      const prepared = await prepare();
      if (alive.current) { setContent(prepared.content); setFields(prepared.fields); setParsed(prepared.fields); setView(next); }
    });
  }
  function save() {
    if (!details) return;
    void run(async () => {
      const prepared = await prepare();
      const next = await nativeCall<Details>('saveConfiguration', { tool, revision: details.revision, content: prepared.content });
      if (alive.current) { adopt(next); setNotice('已保存并核验，请重启对应客户端。'); onSaved(); }
    });
  }
  function undo() {
    if (!details) return;
    void run(async () => {
      const next = await nativeCall<Details>('undoConfiguration', { tool, revision: details.revision });
      if (alive.current) { adopt(next); setNotice('已撤销上次保存，请重启对应客户端。'); onSaved(); }
    });
  }
  function request(action: 'close' | 'reload' | 'undo') {
    if (busy) return;
    if (dirty) { setConfirm(action); return; }
    execute(action);
  }
  function execute(action: 'close' | 'reload' | 'undo') {
    setConfirm(null);
    if (action === 'close') onClose();
    else if (action === 'reload') void read();
    else undo();
  }
  function change(key: string, value: string) {
    setFields(previous => ({ ...previous, [key]: value })); setNotice('');
  }
  function input(key: string, label: string, placeholder: string, numeric = false) {
    return <label className="configuration-field"><span>{label}</span><input value={fields[key] || ''} onChange={e => change(key, e.target.value)} placeholder={placeholder} inputMode={numeric ? 'numeric' : 'text'} maxLength={numeric ? 10 : 256} autoComplete="off" spellCheck={false}/></label>;
  }
  function select(key: string, label: string, options: [string, string][]) {
    const value = fields[key] || '';
    return <label className="configuration-field"><span>{label}</span><select aria-label={label} value={value} onChange={e => change(key, e.target.value)}><option value="">客户端默认</option>{value && !options.some(([id]) => id === value) && <option value={value}>{value}（当前值）</option>}{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>;
  }

  return <dialog ref={dialog} className="modal configuration-editor" aria-label={`${name} 配置细节`} aria-busy={busy} onCancel={e => { e.preventDefault(); request('close'); }}>
    <header className="configuration-header"><div className="configuration-heading">{tool === 'codex' ? <CodexMark size={28}/> : <ClaudeMark size={28}/>}<div><h2>{name} 配置</h2><p>{tool === 'codex' ? 'config.toml' : 'settings.json'} · 本机用户配置</p></div></div><button className="icon-button" aria-label="关闭配置" disabled={busy} onClick={() => request('close')}><X size={18}/></button></header>
    <div className="configuration-tabs" aria-label="编辑方式"><button type="button" aria-pressed={view === 'form'} onClick={() => switchView('form')} disabled={busy || !details}>常用设置</button><button type="button" aria-pressed={view === 'raw'} onClick={() => switchView('raw')} disabled={busy || !details}>配置原文 <span>{tool === 'codex' ? 'TOML' : 'JSON'}</span></button></div>
    {!details ? <div className="configuration-loading">{busy ? <><LoaderCircle className="spin" size={18}/>正在读取本机配置</> : <button className="button" onClick={() => void read()}><RefreshCw size={15}/>重新读取</button>}</div> : <>
      <fieldset disabled={busy || details.mode === 'conflict'} className="configuration-content">
        {view === 'form' ? <div className="configuration-fields">
          {input('model', '模型', '留空使用客户端默认模型')}
          {tool === 'codex' ? <>
            {select('model_reasoning_effort', '思考强度', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(value => [value, value]))}
            {input('model_context_window', '上下文窗口 · tokens', '使用模型默认值', true)}
            {input('model_auto_compact_token_limit', '自动压缩阈值 · tokens', '使用模型默认值', true)}
            {select('model_verbosity', '回答详细程度', [['low', '简洁'], ['medium', '适中'], ['high', '详细']])}
          </> : <>
            {select('alwaysThinkingEnabled', '扩展思考', [['true', '开启'], ['false', '关闭']])}
            {input('maxOutputTokens', '最大输出长度 · tokens', '使用模型默认值', true)}
          </>}
          <p className="configuration-hint">留空或选择默认会移除此项覆盖。可用模型、思考档位和 token 上限取决于渠道与客户端。{tool === 'claude' && '部分模型始终启用思考。'}</p>
        </div> : <><label className="sr-only" htmlFor="configuration-source">{name} 配置原文</label><textarea id="configuration-source" className="configuration-source" value={content} onChange={e => { setContent(e.target.value); setNotice(''); }} spellCheck={false} autoCapitalize="off" autoComplete="off" wrap="off"/><p className="configuration-hint">已隐藏可识别的密钥与敏感字段，请保留占位符。其他设置可直接编辑。</p></>}
      </fieldset>
      {details.mode === 'conflict' && <p className="error-text" role="alert">文件与 Conpera 备份记录存在冲突，已暂停覆盖。原机备份仍保留。</p>}
      {details.mode === 'conpera' && <p className="configuration-hint">当前使用 Conpera；连接与密钥由首页管理。「恢复原机」会恢复启用前的配置。</p>}
      <p className="configuration-hint">保存后请重启客户端。项目配置、环境变量或管理员设置可能覆盖这里的选择。</p>
    </>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {notice && <p className="configuration-success" role="status"><Check size={15}/>{notice}</p>}
    {confirm ? <div className="configuration-confirm" role="alert"><p>有尚未保存的修改，要放弃这些修改吗？</p><div><button className="button" onClick={() => setConfirm(null)}>继续编辑</button><button className="button primary" onClick={() => execute(confirm)}>放弃修改并继续</button></div></div> : <footer className="configuration-footer"><div><button className="button text-button" disabled={busy || !details?.canUndo} onClick={() => request('undo')}><RotateCcw size={14}/>撤销上次保存</button><button className="icon-button" title="重新读取配置" aria-label="重新读取配置" disabled={busy} onClick={() => request('reload')}><RefreshCw size={15}/></button></div><button className="button primary" disabled={busy || !dirty || details?.mode === 'conflict'} onClick={save}>{busy ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>}保存配置</button></footer>}
  </dialog>;
}
