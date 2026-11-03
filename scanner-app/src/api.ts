import { isEvent, isLogin, isRecord, isScanResult } from './core.ts';
import type { ScanRequest, Session, StaffEvent, ScanResult } from './core.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 0, code = 'NETWORK') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const activeRequests = new Set<AbortController>();
export function cancelRequests(): void {
  for (const controller of activeRequests) controller.abort();
}

function requireCurrentSession(session: Session): void {
  if (Date.parse(session.expiresAt) <= Date.now()) {
    throw new ApiError('Session expired. Sign in again.', 401, 'SESSION_EXPIRED');
  }
}

async function request(baseUrl: string, path: string, token?: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  activeRequests.add(controller);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 12000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
    });
    const text = await response.text();
    if (controller.signal.aborted) throw new ApiError('Request interrupted. Retry the same check.', 0, 'ABORTED');
    let data: unknown;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const error = isRecord(data) && isRecord(data.error) ? data.error : null;
      const defaults: Record<number, string> = {
        401: path === '/api/staff/login'
          ? 'Gebruikersnaam of wachtwoord onjuist. Probeer opnieuw.'
          : 'Session expired. Sign in again.',
        403: 'Access denied. Ask an administrator.',
        429: 'Too many requests. Wait before retrying.',
      };
      throw new ApiError(
        defaults[response.status] ?? (response.status >= 500 ? 'Server unavailable. Retry the same check.' :
          typeof error?.message === 'string' ? error.message : 'Request rejected.'),
        response.status,
        typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
      );
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted
      ? 'Request timed out or was interrupted. Retry the same check.'
      : 'Connection failed. The ticket has NOT been confirmed. Retry the same check.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    activeRequests.delete(controller);
  }
}

export async function login(baseUrl: string, username: string, password: string): Promise<Session> {
  const data = await request(baseUrl, '/api/staff/login', undefined, { username, password });
  if (!isLogin(data) || Date.parse(data.expiresAt) <= Date.now()) throw new ApiError('Invalid login response.');
  return {
    baseUrl,
    token: data.token,
    expiresAt: data.expiresAt,
    user: { id: data.user.id, username: data.user.username, role: data.user.role },
  };
}
export async function events(session: Session, signal?: AbortSignal): Promise<StaffEvent[]> {
  requireCurrentSession(session);
  const data = await request(session.baseUrl, '/api/staff/events', session.token, undefined, signal);
  if (!isRecord(data) || !Array.isArray(data.events) || !data.events.every(isEvent)) throw new ApiError('Invalid events response.');
  return data.events;
}
export async function scan(session: Session, body: ScanRequest, signal?: AbortSignal): Promise<ScanResult> {
  requireCurrentSession(session);
  const data = await request(session.baseUrl, '/api/staff/scan', session.token, body, signal);
  if (!isScanResult(data)) throw new ApiError('Invalid scan response. Retry the same check.');
  return data;
}
export async function logout(session: Session): Promise<void> {
  await request(session.baseUrl, '/api/staff/logout', session.token, {});
}
