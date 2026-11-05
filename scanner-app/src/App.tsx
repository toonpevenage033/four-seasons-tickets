import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, Image, KeyboardAvoidingView, Linking, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import * as api from './api';
import { isLogin, normalizeBaseUrl, ScanGate } from './core';
import type { ScanRequest, Session, StaffEvent } from './core';
import { clearSession, readSession, saveSession } from './storage';

const C = { cream: '#f1ecdf', black: '#1c1b18', red: '#e94028', muted: '#615e54', green: '#176638', amber: '#865600' };
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please retry.';

function Button({ title, onPress, disabled = false, secondary = false }: {
  title: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [s.button, secondary && s.secondary, (disabled || pressed) && s.dim]}>
    <Text style={[s.buttonText, secondary && { color: C.black }]}>{title}</Text>
  </Pressable>;
}

function Brand() {
  return <View style={s.brand}>
    <Image source={require('../assets/logo.png')} style={s.logo} resizeMode="contain" accessibilityLabel="KOORTS" />
    <Text style={s.eyebrow}>PRIVATE STAFF SCANNER</Text>
  </View>;
}

function Login({ onLogin, notice }: { onLogin: (session: Session) => Promise<void>; notice: string }) {
  const [mode, setMode] = useState<'staff' | 'tickable'>('staff');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  async function submit() {
    if (busy) return;
    setError('');
    if (mode === 'tickable') {
      const secret = apiKey.trim();
      if (!secret) { setError('Paste your Tickable API key.'); return; }
      setApiKey('');
      setBusy(true);
      try {
        const session = await api.loginTickable(secret);
        if (live.current && AppState.currentState === 'active') await onLogin(session);
      } catch (e) {
        if (live.current) setError(errorText(e));
      } finally { if (live.current) setBusy(false); }
      return;
    }
    let url: string;
    try { url = normalizeBaseUrl(baseUrl, __DEV__); } catch (e) { setError(errorText(e)); return; }
    if (!username.trim() || !password) { setError('Enter your username and password.'); return; }
    const secret = password;
    setPassword('');
    setBusy(true);
    try {
      const session = await api.login(url, username.trim(), secret);
      if (live.current && AppState.currentState === 'active') await onLogin(session);
    } catch (e) {
      if (live.current) setError(errorText(e));
    } finally { if (live.current) setBusy(false); }
  }

  return <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Brand />
      {mode === 'staff' ? <>
        <Text style={s.title}>Staff sign in</Text>
        <Text style={s.copy}>Use your private event staff account. Tickets are checked online only.</Text>
        {!!notice && <Text accessibilityLiveRegion="polite" style={s.notice}>{notice}</Text>}
        <Text style={s.label}>Backend URL</Text>
        <TextInput style={s.input} value={baseUrl} onChangeText={setBaseUrl} editable={!busy}
          placeholder="https://tickets.example.org" placeholderTextColor={C.muted} keyboardType="url"
          autoCapitalize="none" autoCorrect={false} accessibilityLabel="Backend URL" />
        <Text style={s.label}>Username</Text>
        <TextInput style={s.input} value={username} onChangeText={setUsername} editable={!busy}
          autoCapitalize="none" autoCorrect={false} autoComplete="username" accessibilityLabel="Username" />
        <Text style={s.label}>Password</Text>
        <TextInput style={s.input} value={password} onChangeText={setPassword} editable={!busy} secureTextEntry
          autoComplete="current-password" accessibilityLabel="Password" onSubmitEditing={() => void submit()} />
      </> : <>
        <Text style={s.title}>Tickable sign in</Text>
        <Text style={s.copy}>Paste an API key created in the Tickable dashboard (Settings → Developers). Use a key limited to the events.read, tickets.read and tickets.write scopes.</Text>
        {!!notice && <Text accessibilityLiveRegion="polite" style={s.notice}>{notice}</Text>}
        <Text style={s.label}>Tickable API key</Text>
        <TextInput style={s.input} value={apiKey} onChangeText={setApiKey} editable={!busy} secureTextEntry
          placeholder="tk_live_…" placeholderTextColor={C.muted}
          autoCapitalize="none" autoCorrect={false} accessibilityLabel="Tickable API key"
          onSubmitEditing={() => void submit()} />
      </>}
      {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      <Button title={busy ? 'Signing in…' : 'Sign in'} disabled={busy} onPress={() => void submit()} />
      <Button title={mode === 'staff' ? 'Use a Tickable API key instead' : 'Use a staff account instead'}
        secondary disabled={busy} onPress={() => { setError(''); setMode(mode === 'staff' ? 'tickable' : 'staff'); }} />
      <Text style={s.small}>{mode === 'staff'
        ? 'Your password is never saved. The session is stored in this device’s secure storage.'
        : 'The API key is stored only in this device’s secure storage and expires locally after 30 days.'}</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}

type AuthProps = { session: Session; onAuthError: (error: unknown) => void; onLogout: () => void };

function EventList({ session, onSelect, onAuthError, onLogout }: AuthProps & { onSelect: (event: StaffEvent) => void }) {
  const [events, setEvents] = useState<StaffEvent[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setBusy(true);
    setError('');
    void api.events(session, controller.signal).then(result => {
      if (live) setEvents(result);
    }).catch(e => {
      if (live) { setError(errorText(e)); onAuthError(e); }
    }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; controller.abort(); };
  }, [session, reload, onAuthError]);

  return <ScrollView contentContainerStyle={s.page}>
    <Brand />
    <Text style={s.title}>Choose an event</Text>
    <Text style={s.copy}>Check the date and location before opening the camera.</Text>
    {busy ? <ActivityIndicator size="large" color={C.red} accessibilityLabel="Loading events" /> :
      error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> :
      events.length === 0 ? <Text style={s.notice}>No events available for this account.</Text> :
      events.map(event => <Pressable key={event.id} accessibilityRole="button"
        onPress={() => onSelect(event)} style={s.event}>
        {event.isTest && <Text style={s.badge}>TEST EVENT</Text>}
        <Text style={s.eventTitle}>{event.title}</Text>
        <Text style={s.copy}>{new Date(event.startsAt).toLocaleString()}</Text>
        <Text style={s.copy}>{event.location}</Text>
        <Text style={s.eventAction}>Open scanner →</Text>
      </Pressable>)}
    <Button title="Refresh events" secondary disabled={busy} onPress={() => setReload(x => x + 1)} />
    <Button title="Sign out" secondary onPress={onLogout} />
  </ScrollView>;
}

function Scanner({ session, event, onBack, onAuthError, onLogout }: AuthProps & {
  event: StaffEvent; onBack: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const soundValid = useAudioPlayer(require('../assets/sounds/valid.wav'));
  const soundUsed = useAudioPlayer(require('../assets/sounds/already_used.wav'));
  const soundInvalid = useAudioPlayer(require('../assets/sounds/invalid.wav'));
  const [gate] = useState(() => new ScanGate(() => Crypto.randomUUID()));
  const [, render] = useState(0);
  const update = () => render(x => x + 1);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [cameraError, setCameraError] = useState('');
  const attempt = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const live = useRef(true);
  const state = gate.state;
  gate.active = active;

  useEffect(() => {
    // Door staff must hear results even with the iOS silent switch on.
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      const foreground = next === 'active';
      gate.active = foreground;
      if (!foreground) {
        attempt.current++;
        controller.current?.abort();
        if (gate.state.phase === 'submitting') {
          gate.fail(gate.state.request, 'Check interrupted. Retry this same ticket before admitting anyone.');
        }
      }
      setActive(foreground);
      render(x => x + 1);
    });
    return () => {
      live.current = false;
      gate.active = false;
      attempt.current++;
      controller.current?.abort();
      sub.remove();
    };
  }, [gate]);

  async function send(request: ScanRequest) {
    const currentAttempt = ++attempt.current;
    const abort = new AbortController();
    controller.current = abort;
    update();
    try {
      const result = await api.scan(session, request, abort.signal);
      if (!live.current || attempt.current !== currentAttempt) return;
      if (gate.finish(request, result)) {
        const type = result.status === 'valid' ? Haptics.NotificationFeedbackType.Success :
          result.status === 'already_used' ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Error;
        void Haptics.notificationAsync(type).catch(() => undefined);
        // Audio failure never changes the displayed result.
        try {
          const player = result.status === 'valid' ? soundValid : result.status === 'already_used' ? soundUsed : soundInvalid;
          void Promise.resolve(player.seekTo(0)).catch(() => undefined);
          player.play();
        } catch { /* sound is best-effort feedback */ }
        update();
      }
    } catch (e) {
      if (!live.current || attempt.current !== currentAttempt) return;
      onAuthError(e);
      gate.fail(request, errorText(e));
      update();
    }
  }

  function onCode(code: string) {
    if (AppState.currentState !== 'active') return;
    const request = gate.begin(event.id, code);
    if (request) void send(request);
  }

  function signOut() {
    if (state.phase === 'submitting' || state.phase === 'retry') {
      Alert.alert('Ticket outcome unknown', 'This check may already have reached the server. Do not admit the ticket without a confirmed result. Signing out discards the pending retry.', [
        { text: 'Keep checking', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: onLogout },
      ]);
    } else onLogout();
  }

  const result = state.phase === 'result' ? state.result : null;
  const resultTitle = result?.status === 'valid' ? 'VALID' : result?.status === 'already_used' ? 'ALREADY USED' : 'INVALID';
  const resultColor = result?.status === 'valid' ? C.green : result?.status === 'already_used' ? C.amber : C.red;
  return <ScrollView contentContainerStyle={s.page}>
    <Text style={s.eyebrow}>KOORTS / CHECK-IN</Text>
    {event.isTest && <Text style={s.badge}>TEST EVENT — NOT LIVE ADMISSION</Text>}
    <Text style={s.eventTitle}>{event.title}</Text>
    <Text style={s.small}>{new Date(event.startsAt).toLocaleString()} · {event.location}</Text>
    {!active ? <View style={s.panel}><Text style={s.title}>Scanner paused</Text><Text style={s.copy}>Return to the app to continue.</Text></View> :
      state.phase === 'ready' ? <>
        {!permission ? <ActivityIndicator color={C.red} /> :
          !permission.granted ? <View style={s.panel}>
            <Text style={s.title}>Camera access</Text>
            <Text style={s.copy}>The camera reads ticket QR codes. No photos or videos are saved.</Text>
            <Button title={permission.canAskAgain ? 'Allow camera' : 'Open device settings'}
              onPress={() => {
                if (permission.canAskAgain) void requestPermission().catch(() => setCameraError('Could not request camera access.'));
                else void Linking.openSettings().catch(() => setCameraError('Open Settings manually to allow camera access.'));
              }} />
          </View> : cameraError ? <View style={s.panel}>
            <Text style={s.error}>{cameraError}</Text>
            <Button title="Retry camera" onPress={() => setCameraError('')} />
          </View> : <View style={s.cameraFrame}>
            <CameraView style={s.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => onCode(data)}
              onMountError={() => setCameraError('Camera unavailable. Close other camera apps and try again.')} />
            <View pointerEvents="none" style={s.cameraGuide} />
          </View>}
        <Text style={s.notice}>Place one ticket QR code in view. Keep the device online.</Text>
      </> : state.phase === 'submitting' ? <View style={s.panel}>
        <ActivityIndicator size="large" color={C.red} />
        <Text style={s.title}>Checking…</Text>
        <Text style={s.copy}>Wait for server confirmation. Do not admit yet.</Text>
      </View> : state.phase === 'retry' ? <View style={s.panel}>
        <Text accessibilityRole="alert" style={[s.status, { color: C.red }]}>NOT CONFIRMED</Text>
        <Text style={s.copy}>{state.message}</Text>
        <Text style={s.small}>{session.provider === 'tickable'
          ? 'The camera stays paused. If the previous check did reach Tickable, the retry shows ALREADY USED with a scan time of moments ago — that person may be admitted once.'
          : 'The camera stays paused. Retry sends the same ticket and request ID, even if the previous check reached the server.'}</Text>
        <Button title="Retry same check" onPress={() => { const request = gate.retry(); if (request) void send(request); }} />
      </View> : result ? <View style={s.panel} accessibilityLiveRegion="assertive">
        <Text style={[s.status, { color: resultColor }]}>{resultTitle}</Text>
        <Text style={s.copy}>{result.status === 'valid' ? 'Admission confirmed by the server.' :
          result.status === 'already_used' ? 'This ticket was already checked in. Do not admit again.' : 'Ticket not accepted. Do not admit.'}</Text>
        {!!result.scannedAt && <Text style={s.small}>Checked: {new Date(result.scannedAt).toLocaleString()}</Text>}
        <Button title="Next ticket" onPress={() => { gate.next(); update(); }} />
      </View> : null}
    <Button title="Change event" secondary disabled={state.phase === 'submitting' || state.phase === 'retry'} onPress={onBack} />
    <Button title="Sign out" secondary onPress={signOut} />
    <Text style={s.small}>Online verification only · No attendee details displayed</Text>
  </ScrollView>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [event, setEvent] = useState<StaffEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [storageBlocked, setStorageBlocked] = useState(false);
  const ending = useRef(false);

  const endSession = useCallback(async (revoke: boolean, message: string) => {
    if (ending.current) return;
    ending.current = true;
    const previous = sessionRef.current;
    sessionRef.current = null;
    api.cancelRequests();
    setSession(null);
    setEvent(null);
    setLoading(true);
    let note = message;
    try { await clearSession(); } catch {
      note = 'Secure storage could not be cleared. Retry clearing it before sharing this device.';
      setStorageBlocked(true);
    }
    if (revoke && previous) {
      try { await api.logout(previous); } catch {
        note += ' Server revocation could not be confirmed; ask an administrator to revoke this session.';
      }
    }
    setNotice(note);
    setLoading(false);
    ending.current = false;
  }, []);

  const onAuthError = useCallback((error: unknown) => {
    if (error instanceof api.ApiError && error.status === 401) void endSession(false, 'Session expired. Sign in again.');
  }, [endSession]);

  useEffect(() => {
    let live = true;
    void readSession().then(saved => {
      if (live) { sessionRef.current = saved; setSession(saved); }
    }).catch(() => {
      if (live) {
        setNotice('Secure storage unavailable. Clear the saved session before signing in.');
        setStorageBlocked(true);
      }
    }).finally(() => { if (live) setLoading(false); });
    const checkExpiry = () => {
      const current = sessionRef.current;
      if (current && Date.parse(current.expiresAt) <= Date.now()) void endSession(false, 'Session expired. Sign in again.');
    };
    const timer = setInterval(checkExpiry, 1000);
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') api.cancelRequests();
      else checkExpiry();
    });
    return () => { live = false; clearInterval(timer); sub.remove(); api.cancelRequests(); };
  }, [endSession]);

  async function acceptSession(value: Session) {
    if (!isLogin(value)) throw new Error('Invalid session.');
    try { await saveSession(value); } catch {
      void api.logout(value).catch(() => undefined);
      throw new Error('Cannot save a secure session. Sign in was cancelled.');
    }
    if (AppState.currentState !== 'active') {
      await clearSession();
      void api.logout(value).catch(() => undefined);
      return;
    }
    sessionRef.current = value;
    setSession(value);
    setEvent(null);
    setNotice('');
  }
  const onLogout = () => { void endSession(true, 'Signed out.'); };
  async function retryClear() {
    setLoading(true);
    try {
      await clearSession();
      setStorageBlocked(false);
      setNotice('Saved session cleared. Sign in again.');
    } catch { setNotice('Secure storage is still unavailable. Restart the device and retry.'); }
    finally { setLoading(false); }
  }

  return <SafeAreaProvider><SafeAreaView style={s.root}>
    <StatusBar style="dark" />
    {loading ? <View style={[s.flex, s.center]}><ActivityIndicator size="large" color={C.red} /><Text style={s.copy}>Securing session…</Text></View> :
      storageBlocked ? <View style={s.page}><Brand /><Text style={s.title}>Secure storage unavailable</Text>
        <Text accessibilityRole="alert" style={s.error}>{notice}</Text>
        <Button title="Clear saved session" onPress={() => void retryClear()} /></View> :
      !session ? <Login onLogin={acceptSession} notice={notice} /> :
      !event ? <EventList session={session} onSelect={setEvent} onAuthError={onAuthError} onLogout={onLogout} /> :
      <Scanner key={event.id} session={session} event={event} onBack={() => setEvent(null)} onAuthError={onAuthError} onLogout={onLogout} />}
  </SafeAreaView></SafeAreaProvider>;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.cream },
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 20 },
  page: { padding: 24, gap: 16, flexGrow: 1, maxWidth: 640, width: '100%', alignSelf: 'center' },
  brand: { paddingVertical: 20, gap: 12, alignItems: 'flex-start' },
  logo: { width: 220, height: 85 },
  eyebrow: { color: C.red, fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  title: { color: C.black, fontSize: 30, fontWeight: '800' },
  copy: { color: C.black, fontSize: 16, lineHeight: 24 },
  label: { color: C.black, fontWeight: '700', fontSize: 15, marginBottom: -8 },
  input: { borderWidth: 1, borderColor: C.black, padding: 16, borderRadius: 8, color: C.black, fontSize: 17, backgroundColor: '#faf8f2' },
  button: { minHeight: 54, backgroundColor: C.red, borderRadius: 8, padding: 16, justifyContent: 'center', alignItems: 'center' },
  secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.black },
  buttonText: { color: '#fff', fontWeight: '800', fontSize: 17, textAlign: 'center' },
  dim: { opacity: 0.45 },
  small: { color: C.muted, fontSize: 13, lineHeight: 20 },
  error: { color: '#a62617', fontSize: 16, lineHeight: 24 },
  notice: { color: C.black, fontSize: 16, lineHeight: 24, paddingVertical: 8 },
  event: { borderWidth: 1, borderColor: C.black, borderRadius: 10, padding: 20, gap: 8 },
  eventTitle: { color: C.black, fontWeight: '800', fontSize: 24 },
  eventAction: { color: '#a62617', fontWeight: '800', fontSize: 16, marginTop: 8 },
  badge: { color: '#fff', backgroundColor: C.black, fontSize: 12, fontWeight: '800', paddingVertical: 6, paddingHorizontal: 10, alignSelf: 'flex-start' },
  panel: { paddingVertical: 30, gap: 20, minHeight: 300, justifyContent: 'center' },
  status: { fontWeight: '900', fontSize: 38 },
  cameraFrame: { height: 320, borderRadius: 12, overflow: 'hidden', backgroundColor: C.black, position: 'relative' },
  camera: { flex: 1 },
  cameraGuide: { position: 'absolute', top: '15%', left: '15%', width: '70%', height: '70%', borderWidth: 3, borderColor: C.cream, borderRadius: 16 },
});
