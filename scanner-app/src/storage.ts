import * as SecureStore from 'expo-secure-store';
import { isLogin, isRecord, normalizeBaseUrl } from './core';
import type { Session } from './core';

const KEY = 'koorts.scanner.session';
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // Overwrite as a fallback if deletion fails; never restore an old credential.
    await SecureStore.setItemAsync(KEY, '', OPTIONS);
  }
}

export async function readSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.baseUrl !== 'string') throw new Error('Invalid session');
    const baseUrl = normalizeBaseUrl(value.baseUrl, __DEV__);
    if (!isLogin(value) || Date.parse(value.expiresAt) <= Date.now()) throw new Error('Invalid session');
    return { ...value, baseUrl };
  } catch {
    await clearSession();
    return null;
  }
}

export async function saveSession(session: Session): Promise<void> {
  // Deliberately whitelist the response: passwords and arbitrary server fields never enter storage.
  await SecureStore.setItemAsync(KEY, JSON.stringify({
    baseUrl: session.baseUrl,
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: session.user.id, username: session.user.username, role: session.user.role },
    ...(session.provider === 'tickable' ? { provider: 'tickable' } : {}),
  }), OPTIONS);
}
