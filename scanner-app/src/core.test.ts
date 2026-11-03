import assert from 'node:assert/strict';
import test from 'node:test';
import { isEvent, isLogin, isScanResult, normalizeBaseUrl, ScanGate } from './core.ts';

const valid = { status: 'valid', message: 'Accepted', scannedAt: '2026-11-03T12:00:00Z' } as const;

test('only one native callback starts a request; opaque QR is preserved verbatim', () => {
  let ids = 0;
  const gate = new ScanGate(() => `id-${++ids}`);
  const code = '  opaque://not-a-url?token=abc#xyz  ';
  const request = gate.begin('event', code);
  assert.deepEqual(request, { eventId: 'event', code, requestId: 'id-1' });
  assert.equal(gate.begin('event', code), null);
  assert.equal(gate.begin('event', 'different-code'), null);
  assert.equal(ids, 1);
});

test('network/5xx ambiguity retries identical request object and ID, never grants admission', () => {
  let ids = 0;
  const gate = new ScanGate(() => `id-${++ids}`);
  const request = gate.begin('event', 'ticket')!;
  gate.fail(request, 'Connection failed');
  assert.equal(gate.state.phase, 'retry');
  assert.equal(gate.begin('event', 'other'), null);
  assert.equal(gate.next(), false);
  assert.equal(gate.retry(), request);
  assert.equal(gate.retry(), null);
  gate.fail(request, 'Server unavailable');
  assert.equal(gate.retry(), request);
  assert.equal(ids, 1);
});

test('confirmed results pause scans until explicit next; duplicate cooldown also applies after next', () => {
  let now = 100;
  const gate = new ScanGate(() => 'id', () => now);
  const request = gate.begin('event', 'ticket')!;
  assert.equal(gate.finish(request, valid), true);
  assert.equal(gate.begin('event', 'other'), null);
  assert.equal(gate.retry(), null);
  assert.equal(gate.next(), true);
  assert.equal(gate.begin('event', 'ticket'), null);
  now += 2001;
  assert.notEqual(gate.begin('event', 'ticket'), null);
});

test('background blocks QR and late success, while pending request stays retryable', () => {
  const gate = new ScanGate(() => 'id');
  const request = gate.begin('event', 'ticket')!;
  gate.active = false;
  assert.equal(gate.finish(request, valid), false);
  gate.fail(request, 'Suspended');
  assert.equal(gate.retry(), null);
  assert.equal(gate.begin('event', 'ticket'), null);
  gate.active = true;
  assert.equal(gate.retry(), request);
  assert.equal(gate.finish(request, valid), true);
});

test('stale requests and empty codes cannot mutate a new check', () => {
  let i = 0;
  const gate = new ScanGate(() => `${++i}`);
  assert.equal(gate.begin('event', ''), null);
  const first = gate.begin('event', 'one')!;
  gate.finish(first, valid);
  gate.next();
  const second = gate.begin('event', 'two')!;
  assert.equal(gate.fail(first, 'late failure'), false);
  assert.equal(gate.finish(first, valid), false);
  assert.equal(gate.state.phase, 'submitting');
  gate.finish(second, { ...valid, status: 'already_used' });
  assert.equal(gate.state.phase, 'result');
});

test('production accepts only clean HTTPS origins', () => {
  assert.equal(normalizeBaseUrl(' https://tickets.example.org/ ', false), 'https://tickets.example.org');
  for (const url of [
    'http://localhost:3000', 'http://192.168.1.10:3000', 'ftp://example.org',
    'https://name:secret@example.org', 'https://example.org/api', 'https://example.org/?q=1',
    'https://example.org/#x', 'not a URL',
  ]) assert.throws(() => normalizeBaseUrl(url, false), url);
});

test('development HTTP is restricted to explicit private/loopback hosts', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.2', '172.16.0.1', '172.31.255.254', '192.168.1.2', '[::1]']) {
    assert.equal(normalizeBaseUrl(`http://${host}:3000`, true), `http://${host}:3000`);
  }
  for (const host of ['example.org', 'localhost.evil.org', '172.15.0.1', '172.32.0.1', '192.169.1.1', '8.8.8.8', '0.0.0.0']) {
    assert.throws(() => normalizeBaseUrl(`http://${host}`, true), host);
  }
});

test('runtime response validators reject missing/wrong fields and unexpected statuses', () => {
  const login = { token: 'opaque', expiresAt: valid.scannedAt, user: { id: '1', username: 'staff', role: 'staff' } };
  assert.equal(isLogin(login), true);
  assert.equal(isLogin({ ...login, user: { ...login.user, role: 'customer' } }), false);
  assert.equal(isLogin({ ...login, token: 'bad\nheader' }), false);
  assert.equal(isScanResult(valid), true);
  assert.equal(isScanResult({ ...valid, status: 'success' }), false);
  assert.equal(isScanResult({ ...valid, scannedAt: 'not-a-date' }), false);
  assert.equal(isScanResult({ status: 'invalid', message: 'No', scannedAt: null }), true);
  assert.equal(isEvent({ id: 'e', title: 'Party', startsAt: valid.scannedAt, location: 'Hall', isTest: true }), true);
  assert.equal(isEvent({ id: 'e', title: 'Party', startsAt: valid.scannedAt, location: 'Hall' }), false);
});
