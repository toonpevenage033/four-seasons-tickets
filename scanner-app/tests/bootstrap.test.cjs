const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const React = require('react');
const { act, create } = require('react-test-renderer');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const session = {
  baseUrl: 'https://backend.example.org',
  token: 'test-token',
  expiresAt: '2099-01-01T00:00:00Z',
  user: { id: '1', username: 'door', role: 'staff' },
};

// Execute the real TypeScript entrypoint and components; only native bridges are stubbed.
function harness(initialSession = null) {
  const cache = new Map();
  const assets = [];
  const haptics = [];
  const sounds = [];
  const storageCalls = [];
  const openedUrls = [];
  let openUrlFails = false;
  let saved = initialSession ? JSON.stringify(initialSession) : null;
  let deleteFails = false;
  let writeFails = false;
  let registered;
  const secureStore = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
    getItemAsync: async () => saved,
    setItemAsync: async (key, value, options) => {
      storageCalls.push(['set', key, value, options]);
      if (writeFails) throw Error('Secure storage unavailable');
      saved = value;
    },
    deleteItemAsync: async key => {
      storageCalls.push(['delete', key]);
      if (deleteFails) throw Error('Delete unavailable');
      saved = null;
    },
  };
  const native = {
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Platform: { OS: 'ios' },
    StyleSheet: { create: value => value },
    Linking: {
      openSettings: async () => {},
      openURL: async url => {
        openedUrls.push(url);
        if (openUrlFails) throw Error('Browser unavailable');
      },
    },
    Alert: { alert() {} },
  };
  for (const name of ['ActivityIndicator', 'Image', 'KeyboardAvoidingView', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View']) {
    native[name] = name;
  }
  const mocks = {
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
    expo: { registerRootComponent: component => { registered = component; } },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    'expo-camera': { CameraView: 'CameraView', useCameraPermissions: () => [{ granted: true }, async () => {}] },
    'expo-crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    'expo-haptics': {
      NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
      notificationAsync: async type => { haptics.push(type); },
    },
    'expo-secure-store': secureStore,
    'expo-audio': {
      setAudioModeAsync: async () => {},
      useAudioPlayer: source => ({ seekTo: async () => {}, play: () => { sounds.push(source); } }),
    },
  };

  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    if (filename.endsWith('.png')) {
      assert.equal(fs.readFileSync(filename).subarray(1, 4).toString(), 'PNG');
      assets.push(filename);
      return 1;
    }
    if (filename.endsWith('.wav')) {
      assert.equal(fs.readFileSync(filename).subarray(0, 4).toString(), 'RIFF');
      assets.push(filename);
      return filename;
    }
    const module = { exports: {} };
    cache.set(filename, module);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const localRequire = id => {
      if (mocks[id]) return mocks[id];
      assert.ok(id.startsWith('.'), `Unexpected native dependency: ${id}`);
      const base = path.resolve(path.dirname(filename), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`].find(candidate => fs.existsSync(candidate));
      assert.ok(resolved, `Missing module ${id}`);
      return load(resolved);
    };
    vm.runInThisContext(`(function(require,module,exports,__DEV__){${output}\n})`, { filename })(localRequire, module, module.exports, false);
    return module.exports;
  }

  load(path.resolve(__dirname, '../index.ts'));
  return {
    App: registered, assets, haptics, sounds, storageCalls, openedUrls,
    storage: load(path.resolve(__dirname, '../src/storage.ts')),
    get saved() { return saved; },
    set deleteFails(value) { deleteFails = value; },
    set writeFails(value) { writeFails = value; },
    set openUrlFails(value) { openUrlFails = value; },
  };
}

function text(tree) {
  return tree.root.findAllByType('Text').map(node => node.children.join('')).join('\n');
}
function button(tree, title) {
  const node = tree.root.findAllByType('Pressable').find(node => node.findAllByType('Text').some(child => child.children.join('') === title));
  assert.ok(node, `Button not found: ${title}`);
  return node;
}

test('real entrypoint registers App and renders login with its bundled logo', async () => {
  const h = harness();
  assert.equal(typeof h.App, 'function');
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    assert.match(text(tree), /Staff sign in/);
    assert.equal(tree.root.findAllByType('TextInput').length, 3);
    assert.equal(tree.root.findByType('Image').props.source, 1);
    assert.ok(h.assets.some(asset => asset.endsWith('/assets/logo.png')));
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('privacy policy opens before login in both modes and reports browser failures', async () => {
  const h = harness();
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await act(async () => button(tree, 'Privacy policy').props.onPress());
    await act(async () => button(tree, 'Use a Tickable API key instead').props.onPress());
    await act(async () => button(tree, 'Privacy policy').props.onPress());
    assert.deepEqual(h.openedUrls, [
      'https://koortsevents.nl/scanner-privacy.html',
      'https://koortsevents.nl/scanner-privacy.html',
    ]);
    h.openUrlFails = true;
    await act(async () => button(tree, 'Privacy policy').props.onPress());
    assert.match(text(tree), /Could not open the privacy policy/);
  } finally { if (tree) await act(async () => tree.unmount()); }
});

test('rendered scanner preserves request ID through transport failure and never auto-scans green result; logout clears secure storage', async () => {
  const h = harness(session);
  const originalFetch = globalThis.fetch;
  const scans = [];
  let revoke = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/events')) return Response.json({
      events: [{ id: 'e', title: 'Door event', startsAt: '2026-11-03T19:00:00Z', location: 'Hall', isTest: true }],
    });
    if (String(url).endsWith('/logout')) {
      revoke = true;
      assert.equal(h.saved, null, 'local secret must clear before server revocation');
      return new Response(null, { status: 204 });
    }
    scans.push(JSON.parse(init.body));
    if (scans.length === 1) throw Error('Lost network');
    return Response.json({ status: 'valid', message: 'Accepted', scannedAt: null });
  };
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    const event = tree.root.findAllByType('Pressable').find(node =>
      node.findAllByType('Text').some(child => child.children.join('') === 'Door event'));
    await act(async () => event.props.onPress());
    const callback = tree.root.findByType('CameraView').props.onBarcodeScanned;
    await act(async () => {
      callback({ data: 'opaque-ticket' });
      callback({ data: 'opaque-ticket' });
    });
    assert.match(text(tree), /NOT CONFIRMED/);
    assert.equal(scans.length, 1);
    assert.equal(h.haptics.length, 0);
    assert.equal(h.sounds.length, 0);
    assert.equal(tree.root.findAllByType('CameraView').length, 0);
    await act(async () => button(tree, 'Retry same check').props.onPress());
    assert.deepEqual(scans[0], scans[1]);
    assert.match(text(tree), /VALID/);
    assert.deepEqual(h.haptics, ['success']);
    assert.equal(h.sounds.length, 1);
    assert.match(String(h.sounds[0]), /valid\.wav$/);
    await act(async () => callback({ data: 'another-ticket' }));
    assert.equal(scans.length, 2);
    assert.equal(tree.root.findAllByType('CameraView').length, 0);
    await act(async () => button(tree, 'Next ticket').props.onPress());
    assert.equal(tree.root.findAllByType('CameraView').length, 1);
    await act(async () => button(tree, 'Sign out').props.onPress());
    assert.equal(h.saved, null);
    assert.equal(revoke, true);
    assert.match(text(tree), /Staff sign in/);
  } finally {
    if (tree) await act(async () => tree.unmount());
    globalThis.fetch = originalFetch;
  }
});

test('SecureStore whitelists session without passwords and clears even if delete fails', async () => {
  const h = harness();
  await h.storage.saveSession({ ...session, password: 'must-not-persist', user: { ...session.user, password: 'also-not' } });
  assert.deepEqual(JSON.parse(h.saved), session);
  assert.equal(h.storageCalls[0][3].keychainAccessible, 'device-only');
  h.deleteFails = true;
  await h.storage.clearSession();
  assert.equal(h.saved, '');
  assert.equal(await h.storage.readSession(), null);
  h.writeFails = true;
  await assert.rejects(h.storage.clearSession(), /Secure storage unavailable/);
});

test('failed remote revocation still clears local credential and visibly warns operator', async () => {
  const h = harness(session);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/events')) return Response.json({ events: [] });
    throw Error('Network unavailable');
  };
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    await act(async () => button(tree, 'Sign out').props.onPress());
    assert.equal(h.saved, null);
    assert.match(text(tree), /Server revocation could not be confirmed/);
    assert.match(text(tree), /Staff sign in/);
  } finally {
    if (tree) await act(async () => tree.unmount());
    globalThis.fetch = originalFetch;
  }
});

test('logout blocks login if both secure deletion and overwrite fail; clearing can be retried', async () => {
  const h = harness(session);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith('/events')
    ? Response.json({ events: [] }) : new Response(null, { status: 204 });
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(h.App)); });
    h.deleteFails = true;
    h.writeFails = true;
    await act(async () => button(tree, 'Sign out').props.onPress());
    assert.match(text(tree), /Secure storage unavailable/);
    assert.equal(tree.root.findAllByType('TextInput').length, 0);
    h.deleteFails = false;
    h.writeFails = false;
    await act(async () => button(tree, 'Clear saved session').props.onPress());
    assert.equal(h.saved, null);
    assert.match(text(tree), /Staff sign in/);
  } finally {
    if (tree) await act(async () => tree.unmount());
    globalThis.fetch = originalFetch;
  }
});
