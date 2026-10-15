import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import './select.css';

type Props = {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
};

export default function ConperaSelect({ label, value, options, onChange, disabled = false, className = '' }: Props) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState({ above: false, maxHeight: 280 });
  const selectedIndex = options.findIndex(option => option.value === value);
  const unavailable = disabled || options.length === 0;
  const visible = open && !unavailable;

  useEffect(() => {
    if (visible) {
      setMenuMounted(true);
      return;
    }
    // Keep the closing surface briefly, while removing it from interaction and accessibility.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMenuMounted(false);
      return;
    }
    const timeout = window.setTimeout(() => setMenuMounted(false), 180);
    return () => window.clearTimeout(timeout);
  }, [visible]);

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    let top = (viewport?.offsetTop ?? 0) + 10;
    let bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 10;
    const dialog = trigger.closest('dialog');
    if (dialog) {
      const bounds = dialog.getBoundingClientRect();
      top = Math.max(top, bounds.top + dialog.clientTop + 10);
      bottom = Math.min(bottom, bounds.top + dialog.clientTop + dialog.clientHeight - 10);
    }
    const below = Math.max(0, bottom - rect.bottom - 7);
    const above = Math.max(0, rect.top - top - 7);
    if (rect.bottom <= top || rect.top >= bottom || Math.max(above, below) < 24) {
      setOpen(false);
      return;
    }
    const desired = Math.min(280, options.length * 36 + 8);
    const opensAbove = below < desired && above > below;
    setPlacement({ above: opensAbove, maxHeight: Math.min(280, opensAbove ? above : below) });
  }, [options.length]);

  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);

  useEffect(() => {
    setActiveIndex(index => Math.max(0, Math.min(index, options.length - 1)));
  }, [options.length]);

  useLayoutEffect(() => {
    if (!visible) return;
    positionMenu();
    const closeOutside = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const reposition = (event: Event) => {
      if (event.target === menuRef.current) return;
      positionMenu();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', reposition, true);
    window.visualViewport?.addEventListener('resize', positionMenu);
    window.visualViewport?.addEventListener('scroll', positionMenu);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', reposition, true);
      window.visualViewport?.removeEventListener('resize', positionMenu);
      window.visualViewport?.removeEventListener('scroll', positionMenu);
    };
  }, [visible, positionMenu]);

  useLayoutEffect(() => {
    if (!visible) return;
    const menu = menuRef.current;
    const option = menu?.children[activeIndex] as HTMLElement | undefined;
    if (!menu || !option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
  }, [visible, activeIndex, placement.maxHeight]);

  function openMenu(index = Math.max(0, selectedIndex)) {
    if (unavailable) return;
    setActiveIndex(index);
    setOpen(true);
  }

  function select(index: number) {
    const option = options[index];
    if (!option || unavailable) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (unavailable) return;
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Escape') {
      if (!visible) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Enter' || event.key === ' ') {
      if (visible) select(activeIndex);
      else openMenu();
    } else if (event.key === 'Home') {
      openMenu(0);
    } else if (event.key === 'End') {
      openMenu(options.length - 1);
    } else if (!visible) {
      openMenu(selectedIndex >= 0 ? selectedIndex : event.key === 'ArrowUp' ? options.length - 1 : 0);
    } else {
      setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    }
  }

  return <div className={`conpera-select ${visible ? 'is-open' : menuMounted ? 'is-closing' : ''} ${className}`} ref={rootRef} onKeyDown={handleKeyDown}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className="conpera-select-trigger" ref={triggerRef} role="combobox"
      aria-label={label} aria-haspopup="listbox" aria-expanded={visible} aria-controls={visible ? `${id}-listbox` : undefined}
      aria-activedescendant={visible ? `${id}-option-${activeIndex}` : undefined} disabled={unavailable}
      onClick={() => {
        // WebKit does not focus buttons on pointer click by default.
        triggerRef.current?.focus({ preventScroll: true });
        if (visible) setOpen(false);
        else openMenu();
      }}>
      <span className="conpera-select-value" key={value}>{options[selectedIndex]?.label ?? '—'}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {(visible || menuMounted) && <div className={`conpera-select-menu ${placement.above ? 'opens-above' : ''} ${visible ? 'is-entering' : 'is-leaving'}`} ref={menuRef}
      id={`${id}-listbox`} role="listbox" aria-label={label} aria-hidden={!visible} style={{ maxHeight: placement.maxHeight }}>
      {options.map((option, index) => <button type="button" key={option.value} id={`${id}-option-${index}`}
        role="option" aria-selected={option.value === value} tabIndex={-1} disabled={!visible}
        style={{ animationDelay: `${Math.min(index, 5) * 22}ms` }}
        className={`conpera-select-option ${option.value === value ? 'is-selected' : ''} ${activeIndex === index ? 'is-active' : ''}`}
        onPointerMove={() => setActiveIndex(index)} onPointerDown={event => event.preventDefault()} onClick={() => select(index)}>
        <span>{option.label}</span><Check size={15} aria-hidden="true" />
      </button>)}
    </div>}
  </div>;
}
