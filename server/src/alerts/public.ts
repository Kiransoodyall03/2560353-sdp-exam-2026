// Wire views of alerts. Full researcher codes stay in the database (audit); responses and SSE carry only a
// masked form plus the researcher name, so reading the annunciator never reveals a usable code.
import type { AlertDTO, AlertEventDTO } from '../../../shared/types.js';
import { maskCode } from '../log.js';

export function publicAlert(a: AlertDTO): AlertDTO {
  if (!a.ackBy && !a.resolvedBy) return a;
  return {
    ...a,
    ackBy: a.ackBy ? maskCode(a.ackBy) : null,
    resolvedBy: a.resolvedBy ? maskCode(a.resolvedBy) : null,
  };
}

export function publicEvent(e: AlertEventDTO): AlertEventDTO {
  return e.actor ? { ...e, actor: maskCode(e.actor) } : e;
}
