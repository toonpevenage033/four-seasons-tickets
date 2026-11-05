import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, cancelRequests, events, login, loginTickable, logout, scan, TICKABLE_BASE_URL } from './api.ts';
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

const tickableSession: Session = {
  baseUrl: TICKABLE_BASE_URL,
  token: 'tk_live_test',
  expiresAt: '2099-01-01T00:00:00Z',
  user: { id: 'uid', username: 'KOORTS', role: 'staff' },
  provider: 'tickable',
};
const ticketId = 'c3d4e5f6-7890-4a1b-2c3d-4e5f6a7b8c9d';
const tickableScanBody = (overrides: Record<string, unknown> = {}) => ({
  ticket_id: ticketId, status: 'valid', scanned_before: false,
  event: { id: 'event-1', title: 'KOORTS', location: null },
  timeslot: { title: null, starts_at: null, ends_at: null },
  ticket_type: { id: 't', name: 'Regular', price: 1500 },
  owner_name: 'Jane', owner_email: 'jane@example.com', seat: null,
  scanned_at: '2026-06-15T14:30:00Z', cancelled_at: null, related_tickets: null,
  ...overrides,
});

test('tickable login validates the key via /whoami and returns a tickable session', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return Response.json({ uid: 'uid', email: 'org@example.com', organization: 'KOORTS' });
  };
  const result = await loginTickable('  tk_live_test  ');
  assert.deepEqual(calls.map(c => [c.url, c.init.method]), [[`${TICKABLE_BASE_URL}/whoami`, 'GET']]);
  assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), 'Bearer tk_live_test');
  assert.equal(result.provider, 'tickable');
  assert.equal(result.baseUrl, TICKABLE_BASE_URL);
  assert.equal(result.user.username, 'KOORTS');
  assert.ok(Date.parse(result.expiresAt) > Date.now());
  await assert.rejects(loginTickable('two words'), ApiError);
  await assert.rejects(loginTickable('   '), ApiError);
});

test('tickable events map platform fields and prefer the first timeslot date', async () => {
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('/timeslots')) {
      if (url.includes('event-1')) return Response.json({ data: [{ title: null, starts_at: '2026-06-15T10:00:00Z', ends_at: null }] });
      return Response.json({ error: { code: 'resource_missing', message: 'No timeslots' } }, { status: 404 });
    }
    return Response.json({
      data: [
        { id: 'event-1', title: 'KOORTS Winter', location: 'Gent', created_at: '2026-04-01T12:00:00Z' },
        { id: 'event-2', title: 'KOORTS Zomer', location: null, created_at: '2026-04-02T12:00:00Z' },
      ],
      pagination: { total: 2, limit: 100, offset: 0, has_more: false },
    });
  };
  const result = await events(tickableSession);
  assert.deepEqual(result, [
    { id: 'event-1', title: 'KOORTS Winter', startsAt: '2026-06-15T10:00:00Z', location: 'Gent', isTest: false },
    { id: 'event-2', title: 'KOORTS Zomer', startsAt: '2026-04-02T12:00:00Z', location: '', isTest: false },
  ]);
});

test('tickable scan posts to the scan endpoint and maps every status', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let response = tickableScanBody();
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return Response.json(response);
  };
  const request = { eventId: 'event-1', code: `https://tickets.example/${ticketId}`, requestId: 'r1' };
  const valid = await scan(tickableSession, request);
  assert.deepEqual(calls.map(c => [c.url, c.init.method]), [[`${TICKABLE_BASE_URL}/tickets/${ticketId}/scan`, 'POST']]);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.scannedAt, '2026-06-15T14:30:00Z');
  response = tickableScanBody({ status: 'scanned' });
  assert.equal((await scan(tickableSession, request)).status, 'already_used');
  response = tickableScanBody({ status: 'cancelled' });
  assert.equal((await scan(tickableSession, request)).status, 'invalid');
  response = tickableScanBody({ status: 'not_allowed', scanned_at: null });
  assert.equal((await scan(tickableSession, request)).status, 'invalid');
  response = tickableScanBody({ event: { id: 'other-event', title: 'Other', location: null } });
  const wrongEvent = await scan(tickableSession, request);
  assert.equal(wrongEvent.status, 'invalid');
  assert.match(wrongEvent.message, /different event/);
});

test('tickable scan fails closed on unknown tickets and foreign QR codes', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: { type: 'not_found_error', code: 'resource_missing', message: 'No such ticket.', request_id: 'req' } }, { status: 404 });
  };
  const notFound = await scan(tickableSession, { eventId: 'event-1', code: ticketId, requestId: 'r1' });
  assert.equal(notFound.status, 'invalid');
  assert.equal(calls, 1);
  const noUuid = await scan(tickableSession, { eventId: 'event-1', code: 'opaque://not-a-tickable-code', requestId: 'r2' });
  assert.equal(noUuid.status, 'invalid');
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls++; return Response.json({ status: 'valid' }); };
  await assert.rejects(scan(tickableSession, { eventId: 'event-1', code: ticketId, requestId: 'r3' }), ApiError);
});

test('tickable logout never calls the network and 403/500 scan errors still throw', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: { type: 'permission_error', code: 'forbidden', message: 'Nope', request_id: 'req' } }, { status: 403 });
  };
  await logout(tickableSession);
  assert.equal(calls, 0);
  await assert.rejects(scan(tickableSession, { eventId: 'event-1', code: ticketId, requestId: 'r1' }),
    (error: unknown) => error instanceof ApiError && error.status === 403);
});
