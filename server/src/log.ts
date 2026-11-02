// Logging helpers. Researcher codes and passwords are never logged in full (exam rule 2).
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export function maskCode(code: string | null | undefined): string {
  if (!code) return '';
  return code.length <= 3 ? '***' : `${code.slice(0, 3)}***`;
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export const REDACT_PATHS = ['req.headers["x-researcher-code"]', 'req.headers.authorization', '*.password'];
