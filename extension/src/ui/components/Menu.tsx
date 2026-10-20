/** Click-to-open menu with keyboard support (arrows, Home/End, Escape). */
import type { LucideIcon } from 'lucide-preact';
import { Check } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      description?: string;
      icon?: LucideIcon;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator' }
  | { kind: 'label'; label: string };

interface MenuProps {
  entries: MenuEntry[];
  /** Renders the trigger; spread `props` onto the button. */
  trigger: (props: {
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    onClick: () => void;
  }) => ComponentChildren;
  align?: 'left' | 'right';
  direction?: 'down' | 'up';
}

export function Menu({ entries, trigger, align = 'right', direction = 'down' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const items = (): HTMLButtonElement[] =>
      Array.from(
        list.current?.querySelectorAll<HTMLButtonElement>('.menu__item:not(:disabled)') ?? [],
      );
    items()[0]?.focus();
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      const all = items();
      const index = all.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        all[(index + step + all.length) % all.length]?.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        (e.key === 'Home' ? all[0] : all[all.length - 1])?.focus();
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const classes = ['menu'];
  if (align === 'left') classes.push('menu--left');
  if (direction === 'up') classes.push('menu--up');

  return (
    <div class="menu-anchor" ref={root}>
      {trigger({ 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(!open) })}
      {open && (
        <div class={classes.join(' ')} role="menu" ref={list}>
          {entries.map((entry, i) => {
            if (entry.kind === 'separator')
              return <div key={i} class="menu__sep" role="separator" />;
            if (entry.kind === 'label') {
              return (
                <div key={i} class="menu__label" role="presentation">
                  {entry.label}
                </div>
              );
            }
            const Icon = entry.icon;
            const checkable = entry.checked !== undefined;
            return (
              <button
                key={i}
                type="button"
                role={checkable ? 'menuitemradio' : 'menuitem'}
                aria-checked={checkable ? entry.checked : undefined}
                class={entry.danger ? 'menu__item menu__item--danger' : 'menu__item'}
                disabled={entry.disabled}
                onClick={() => {
                  setOpen(false);
                  entry.onSelect();
                }}
              >
                {checkable ? (
                  <span class="menu__check" aria-hidden="true">
                    {entry.checked && <Check class="icon" size={16} />}
                  </span>
                ) : (
                  Icon && <Icon class="icon" size={18} aria-hidden="true" />
                )}
                <span class="grow">
                  {entry.label}
                  {entry.description && <span class="menu__desc">{entry.description}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
