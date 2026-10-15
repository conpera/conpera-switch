import { cloneElement, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from 'react';
import { Check, ChevronDown, UserRound } from 'lucide-react';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function clearCardHover(event: ReactPointerEvent<HTMLElement>) {
  delete event.currentTarget.dataset.pixelHover;
  event.currentTarget.style.removeProperty('--card-hover-x');
  event.currentTarget.style.removeProperty('--card-hover-y');
}

// Match the website's card-wall dot mask without changing card geometry.
export const cardHover = {
  onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === 'touch' || reducedMotion() || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      clearCardHover(event);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * 100;
    const y = ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * 100;
    event.currentTarget.style.setProperty('--card-hover-x', `${x.toFixed(2)}%`);
    event.currentTarget.style.setProperty('--card-hover-y', `${y.toFixed(2)}%`);
    event.currentTarget.dataset.pixelHover = 'true';
  },
  onPointerLeave: clearCardHover,
  onPointerCancel: clearCardHover,
};

// Keep the last visible content mounted while its exit transition completes.
export function Presence({ visible, children }: { visible: boolean; children: ReactElement<{ exiting?: boolean }> | null | false }) {
  const [mounted, setMounted] = useState(visible);
  const latest = useRef(children);
  if (visible && children) latest.current = children;
  useEffect(() => {
    if (visible) { setMounted(true); return; }
    const timer = window.setTimeout(() => setMounted(false), reducedMotion() ? 0 : 200);
    return () => window.clearTimeout(timer);
  }, [visible]);
  return (visible || mounted) && latest.current ? cloneElement(latest.current, { exiting: !visible }) : null;
}

export function Toast({ message, exiting = false }: { message: string; exiting?: boolean }) {
  return <div className={`toast ${exiting ? 'is-exiting' : ''}`} role="status"><Check size={15}/><span key={message}>{message}</span></div>;
}

export function AnimatedBalance({ value, currency = 'CNY' }: { value: number | null; currency?: 'CNY' | 'USD' | null }) {
  const [display, setDisplay] = useState(value ?? 0);
  const last = useRef(value ?? 0);
  useEffect(() => {
    if (value === null) { last.current = 0; setDisplay(0); return; }
    if (reducedMotion()) { last.current = value; setDisplay(value); return; }
    const from = last.current;
    const start = performance.now();
    let frame: number;
    function update(now: number) {
      const progress = Math.min((now - start) / 850, 1);
      const next = from + (value! - from) * (1 - Math.pow(1 - progress, 4));
      last.current = next; setDisplay(next);
      if (progress < 1) frame = requestAnimationFrame(update);
    }
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <span className="balance-value" aria-label={value === null ? '余额暂不可用' : `余额 ${value.toFixed(2)}${currency === 'USD' ? ' 美元' : currency === 'CNY' ? ' 元' : ''}`}><span aria-hidden="true">{value === null ? '—' : display.toFixed(2)}</span></span>;
}

function AccountPopover({ children, exiting = false }: { children: ReactNode; exiting?: boolean }) {
  return <div className={`account-popover ${exiting ? 'is-exiting' : ''}`} inert={exiting || undefined}>{children}</div>;
}

export function AccountMenu({ email, children }: { email: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="account-menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button className="account-trigger" ref={trigger} aria-label="账户选项" title="账户选项" aria-expanded={open} onClick={() => setOpen(!open)}><UserRound size={15}/><span>{email}</span><ChevronDown size={15}/></button>
    <Presence visible={open}><AccountPopover><div onClick={() => setOpen(false)}>{children}</div></AccountPopover></Presence>
  </div>;
}
