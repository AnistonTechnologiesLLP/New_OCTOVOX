import { useEffect, useRef } from 'react';
import { useModal } from '../../state/modals';

export default function ModalHost() {
  const active = useModal((s) => s.active);
  const close = useModal((s) => s.close);
  const panelRef = useRef<HTMLDivElement>(null);

  // Auto-focus the first primary/danger button (legacy app.js:2099-2104).
  useEffect(() => {
    if (!active) return;
    const id = setTimeout(() => {
      const el =
        panelRef.current?.querySelector<HTMLButtonElement>('.modal-btn.primary, .modal-btn.danger') ||
        panelRef.current?.querySelector<HTMLButtonElement>('.modal-btn');
      el?.focus();
    }, 30);
    return () => clearTimeout(id);
  }, [active]);

  if (!active) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) close('cancel');
      }}
    >
      <div className="modal-panel" ref={panelRef}>
        <div className="modal-head">
          {active.icon && <div className={`modal-icon ${active.iconType || ''}`}>{active.icon}</div>}
          <div className="modal-title">{active.title}</div>
        </div>
        <div className="modal-body">{active.body}</div>
        <div className="modal-actions">
          {active.buttons.map((b) => (
            <button key={b.id} className={`modal-btn ${b.variant || ''}`} onClick={() => close(b.id)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
