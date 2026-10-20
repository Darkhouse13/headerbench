/** Modal dialog on the native <dialog> element (focus trap and Escape come from the browser). */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  small?: boolean;
}

export function Dialog({ title, onClose, children, footer, small = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `dialog-${title.replace(/\W+/g, '-').toLowerCase()}`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showModal === 'function') {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute('open', '');
    }
    const onCancel = (e: Event): void => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [onClose]);

  return (
    <dialog ref={ref} class={small ? 'dialog dialog--small' : 'dialog'} aria-labelledby={titleId}>
      <div class="dialog__inner">
        <div class="dialog__head">
          <h2 id={titleId}>{title}</h2>
        </div>
        <div class="dialog__body">{children}</div>
        {footer && <div class="dialog__foot">{footer}</div>}
      </div>
    </dialog>
  );
}

interface ConfirmProps {
  title: string;
  children: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      small
      footer={
        <>
          <button type="button" class="btn btn--text" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            class={danger ? 'btn btn--primary btn--danger-fill' : 'btn btn--primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
