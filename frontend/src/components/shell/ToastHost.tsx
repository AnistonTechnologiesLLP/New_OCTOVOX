import { useEffect, useRef } from 'react';
import { useToasts, type Toast } from '../../state/toasts';

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    timer.current = setTimeout(() => dismiss(t.id), t.duration);
    return () => clearTimeout(timer.current);
  }, [t.id, t.duration, dismiss]);

  return (
    <div className={`toast${t.type ? ` ${t.type}` : ''}`} role="status">
      <span className="toast-text">{t.msg}</span>
      {t.action && (
        <button
          className="toast-action"
          onClick={() => {
            try {
              t.action!.onClick();
            } finally {
              dismiss(t.id);
            }
          }}
        >
          {t.action.label || 'Undo'}
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
        ✕
      </button>
    </div>
  );
}

export default function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toast-wrap" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}
