// Confirmation dialog for commands the server answered with 428 confirm_required.
// It shows the facts the safeguard produced and the countdown on the one-shot token.
import { useEffect, useState } from 'react';
import type { CommandConfirmDTO } from '../../../shared/commands';

export function ConfirmDialog({
  confirm,
  busy,
  onConfirm,
  onCancel,
}: {
  confirm: CommandConfirmDTO;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((confirm.expiresAtTs - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((confirm.expiresAtTs - Date.now()) / 1000))), 500);
    return () => clearInterval(t);
  }, [confirm.expiresAtTs]);
  const expired = left <= 0;

  return (
    <div className="modal-scrim" role="presentation" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cf-title">
        <h2 id="cf-title">{confirm.title}</h2>
        <ul className="confirm-facts">
          {confirm.facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p className="muted small">
          {expired ? 'This confirmation has expired: send the command again to get a new one.' : `Expires in ${left} s.`}
        </p>
        <div className="row end">
          <button type="button" className="arl-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="arl-btn arl-btn--primary" onClick={onConfirm} disabled={busy || expired}>
            {busy ? 'Sending…' : 'Confirm and send'}
          </button>
        </div>
      </div>
    </div>
  );
}
