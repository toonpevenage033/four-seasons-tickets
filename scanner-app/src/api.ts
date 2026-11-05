import { extractTicketId, isDate, isEvent, isLogin, isRecord, isScanResult, isTickableEvent, isTickableScan, isTickableWhoami, mapTickableScan } from './core.ts';
import type { ScanRequest, Session, StaffEvent, ScanResult } from './core.ts';

export const TICKABLE_BASE_URL = 'https://api.tickable.io';

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
          : path === '/whoami'
            ? 'Tickable API key rejected. Check the key in the Tickable dashboard.'
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

export async function loginTickable(apiKey: string): Promise<Session> {
  const key = apiKey.trim();
  if (!key || /\s/.test(key)) throw new ApiError('Paste a single Tickable API key without spaces.');
  const data = await request(TICKABLE_BASE_URL, '/whoami', key);
  if (!isTickableWhoami(data)) throw new ApiError('Invalid Tickable response.');
  // API keys do not expire server-side; force a monthly re-entry on this device.
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    baseUrl: TICKABLE_BASE_URL,
    token: key,
    expiresAt,
    user: { id: data.uid, username: data.organization || data.email, role: 'staff' },
    provider: 'tickable',
  };
}

async function tickableEvents(session: Session, signal?: AbortSignal): Promise<StaffEvent[]> {
  const data = await request(session.baseUrl, '/events?limit=100', session.token, undefined, signal);
  if (!isRecord(data) || !Array.isArray(data.data)) throw new ApiError('Invalid events response.');
  const result: StaffEvent[] = [];
  for (const item of data.data) {
    if (!isTickableEvent(item)) throw new ApiError('Invalid events response.');
    // Tickable events carry dates on their timeslots; fall back to the creation date.
    let startsAt = item.created_at;
    try {
      const slots = await request(session.baseUrl, `/events/${item.id}/timeslots?limit=1`, session.token, undefined, signal);
      if (isRecord(slots) && Array.isArray(slots.data) && isRecord(slots.data[0]) && isDate(slots.data[0].starts_at)) {
        startsAt = slots.data[0].starts_at;
      }
    } catch {
      // Keep the fallback date; the event list stays usable without timeslot access.
    }
    const event = { id: item.id, title: item.title, startsAt, location: item.location ?? '', isTest: false };
    if (!isEvent(event)) throw new ApiError('Invalid events response.');
    result.push(event);
  }
  return result;
}

export async function events(session: Session, signal?: AbortSignal): Promise<StaffEvent[]> {
  requireCurrentSession(session);
  if (session.provider === 'tickable') return tickableEvents(session, signal);
  const data = await request(session.baseUrl, '/api/staff/events', session.token, undefined, signal);
  if (!isRecord(data) || !Array.isArray(data.events) || !data.events.every(isEvent)) throw new ApiError('Invalid events response.');
  return data.events;
}

async function tickableScan(session: Session, body: ScanRequest, signal?: AbortSignal): Promise<ScanResult> {
  const ticketId = extractTicketId(body.code);
  if (!ticketId) return { status: 'invalid', message: 'No Tickable ticket code recognised in this QR.', scannedAt: null };
  let data: unknown;
  try {
    data = await request(session.baseUrl, `/tickets/${ticketId}/scan`, session.token, {}, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { status: 'invalid', message: 'Ticket not found for this organization.', scannedAt: null };
    }
    throw error;
  }
  if (!isTickableScan(data)) throw new ApiError('Invalid scan response. Retry the same check.');
  return mapTickableScan(data, body.eventId);
}

export async function scan(session: Session, body: ScanRequest, signal?: AbortSignal): Promise<ScanResult> {
  requireCurrentSession(session);
  if (session.provider === 'tickable') return tickableScan(session, body, signal);
  const data = await request(session.baseUrl, '/api/staff/scan', session.token, body, signal);
  if (!isScanResult(data)) throw new ApiError('Invalid scan response. Retry the same check.');
  return data;
}

export async function logout(session: Session): Promise<void> {
  // Tickable API keys cannot be revoked from the app; the local session is simply cleared.
  if (session.provider === 'tickable') return;
  await request(session.baseUrl, '/api/staff/logout', session.token, {});
}
