export type StaffUser = { id: string; username: string; role: 'staff' | 'admin' };
export type Session = { baseUrl: string; token: string; expiresAt: string; user: StaffUser };
export type StaffEvent = { id: string; title: string; startsAt: string; location: string; isTest: boolean };
export type ScanRequest = { eventId: string; code: string; requestId: string };
export type ScanResult = {
  status: 'valid' | 'already_used' | 'invalid';
  message: string;
  scannedAt: string | null;
};

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d+$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

export function normalizeBaseUrl(input: string, development: boolean): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter a complete HTTPS backend URL.'); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Use the backend origin only, without credentials, path, query, or fragment.');
  }
  if (url.protocol !== 'https:' && !(development && url.protocol === 'http:' && isPrivateHost(url.hostname))) {
    throw new Error('HTTPS is required. Development HTTP is allowed only on localhost or a private LAN IP.');
  }
  return url.origin;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isDate(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}
export function isLogin(value: unknown): value is Omit<Session, 'baseUrl'> {
  if (!isRecord(value) || !isRecord(value.user)) return false;
  return typeof value.token === 'string' && value.token.length > 0 && !/[\r\n]/.test(value.token) &&
    isDate(value.expiresAt) && typeof value.user.id === 'string' && typeof value.user.username === 'string' &&
    (value.user.role === 'staff' || value.user.role === 'admin');
}
export function isEvent(value: unknown): value is StaffEvent {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.title === 'string' && isDate(value.startsAt) &&
    typeof value.location === 'string' && typeof value.isTest === 'boolean';
}
export function isScanResult(value: unknown): value is ScanResult {
  return isRecord(value) && ['valid', 'already_used', 'invalid'].includes(String(value.status)) &&
    typeof value.message === 'string' && (value.scannedAt === null || isDate(value.scannedAt));
}

export type ScanState =
  | { phase: 'ready' }
  | { phase: 'submitting'; request: ScanRequest }
  | { phase: 'retry'; request: ScanRequest; message: string }
  | { phase: 'result'; request: ScanRequest; result: ScanResult };

// Synchronous gate closes before React renders, so repeated native callbacks cannot race.
export class ScanGate {
  state: ScanState = { phase: 'ready' };
  active = true;
  private lastCode: string | null = null;
  private lastAt = 0;
  private readonly uuid: () => string;
  private readonly now: () => number;

  constructor(uuid: () => string, now: () => number = Date.now) {
    this.uuid = uuid;
    this.now = now;
  }

  begin(eventId: string, code: string): ScanRequest | null {
    if (!this.active || this.state.phase !== 'ready' || !code.length) return null;
    if (this.lastCode === code && this.now() - this.lastAt < 2000) return null;
    const request = { eventId, code, requestId: this.uuid() };
    this.lastCode = code;
    this.lastAt = this.now();
    this.state = { phase: 'submitting', request };
    return request;
  }

  retry(): ScanRequest | null {
    if (!this.active || this.state.phase !== 'retry') return null;
    const request = this.state.request;
    this.state = { phase: 'submitting', request };
    return request;
  }

  fail(request: ScanRequest, message: string): boolean {
    if (this.state.phase !== 'submitting' || this.state.request !== request) return false;
    this.state = { phase: 'retry', request, message };
    return true;
  }

  finish(request: ScanRequest, result: ScanResult): boolean {
    if (!this.active || this.state.phase !== 'submitting' || this.state.request !== request) return false;
    this.state = { phase: 'result', request, result };
    return true;
  }

  next(): boolean {
    if (this.state.phase !== 'result') return false;
    this.state = { phase: 'ready' };
    return true;
  }
}
