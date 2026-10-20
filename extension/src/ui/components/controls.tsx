/** Buttons, switches, fields and small display pieces shared by every page. */
import type { EnvTag, Profile } from '@headerbench/core';
import { badgeFor } from '@headerbench/core';
import type { LucideIcon } from 'lucide-preact';
import { CircleAlert, Info, TriangleAlert } from 'lucide-preact';
import type { ComponentChildren, JSX } from 'preact';
import { ENV_LABELS } from '../format';

type ButtonProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'text' | 'danger';
  small?: boolean;
  icon?: LucideIcon;
  disabled?: boolean;
  type?: 'button' | 'submit';
};

export function Button({
  variant = 'default',
  small = false,
  icon: Icon,
  class: className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['btn'];
  if (variant !== 'default') classes.push(`btn--${variant}`);
  if (small) classes.push('btn--small');
  if (className) classes.push(String(className));
  return (
    <button type={type} class={classes.join(' ')} {...rest}>
      {Icon && <Icon class="icon" size={small ? 16 : 18} aria-hidden="true" />}
      {children}
    </button>
  );
}

type IconButtonProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  small?: boolean;
  disabled?: boolean;
};

export function IconButton({ icon: Icon, label, small = false, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      class={small ? 'icon-btn icon-btn--small' : 'icon-btn'}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon class="icon" size={small ? 16 : 20} aria-hidden="true" />
    </button>
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  small?: boolean;
  disabled?: boolean;
  id?: string;
}

export function Switch({ checked, onChange, label, small = false, disabled, id }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      class={small ? 'switch switch--small' : 'switch'}
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: SegmentedProps<T>) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface FieldProps {
  label: string;
  htmlFor: string;
  help?: ComponentChildren;
  children: ComponentChildren;
}

export function Field({ label, htmlFor, help, children }: FieldProps) {
  return (
    <div class="field">
      <label class="field__label" for={htmlFor}>
        {label}
      </label>
      {children}
      {help && <div class="field__help">{help}</div>}
    </div>
  );
}

export function ProfileMark({ profile, small = false }: { profile: Profile; small?: boolean }) {
  return (
    <span
      class={small ? 'profile-mark profile-mark--small' : 'profile-mark'}
      style={{ background: profile.color }}
      aria-hidden="true"
    >
      {profile.badge.trim() || badgeFor(profile.name)}
    </span>
  );
}

export function EnvChip({ env }: { env: EnvTag }) {
  if (env === 'none') return null;
  return <span class={`chip chip--env chip--env-${env}`}>{ENV_LABELS[env]}</span>;
}

export function ProChip() {
  return <span class="chip chip--pro">Pro</span>;
}

type Tone = 'info' | 'warning' | 'error' | 'success' | 'neutral';

const TONE_ICON: Record<Tone, LucideIcon> = {
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
  success: Info,
  neutral: Info,
};

interface BannerProps {
  tone?: Tone;
  title?: string;
  icon?: LucideIcon;
  children?: ComponentChildren;
  actions?: ComponentChildren;
  role?: 'status' | 'alert';
}

export function Banner({ tone = 'neutral', title, icon, children, actions, role }: BannerProps) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <div class={`banner banner--${tone}`} role={role ?? (tone === 'error' ? 'alert' : 'status')}>
      <Icon class="icon" size={18} aria-hidden="true" />
      <div class="banner__body">
        {title && <div class="banner__title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
      {actions && <div class="banner__actions">{actions}</div>}
    </div>
  );
}

export function Issue({
  tone,
  children,
}: {
  tone: 'error' | 'warning' | 'info';
  children: ComponentChildren;
}) {
  const Icon = tone === 'error' ? CircleAlert : tone === 'warning' ? TriangleAlert : Info;
  return (
    <div class={`issue issue--${tone}`}>
      <Icon class="icon" size={14} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  children?: ComponentChildren;
  action?: ComponentChildren;
}

export function EmptyState({ icon: Icon, title, children, action }: EmptyStateProps) {
  return (
    <div class="empty">
      <div class="empty__icon">
        <Icon class="icon" size={24} aria-hidden="true" />
      </div>
      <h2>{title}</h2>
      {children && <p class="empty__text">{children}</p>}
      {action}
    </div>
  );
}
