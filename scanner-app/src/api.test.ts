import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, cancelRequests, events, login, logout, scan } from './api.ts';
import { ScanGate } from './core.ts';
import type { Session } from './core.ts';

const session: Session = {
  baseUrl: 'https://backend.example.org',
  token: 'private-test-token',
  expiresAt: '2099-01-01T00:00:00Z',
  user: { id: '1', username: 'door', role: 'staff' },
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; cancelRequests(); });

test('exact login, events, scan, and logout API paths, headers, and body shape', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    const url = String(input);
    if (url.endsWith('/login')) return Response.json(session);
    if (url.endsWith('/events')) return Response.json({ events: [] });
    if (url.endsWith('/logout')) return new Response(null, { status: 204 });
    return Response.json({ status: 'valid', message: 'Accepted', scannedAt: null });
  };
  await login(session.baseUrl, 'door', 'never-saved');
  await events(session);
  const body = { eventId: 'e', code: 'opaque-token', requestId: '00000000-0000-4000-8000-000000000001' };
  await scan(session, body);
  await logout(session);
  assert.deepEqual(calls.map(c => [c.url, c.init.method]), [
    [session.baseUrl + '/api/staff/login', 'POST'],
    [session.baseUrl + '/api/staff/events', 'GET'],
    [session.baseUrl + '/api/staff/scan', 'POST'],
    [session.baseUrl + '/api/staff/logout', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { username: 'door', password: 'never-saved' });
  assert.equal(new Headers(calls[0]!.init.headers).has('Authorization'), false);
  for (const call of calls.slice(1)) assert.equal(new Headers(call.init.headers).get('Authorization'), `Bearer ${session.token}`);
  assert.deepEqual(JSON.parse(calls[2]!.init.body as string), body);
});

test('network failure and 5xx retry serialize the same idempotency request', async () => {
  const bodies: string[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(init!.body as string);
    if (bodies.length === 1) throw new TypeError('Network unavailable');
    if (bodies.length === 2) return Response.json({ error: { code: 'UNAVAILABLE', message: 'Try later' } }, { status: 503 });
    return Response.json({ status: 'valid', message: 'Accepted', scannedAt: null });
  };
  const gate = new ScanGate(() => '00000000-0000-4000-8000-000000000001');
  const request = gate.begin('e', 'ticket')!;
  await assert.rejects(scan(session, request), ApiError);
  gate.fail(request, 'Network');
  await assert.rejects(scan(session, gate.retry()!), (e: unknown) => e instanceof ApiError && e.status === 503);
  gate.fail(request, '503');
  const result = await scan(session, gate.retry()!);
  assert.equal(gate.finish(request, result), true);
  assert.equal(new Set(bodies).size, 1);
});

test('401, 403, 429 preserve status/code and never become valid scan results', async () => {
  for (const status of [401, 403, 429]) {
    globalThis.fetch = async () => Response.json({ error: { code: 'TEST', message: 'Rejected' } }, { status });
    await assert.rejects(scan(session, { eventId: 'e', code: 't', requestId: 'id' }),
      (error: unknown) => error instanceof ApiError && error.status === status && error.code === 'TEST');
  }
});

test('invalid login is not presented as an expired session', async () => {
  globalThis.fetch = async () => Response.json({
    error: { code: 'LOGIN_FAILED', message: 'Gebruikersnaam of wachtwoord onjuist.' },
  }, { status: 401 });
  await assert.rejects(login(session.baseUrl, 'door', 'incorrect'),
    (error: unknown) => error instanceof ApiError && error.status === 401 &&
      error.code === 'LOGIN_FAILED' && error.message.includes('wachtwoord onjuist'));
  await assert.rejects(events(session),
    (error: unknown) => error instanceof ApiError && error.message === 'Session expired. Sign in again.');
});

test('background cancellation aborts pending transport and rejects unconfirmed result', async () => {
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal as AbortSignal;
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
  };
  const pending = scan(session, { eventId: 'e', code: 't', requestId: 'id' });
  cancelRequests();
  await assert.rejects(pending, ApiError);
  assert.equal(signal?.aborted, true);
});

test('request timeout aborts transport', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init!.signal as AbortSignal;
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
  };
  const pending = scan(session, { eventId: 'e', code: 't', requestId: 'id' });
  t.mock.timers.tick(12001);
  await assert.rejects(pending, ApiError);
  assert.equal(signal?.aborted, true);
});

test('expired local session and malformed successful responses fail closed', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ status: 'valid' }); };
  await assert.rejects(scan({ ...session, expiresAt: '2000-01-01T00:00:00Z' }, { eventId: 'e', code: 't', requestId: 'id' }),
    (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(calls, 0);
  await assert.rejects(scan(session, { eventId: 'e', code: 't', requestId: 'id' }), ApiError);
});
