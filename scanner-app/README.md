# KOORTS private staff scanner

Real Android/iOS Expo React Native TypeScript app. Uses the supplied KOORTS artwork, cream `#f1ecdf`, black `#1c1b18`, and red `#e94028`. No backend changes, public ticket page, embedded credentials, analytics, or paid-service actions.

## Development

Use Node **24.3+** (tested with 24.21; Node 22.18+ also supports the TypeScript test runner), npm, and an SDK 58-compatible Expo Go or development build.

```sh
cd scanner-app
npm ci
npm start -- --lan
```

Open the Metro QR with Expo Go on a **physical device** on the same Wi-Fi. This Metro QR opens the app; the in-app camera scans **ticket** QR codes. Allow camera access. Expo Go must support this Expo SDK; otherwise use a local development build below. Simulators generally cannot validate the real camera workflow. No web scanner is provided.

The login screen asks for the backend **origin**, e.g. `https://tickets.example.org` (not `/api`), staff username and password. There is intentionally no default server or account. Have the backend listen on `0.0.0.0` and allow its port through the development machine's firewall. On a phone, `localhost` means the phone, **not your laptop**; use the laptop's private LAN IP. Metro and the API are separate servers/ports. Prefer a trusted HTTPS certificate; self-signed HTTPS is not automatically trusted.

Development JavaScript (`__DEV__`) permits HTTP **only** for explicit `localhost`, IPv4 loopback, `10/8`, `172.16/12`, `192.168/16`, or `[::1]`. Public DNS names, `0.0.0.0`, and public IPs cannot use HTTP. Release JavaScript always requires HTTPS.

For a **local debug native build** that also permits LAN HTTP at the native transport layer:

```sh
SCANNER_DEV_HTTP=1 npx expo run:android --device
# macOS, Xcode, and an appropriate signing team/device are needed:
SCANNER_DEV_HTTP=1 npx expo run:ios --device
```

Then enter e.g. `http://192.168.1.25:3000`. This explicit flag enables native ATS/cleartext exceptions, not the JavaScript URL policy. Do **not** set it for distribution builds. It requires a native rebuild; restarting Metro alone cannot change native transport permissions. Expo Go's own network configuration is controlled by Expo Go, not this project. On iOS, allow the local-network prompt when developing.

For HTTPS-only native development, omit the flag. Android SDK/JDK and USB debugging are required for Android; Xcode, CocoaPods and iOS tooling are required for iOS. Generated `android/` and `ios/` folders stay inside this directory and are ignored. If reusing previously generated native folders after changing configuration, regenerate them with `npx expo prebuild --clean` (this replaces those generated folders).

## Exact backend contract

All responses are JSON except the successful logout. Protected requests use `Authorization: Bearer <token>`; cookies are not used. There is no `/api` prefix duplication or URL interpretation of a ticket.

| Method / path | Request | Successful response |
| --- | --- | --- |
| `POST /api/staff/login` | `{username,password}` | `{token:string,expiresAt:ISO,user:{id:string,username:string,role:'staff'\|'admin'}}` |
| `GET /api/staff/events` | Bearer token | `{events:[{id:string,title:string,startsAt:ISO,location:string,isTest:boolean}]}` |
| `POST /api/staff/scan` | Bearer token; `{eventId:string,code:string,requestId:UUID}` | `{status:'valid'\|'already_used'\|'invalid',message:string,scannedAt:ISO\|null}` |
| `POST /api/staff/logout` | Bearer token; empty JSON object | `204` |

Errors: `{error:{code:string,message:string}}` with a non-2xx HTTP status. `401` expires the local session and returns to login; `403` shows forbidden; `429` asks the operator to wait, without automatic retries. Network/timeout/5xx failures show **NOT CONFIRMED** and require an explicit retry. Response shapes are validated; malformed success responses cannot grant admission. Timestamps must be ISO date-times with a timezone.

The backend must atomically redeem tickets and store/replay a scan result keyed by `requestId`, with appropriate staff/event authorization and stable idempotency across retries. The client cannot provide exactly-once redemption by itself. A lost response followed by retry must replay the original result, **not** turn the original successful check into `already_used`.

QR data is sent **verbatim** as an opaque code: never trimmed, decoded, navigated to, or parsed as a URL. Never return attendee details in `message`; the result UI intentionally uses fixed status copy rather than displaying this field. (Tickable mode is the single exception: the ticket UUID is extracted from the QR contents, see below.)

## Tickable platform mode

Instead of the private backend, the scanner can validate tickets sold through [Tickable](https://tickable.nl) directly against `https://api.tickable.io`:

- On the login screen choose **Use a Tickable API key instead** and paste an API key created in the Tickable dashboard (Settings → Developers). Create a dedicated key limited to the `events.read`, `tickets.read` and `tickets.write` scopes; `tickets.write` is required for scanning.
- The key is validated via `GET /whoami`, stored only in the device's secure storage, and expires locally after 30 days (Tickable keys do not expire server-side — revoke lost keys in the Tickable dashboard, as sign-out only clears the device).
- Events come from `GET /events`; the displayed date is the first timeslot's start (falling back to the event's creation date). Scans call `POST /tickets/{ticket_id}/scan`; the ticket UUID is extracted from the QR contents. Statuses map as `valid → VALID`, `scanned → ALREADY USED`, and `cancelled`/`not_allowed`/unknown ticket/foreign QR → INVALID. A ticket belonging to a different event than the one selected is reported INVALID — note that Tickable may already have registered that scan.
- Tickable has no idempotent `requestId`. If a check fails mid-flight and the retry shows **ALREADY USED** with a scan time of moments ago, the first attempt reached Tickable: that person may be admitted once. Scanner profile rules, scan windows and timeslot restrictions configured in Tickable are enforced server-side.

## Safety and operator behavior

- Staff/admin login, event selection with date/location, prominent **TEST EVENT** badge.
- Native QR-only camera; permission denial provides a Settings path. No image, video, audio, or QR history is recorded.
- A synchronous gate allows only one in-flight check. Repeated callbacks are suppressed; identical codes have a two-second cooldown. Camera unmounts while checking, on failures and on results. **Next ticket** explicitly resumes it after a confirmed result.
- Only the server's `valid` result grants admission and produces success haptics. `already_used` gives warning haptics; `invalid` gives error haptics. Each confirmed result also plays a distinct sound (rising beeps, double mid tone, or low buzzer) that works with the iOS silent switch on. Haptic or audio hardware failure never changes the result. No offline green state.
- Requests abort after 12 seconds. Background/inactive state suspends the camera and aborts transport; late results are discarded. Interrupted checks remain unconfirmed and retryable when foregrounded.
- A retry reuses the **same request object, UUID, event and code**. Event switching is blocked while a result is uncertain. Logout warns before discarding an uncertain check.
- Pending retries live in memory only, not a durable offline queue. Force-closing the app, OS process death, logout or auth expiry loses that pending request ID. If this happens after an ambiguous check, do **not** assume admission: reconcile it with authorized backend staff before rescanning/admitting.
- SecureStore stores only the backend origin, bearer token, expiry and staff identity. Password input clears on submission and is never persisted. No secrets are included in app configuration or logs.
- Logout immediately clears local credentials and attempts server revocation. Failed revocation is visibly reported: administrators must revoke that server session if needed. Secure-storage failures block login until clearing succeeds. iOS Keychain entries can survive uninstall; do not rely on uninstall alone to revoke sessions. Lost-device sessions must be revoked on the backend.
- Expired saved tokens are removed. A running session is checked for expiry every second and before protected requests; a backend `401` is authoritative. There is no refresh-token endpoint.

## Validation

```sh
npm run typecheck
npm test
npx expo install --check
npx expo config --type public
npx expo export --platform all --output-dir dist
```

The Node tests cover QR gating, duplicate suppression, explicit next scan, background suspension, byte-for-byte idempotent retry, exact API calls, expiry, malformed responses, HTTP errors, aborts/timeouts, and URL restrictions. The component smoke tests execute the real `index.ts` registration and render the actual app using React's test renderer with native bridges mocked: login and logo, event selection, transport failure/retry with the same request ID, a paused success result with one success haptic, logout revocation/secure deletion, deletion fallback and blocked-login recovery when secure storage fails. This is JavaScript rendering evidence, **not** a native device render or camera test. React's matching-version test renderer emits a deprecation warning but is used only in development tests.

Implementation validation: Expo **58.0.22**, React Native **0.88.1**, React **19.3.0**; dependency install, TypeScript, Expo dependency compatibility and Android/iOS Metro export passed. The logo is included in both Metro bundles; the pictogram PNG exists and is referenced by native icon/splash configuration. Follow-up Android validation passed TypeScript and all 20 tests, a local Gradle release build, release-key APK signature verification and 16 KB ZIP alignment. The APK includes its JavaScript, is not debuggable, disallows cleartext traffic, and contains both ARM phone architectures. No physical Android installation/camera test or TestFlight upload has been performed. Run these acceptance checks on both actual platforms before distributing:

1. Valid staff/admin login, bad credentials, expired token, denied staff access.
2. Select the correct event/test badge; allow/deny camera permission and return from Settings.
3. Hold one QR still: one request only. Verify each result/haptic; confirm no more scans until Next ticket.
4. Drop the network after POST reaches the server; reconnect and retry. Confirm identical request ID and original replayed result. Verify 5xx, 429 and timeout never admit.
5. Background during POST and reopen; retry the interrupted check. Check explicit Next behavior and logout/revocation.

### Dependency advisories (follow-up audit)

`npm audit fix --ignore-scripts` was run without `--force` to apply only permitted semver-compatible resolutions. `expo install --check` still passes. **11 moderate package entries remain, representing two underlying advisories**, not 11 independent flaws; there are no high/critical entries:

- [`glob` GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4): AbortSignal cancellation bypass can continue filesystem traversal after timeout (resource exhaustion). Installed **13.0.6**; the first fixed version is **14.0.2**, outside Expo's `^13.0.0` requirement.
- [`minimatch` GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): globparts amplification can cause denial of service. Installed **10.2.6**; fixed in **11.0.1**, outside its consumers' `^10.2.2` requirement.

The other nine entries are dependent packages: `expo`, `@expo/cli`, `@expo/config`, `@expo/config-plugins`, `@expo/fingerprint`, `@expo/inline-modules`, `@expo/local-build-cache-provider`, `@expo/metro-config`, and `@expo/prebuild-config`. These paths are Expo build/development tooling, not ticket parsing or backend request processing. Do not feed untrusted filesystem glob patterns to those tools. No in-range advisory fix is currently available; no major overrides, forced updates or SDK downgrade were applied. `npm audit` suggests an older incompatible SDK with `--force`, which is not an appropriate fix. Review upstream SDK-compatible fixes before distribution.

## APK and iOS distribution

### Local Android APK

The local release setup uses Homebrew Java 17 and the Android command-line SDK, without an emulator or a hosted build service. Google SDK licenses must be accepted by the owner. The APK includes its JavaScript and does not require Metro or the Mac after installation.

Local signing material is stored outside this repository in `~/.config/koorts-scanner/`: `release.keystore` and `signing-password`, with private filesystem permissions. Keep a secure backup of both; updates must use the same signing key. Never send these files to staff or commit them. Staff receive only `dist/KOORTS-Scanner-1.0.0.apk`.

To rebuild on this Mac, run from `scanner-app/`:

1. Unset `SCANNER_DEV_HTTP`. If generating Android again, use `npx expo prebuild --platform android --no-install` (not an iOS or clean prebuild).
2. In generated `android/app/build.gradle`, set **only the release build type's** `signingConfig` to `null`. The generated default otherwise signs releases with a public debug key. This local generated-file change is ignored by Git and must be repeated after regeneration.
3. Build, align, sign and verify using the existing private key:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$JAVA_HOME/bin:$PATH"
unset SCANNER_DEV_HTTP
(cd android && ./gradlew :app:assembleRelease --no-daemon --max-workers=2 \
  -PreactNativeArchitectures=armeabi-v7a,arm64-v8a)
# Continue only if the build succeeds.
mkdir -p dist
"$ANDROID_HOME/build-tools/37.0.0/zipalign" -f -P 16 4 \
  android/app/build/outputs/apk/release/app-release-unsigned.apk dist/scanner-aligned.apk
"$ANDROID_HOME/build-tools/37.0.0/apksigner" sign \
  --ks "$HOME/.config/koorts-scanner/release.keystore" --ks-key-alias koorts-scanner \
  --ks-pass "file:$HOME/.config/koorts-scanner/signing-password" \
  --out dist/KOORTS-Scanner-1.0.0.apk dist/scanner-aligned.apk
"$ANDROID_HOME/build-tools/37.0.0/apksigner" verify --verbose dist/KOORTS-Scanner-1.0.0.apk
```

Send the APK privately to an approved Android phone. Allow installation from that trusted source, install, then disable that installation permission again. Use backend `https://four-seasons-tickets.onrender.com` and a separate staff account, not the administrator's credentials. Internet and camera access are required. Before team distribution, test login, event selection, a valid QR and a duplicate scan on a physical Android phone; a successful build does not verify its camera. Increase Android `versionCode` for subsequent releases.

### Hosted builds and iOS

Identifiers are `com.koortsevents.scanner` on both platforms. `eas.json` contains an **internal Android APK** profile:

```sh
# Optional hosted build; requires your own Expo account/project and may consume service quota.
# Run only when you choose to authorize a build:
npx eas-cli@latest build --platform android --profile internal
```

An APK can be privately installed on approved Android devices (allow installation from your trusted source). A local release build is another option: generate the native project, configure **your own** release keystore/signing, and use Gradle/Xcode. Never distribute debug-key builds as production or commit signing credentials. Unset `SCANNER_DEV_HTTP` and regenerate native configuration before a release.

For iOS TestFlight, you need an Apple Developer Program membership, your own team/certificate, a matching provisioning profile and App Store Connect record, registered capabilities, and signing authorization. The production profile supports an optional `npx eas-cli@latest build --platform ios --profile production`; submission/upload is a **separate, explicitly authorized** action (`eas submit` or Xcode Organizer). Internal iOS/ad-hoc builds instead require a provisioning profile including each device's UDID; the internal profile does not bypass Apple's provisioning rules. Apple membership, hosted-build costs, account creation, signing, build upload and TestFlight review cannot be completed without those external prerequisites. No such actions were performed.
