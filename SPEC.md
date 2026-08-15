# PulseNX — Vitals Stream Suite

Successor to "PulseLink Bridge". Streams real-time heart rate + HRV from a smartwatch
(via an Android phone acting as BLE bridge) to a PC dashboard, VRChat OSC, overlays and OBS.

**Branding:** name `PulseNX`, accent `#7700FF` (NX violet), secondary accent `#00e5ff` (cyan),
heart red `#ff2d55`, dark space theme. Signature footer: `PulseNX — made with Claude`.

## Repo layout

```
pulsenx/
  SPEC.md
  README.md
  branding/            # logo.svg, icon renders
  pc-app/              # Electron app
    package.json
    src/main/          # main process (all node/system logic lives HERE)
      main.js          # entrypoint: app lifecycle, window mgmt
      state.js         # central vitals/session state + processing (pure logic, unit-testable)
      settings.js      # JSON settings store in app.getPath('userData')/settings.json
      ws-server.js     # LAN WebSocket server :9000 (phone -> PC vitals)
      discovery.js     # UDP beacon broadcast :9001 every 2 s
      mqtt-link.js     # cloud transport via mqtt.js -> wss://broker.emqx.io:8084/mqtt
      osc-engine.js    # node-osc client, 1 Hz avatar params + beat pulse + chatbox loops
      obs-server.js    # HTTP :9005 serving the OBS browser-source widget
      discord-rpc.js   # Discord Rich Presence
      connector.js     # NX Hub presence: {hr, connected} on the bus, <=1/s, on change
      nx-connector.js  # VENDORED verbatim from nerdrx/nx-hub docs/connector — do not edit
      csv.js           # session CSV export (save dialog + write) and CSV parse for history
      e2e-hooks.js     # --e2e-hooks loopback DOM probe (port 9010), same design as before
    src/renderer/      # UI only, NO node access (contextIsolation: true, nodeIntegration: false)
      index.html
      overlay.html
      preload.js       # single contextBridge API: window.pulsenx
      js/  css/        # renderer modules, chart.js loaded from local vendor copy
    assets/            # icon.png 512, icon.svg
  android-app/         # Kotlin, package com.pulsenx.bridge
```

## Feature inventory (full parity with PulseLink, all must work)

PC app:
1. **Transports**: cloud MQTT (default, link code) AND LAN WebSocket :9000; UDP discovery beacon :9001.
2. **Link code**: 6-char uppercase alphanumeric, regenerated per launch, shown in header.
   MQTT topic: `pulsenx/vitals/pc-<CODE>`. Handshake payloads: `"HELLO"` (phone joined),
   `"BYE"` (phone left). Vitals JSON: `{bpm:int, rr:int(ms), contact:bool, battery:int, rssi:int,
   src?:"ble"|"health"}`. `src` names the sensor the phone read the sample from — the watch BLE
   profile or Health Connect; absent means `"ble"`. It is shown in the link status line and
   changes nothing in the pipeline.
   **Health summary message** (same channel, sent on link-up and every 5 min while linked):
   ```json
   {"type":"health","ts":1734300000000,"summary":{
     "steps":8421,"distanceKm":6.2,"activeKcal":412.5,"totalKcal":1980.0,
     "sleepMin":432,"restingBpm":58,"minBpm":52,"avgBpm":74,"maxBpm":141,
     "spo2Pct":97.0,"source":"huawei"}}
   ```
   Every summary field is nullable (JSON `null` when unknown); `ts` is epoch ms at read time.
   `source` is `"huawei"` when a contributing Health Connect record has a Huawei dataOrigin,
   else `"healthconnect"`. Windows: steps/distance/kcal/min-avg-max BPM = today (local midnight →
   now); `sleepMin` = sleep sessions overlapping the last 24 h; `restingBpm`/`spo2Pct` = the most
   recent sample of today (or the last 24 h). Health messages are routed away from the vitals
   pipeline in `handleVitals` — no OSC, Discord, alarms or recording side effects.
3. **Dashboard**: live BPM display + animated SVG heart (beat speed = real BPM), HRV (rMSSD from
   RR history, window 30), training-zone badge (WarmUp/FatBurn/Aerobic/Anaerobic/Extreme from
   %maxHR), min/max/avg BPM, calories (Keytel formula, gender/age/weight profile), stress index
   0-100 (HR-elevation + HRV-suppression + user offset slider), stress min/max/avg,
   zone-distribution bars, live Chart.js timeline (BPM + stress series, 35-point window,
   bpm/stress/both view tabs), decorative ECG canvas animation.
4. **Session recorder**: start/stop, HH:MM:SS timer, rec indicator, CSV export via native save
   dialog. CSV columns: `Timestamp,Elapsed Time (s),Heart Rate (BPM),RR-Interval (ms),Training Zone,Stress Index`.
5. **History review**: import a session CSV, dual-axis Chart.js timeline (HR left / stress right),
   stats panel (min/max/avg HR, avg stress, duration).
6. **VRChat OSC engine** (node-osc, default 127.0.0.1:9000, master toggle):
   - 1 Hz avatar-parameter broadcaster, single owner of params (full list below).
   - Beat pulse: `HeartBeatPulse/HeartBeat/isHRBeat/HBListen` true→(120 ms)→false at real beat
     frequency (clamped 250–2000 ms), single owner of those params.
   - Chatbox loop every 3 s: `/chatbox/input` with `{bpm}/{hrv}/{stress}` template.
   - Custom single-parameter mode with path presets (standard / VRCOSC).
   - Min/max HR normalization range settings.
   - Only broadcasts when live vitals present (`isHRConnected` never lies).
7. **Overlay**: frameless transparent always-on-top draggable/resizable widget window showing
   BPM + stress (each toggleable), heart animation synced to BPM.
8. **OBS browser source**: `http://localhost:9005` widget page, live via WebSocket to :9000.
9. **Discord Rich Presence**: toggle, template fields with `{bpm}/{hrv}/{zone}/{stress}/{stresstext}`,
   Flatpak/Snap IPC path fix on Linux, client ID `1528026708052283452`.
10. **Breathing pacer**: 5 s inhale / 5 s exhale cycle (6 breaths/min), animated circle, soft
    WebAudio chimes (toggle), coherence flow score 0-100 % (BPM rises on inhale / falls on exhale,
    15-sample window) with glow feedback.
11. **Alarms**: high-HR alarm tone >165 BPM (toggle), custom threshold alarm (BPM limit + duration
    filter) with audio beeper and OSC `HeartRateWarning` bool, "Test audio" button.
12. **Settings autosave**: every control persists (now in userData JSON via main process, not
    localStorage) and restores on launch; workers (OSC loops, Discord) resume per saved state.
13. **Connection status UI**: Awaiting Link / Phone Linked / offline states, phone battery + RSSI
    readout, local LAN endpoint display, link code display. Vitals carrying `src:"health"` add a
    `· HEALTH` marker to the status line.
14. **Daily Health card** (dashboard): the phone's Health Connect daily summary — steps, distance
    (km), active/total kcal, sleep as `7 h 12 m`, resting HR, today's min/avg/max BPM, SpO2 %.
    Unknown fields render `--`, never 0. Carries a source chip (`via Huawei Health` /
    `via Health Connect`) and an `updated HH:MM` stamp from `ts`. Placeholder state until the
    first `health` event; the last summary is cached in main and replayed on dashboard reload.
15. **NX Hub connector** (`connector.js`): announces PulseNX on the NX Hub bus
    (`ws://127.0.0.1:9021`) so the hub's app card and tray show live heart rate. Publishes exactly
    the two fields the hub declares for us — `{hr: int bpm, connected: bool}` — where `connected`
    means the watch/bridge is delivering data, not that the hub socket is up. Sent at most once
    per second and only on a real change (`hr` moved, or `connected` flipped); a throttled update
    is deferred and flushed, never dropped, so the newest reading always wins. When the stream
    stops (`goOffline`) it sends `connected:false` and omits `hr`, leaving the hub's merged
    last-known reading on the card. `shutdown-request` from the hub quits the app. Entirely inert
    and silent when NX Hub is not installed, and suppressed under `--e2e-hooks` so a test run
    cannot evict the real app from its bus slot. The socket layer is `nx-connector.js`, vendored
    verbatim from nx-hub — fixes go upstream, never into our copy.

Android app (`com.pulsenx.bridge`, minSdk 26, target/compile 34):
1. BLE heart-rate profile client (0x180D/0x2A37): scan (15 s timeout, name OR service filter),
   auto-connect to remembered MAC, parse HR packet incl. 16-bit BPM, RR intervals (1024→ms),
   contact bit; unpair action.
2. Foreground service (`connectedDevice` type), wake+wifi locks, boot receiver, notification with
   Rescan / Disconnect actions, live status text.
3. Transports: LAN WS `ws://<ip>:9000` (target entered OR auto-discovered via UDP :9001 beacon);
   cloud mode when the entered target is a link code (no dots) — MQTT over WSS to broker.emqx.io
   using a REAL MQTT client (Paho), topic `pulsenx/vitals/pc-<CODE>`, publish HELLO on connect,
   BYE on disconnect, vitals JSON at notification rate.
4. Auto-reconnect: WS retry 5 s, BLE reconnect 3 s, network-change callback, BT state receiver.
5. Sends phone battery % and watch RSSI with vitals. Haptic alert >165 BPM.
6. Single-screen UI: link code/IP input, Link PC + Scan Watch buttons, status lines, big live BPM.
   New NX dark theme (#7700FF accents), adaptive launcher icon (vector XML).
7. **Huawei Health source via Health Connect**: HR source selector (watch BLE / Health Connect),
   permission flow, daily summary read from Health Connect (Huawei Health's records included) and
   sent to the PC as the `{"type":"health"}` message; live HR from Health Connect is tagged
   `src:"health"`. Optional write-back of BLE-captured HR into Health Connect.
8. **Google Fit sync via Health Connect mirroring**: Huawei-origin records re-written under the
   PulseNX origin (clientRecordId dedup) so Google Fit and other Health Connect readers pick them
   up. Off by default.
9. **Liquid Glass UI**: translucent blurred surfaces over an animated aurora canvas background
   (`ui/AuroraBackgroundView`, pure Canvas, no new dependencies), NX violet/cyan accents.
10. **Huawei Health Kit cloud source**: OAuth-linked REST pull of the watch's daily data
    straight from Huawei's cloud, merged into the daily summary and optionally written back
    into Health Connect. See the section below.

## Huawei Health Kit cloud source

Huawei Health has no native Health Connect integration, so on a GMS phone the watch's steps,
sleep and SpO2 never reach the on-device exchange layer at all. Huawei's Health Kit **cloud**
REST API is the only sanctioned route to them, and it is plain HTTPS + OAuth 2.0 — no HMS Core,
no HMS SDK, no Huawei service framework on the phone. This is PulseNX's free replacement for the
paid "Health Sync" app.

### Setup (per user, one time)

The user registers a **Web** app on HUAWEI Developers, enables Health Service Kit, applies for
the read scopes below, and sets the callback URL to exactly `https://pulsenx.auth/callback`.
The app is parameterised entirely by the pasted **OAuth Client ID + Client Secret** (health card
→ "Huawei Cloud"); nothing is baked into the APK. A test-phase app is capped at 100 beta users,
which is ample for a single user (the cap surfaces as HTTP 403).

### OAuth flow (`HuaweiCloud.kt`, `HuaweiAuthActivity.kt`)

1. `HuaweiAuthActivity` loads
   `https://oauth-login.cloud.huawei.com/oauth2/v3/authorize?response_type=code&client_id=…
   &redirect_uri=https%3A%2F%2Fpulsenx.auth%2Fcallback&scope=…&state=…&access_type=offline&display=touch`
   in an in-app WebView. `access_type=offline` is what makes the refresh token appear;
   `state` is a random nonce checked on the way back.
2. The redirect URI resolves to nothing on the public internet **by design**: the WebView client
   kills the navigation the moment the URL starts with it and reads `?code=` out of it. Nothing
   is ever sent to that host. `?error=access_denied` is the documented user-cancel path.
3. `POST https://oauth-login.cloud.huawei.com/oauth2/v3/token`,
   `grant_type=authorization_code&code&client_id&client_secret&redirect_uri` (form-encoded)
   → `{access_token, expires_in, refresh_token, scope, token_type, id_token}`.
4. Refresh: same endpoint, `grant_type=refresh_token&refresh_token&client_id&client_secret`.
   Access token lives 1 h, refresh token 180 days. `refreshIfNeeded()` is single-flight (a
   `Mutex`) and renews 2 min before the stated expiry.

Tokens, credentials, the granted scope, the last-successful-call stamp and an "auth broken" flag
all live in `SharedPreferences("PulseNXPrefs")` under `HW_*` keys. Unlinking drops the tokens and
keeps the client id/secret.

**Scopes** (`openid` is mandatory): `https://www.huawei.com/healthkit/` + `step.read`,
`distance.read`, `calories.read`, `heartrate.read`, `oxygensaturation.read`, `sleep.read`.

### Data endpoints (`HuaweiKitReader.kt`)

Base host `https://health-api.cloud.huawei.com`. Every call carries
`Authorization: Bearer <access_token>` (note the mandatory space), `Content-Type:
application/json; charset=UTF-8` and the recommended `x-client-id` / `x-version` headers. A 401
triggers exactly one forced refresh + replay; a 401 that survives it flags the link broken.
403 means an unapproved scope (or the beta-user cap), not an expired token.

- `POST /healthkit/v2/sampleSet:dailyPolymerize`
  `{dataTypes:[…], startDay:"yyyyMMdd", endDay:"yyyyMMdd", timeZone:"+0200"}` →
  `{group:[{startTime,endTime,sampleSet:[{dataCollectorId,samplePoints:[{startTime,endTime,
  dataTypeName,value:[{fieldName,integerValue|floatValue|longValue}]}]}]}]}`.
  Request days are calendar strings, group times are **ms**, sample-point times are **ns**.
- `GET /healthkit/v2/healthRecords?startTime=<ns>&endTime=<ns>&dataType=com.huawei.health.record.sleep`
  → `{healthRecords:[{startTime,endTime,dataTypeName,value:[…],id}]}` — sleep is a *health
  record*, not a sampling type, so it does not come from the polymerize endpoint.

| metric | requested (detail) type | returned (statistics) type | fields |
|---|---|---|---|
| steps | `com.huawei.continuous.steps.delta` | `com.huawei.continuous.steps.total` | `steps` |
| distance | `com.huawei.continuous.distance.delta` | `com.huawei.continuous.distance.total` | `distance` (metres) |
| active kcal | `com.huawei.continuous.calories.burnt` | `com.huawei.continuous.calories.burnt.total` | `calories_total` |
| heart rate | `com.huawei.instantaneous.heart_rate` | `com.huawei.continuous.heart_rate.statistics` | `avg`, `max`, `min`, `last` |
| resting HR | `com.huawei.instantaneous.resting_heart_rate` | `com.huawei.continuous.resting_heart_rate.statistics` | `avg`, `max`, `min`, `last` |
| SpO2 | `com.huawei.instantaneous.spo2` | `com.huawei.continuous.spo2.statistics` | `saturation_avg/_max/_min/_last` |
| sleep | `com.huawei.health.record.sleep` (health record) | — | `all_sleep_time` (min), `fall_asleep_time`/`wakeup_time` (ms) |

Steps + distance + calories go out as one batched call (one scope group); if the batch fails
each type is retried alone, so one unapproved scope cannot take the other two down. Heart rate,
resting HR, SpO2 and sleep each get their own call for the same reason. Huawei's calorie
aggregate is explicitly *active* calories, so `totalKcal` is never sourced from the cloud.

### Merge rules (`HealthSummaryReader.merge`, pure function)

Either source alone produces a valid summary; when both are present:

| field | rule |
|---|---|
| `steps`, `distanceKm`, `activeKcal`, `totalKcal`, `sleepMin` | the **larger** of the two |
| `minBpm` / `maxBpm` | true min / max across both |
| `avgBpm`, `restingBpm`, `spo2Pct` | Health Connect wins, Huawei fills the gap |

*Larger, not sum*: Health Connect sees the phone's own pedometer (and, with the mirror on,
PulseNX's own copies of these very cloud aggregates), while Huawei's cloud sees the watch.
Summing double-counts the overlap outright; a maximum cannot — worst case it under-reports,
which is the honest failure direction for a health readout.

`summary.source` becomes `"huawei"` as soon as any cloud value survives into the result, which
is exactly what the PC's `via Huawei Health` chip already means.

### Health Connect write-back (`HealthMirror.writeHuaweiCloudDaily`)

Gated by the existing `FIT_MIRROR_ENABLED` toggle **and** a linked cloud account — one switch,
one promise: "publish Huawei's data under my origin". Writes `StepsRecord`, `DistanceRecord`,
`ActiveCaloriesBurnedRecord` (local midnight → now) and, only when the cloud supplied a real
`fall_asleep_time`/`wakeup_time` interval, a `SleepSessionRecord`. A bare sleep *duration* is
never written, because a session record is a span and inventing one would put a fictional night
on the user's timeline.

Idempotency: `clientRecordId = "hwcloud-<type>-<yyyyMMdd>"`, `clientRecordVersion` = the fetch
epoch-ms, so the 5-minute cadence upserts the same four records with fresher totals instead of
accumulating 288 partial ones a day. Loop safety: these carry the PulseNX origin and the
on-device mirror only ever copies `com.huawei.health`-origin records, so they can never be
re-mirrored; and the merge takes a maximum, so reading them straight back cannot inflate the
summary either.

### Cadence and failure surface

The cloud read rides the existing 5-minute health-summary tick in `VitalsBridgeService` (plus
the link-up push and the on-demand `REFRESH_HEALTH` action) — no new timer. Every request and
response shape is logged at `Log.d` under the `PulseNX/HuaweiCloud` and `PulseNX/HuaweiKit`
tags (token bodies are logged by key names only, never by value). The health card's Huawei
status line shows exactly one of: *Paste your Client ID and secret to link* / *Not linked* /
*Linked as of HH:MM* (the last successful cloud round-trip) / *Auth expired — relink*.

## Known bugs in the old code — must be FIXED, not ported

1. Renderer ran with `nodeIntegration:true, contextIsolation:false` and contained every service →
   new app: all services in main process, renderer sandboxed behind one preload API.
2. `calculateHRV` faked a sine-wave HRV before 2 RR samples existed → show `--` until real data.
3. `updateChart` injected fake "micro-jitter" into plotted BPM/stress → plot real values only.
4. Calories accumulated twice per sample while recording (`accumulateCalories` called in step 5
   and again in step 11) → accumulate exactly once.
5. Android hand-rolled MQTT packets encoded Remaining Length as ONE byte → any packet >127 bytes
   was corrupt → use Paho MQTT client.
6. `elements.statHrv` and `elements.rrValue` both bound `#hrv-val`; RR text (`"812 ms"`) and rMSSD
   overwrote each other → separate elements.
7. 4-char link code (~1.7 M keyspace) → 6-char (~2.2 B), still typeable.
8. Zone tick buckets could miss (string-includes matching) → match on canonical zone keys.
9. Discord template `.replace('{bpm}',…)` only replaced first occurrence → replaceAll semantics.
10. OBS page hardcoded theme query param it never used; Google-Fonts dependency in overlay/OBS
    pages (breaks offline) → self-contained pages, system font stack.
11. `stopRecording` left `lastKcalCalculationTime` running so calories kept accruing between
    sessions → calories tied to live stream consistently (accrue whenever live vitals flow,
    reset with stats reset), timer/kcal state reset cleanly on record start.

## IPC contract (preload exposes `window.pulsenx`)

Renderer → main (invoke):
- `settings:get` → full settings object
- `settings:set` (partialObject) → merged object (main persists + reacts: OSC loops, Discord, etc.)
- `session:start` / `session:stop` → `{ok}`
- `session:exportCsv` → `{ok, path?|canceled}` (main opens dialog + writes)
- `history:parseCsv` (text) → parsed `{labels, hr[], stress[], stats{min,max,avg,stressAvg,duration}}`
- `overlay:toggle` (bool) → `{active}`
- `app:info` → `{version, linkCode, lanEndpoint, obsUrl}`
- `audio:testAlarm` → renderer plays it itself actually — NO ipc needed; WebAudio stays in renderer.

Main → renderer (events on `window.pulsenx.on(channel, cb)`):
- `vitals` — processed sample `{bpm, rrMs, hrv|null, stress, stressText, zone, zoneKey, contact,
   battery|null, rssi|null, stats:{min,max,avg,kcal}, stressStats:{min,max,avg}, zonePct:{...},
   coherence, breathPhase, elapsedRecSec|null, recording, chartPoint:{t,bpm,stress}}`
- `health` — normalised daily summary `{ts, steps, distanceKm, activeKcal, totalKcal, sleepMin,
   restingBpm, minBpm, avgBpm, maxBpm, spo2Pct, source:'huawei'|'healthconnect'}`; every field
   except `ts`/`source` is nullable. Produced by the pure `normalizeHealth(raw)` in state.js
   (numbers coerced, counts rounded to ints, measurements to 1 decimal, garbage → null, invalid
   message → null); cached in main and re-sent on the dashboard's `did-finish-load`.
- `link` — `{state:'awaiting'|'connected'|'offline', source?, src?:'ble'|'health',
   phone?:{battery,rssi}, detail?}`
- `overlay` — `{active}`  (window opened/closed from any path)
- `alarm` — `{type:'highHr'|'threshold', active:bool}` → renderer drives WebAudio
- `breath` — `{phase:'inhale'|'exhale'}` → renderer chime + circle animation
- `discord` — `{state:'off'|'connecting'|'connected'|'error', user?, message?}`

Overlay window gets `vitals-update` events with `{bpm, stress, showBpm, showStress}`.

Vitals processing (zones, HRV, stress, kcal, coherence, zone distribution, recording buffer)
lives in `src/main/state.js` as pure functions + a session object so it is unit-testable;
main.js wires transports → state → broadcasts.

## Settings schema (defaults)

```json
{
  "profile": { "age": 25, "gender": "male", "weightKg": 70, "maxHr": 190 },
  "osc": { "enabled": true, "host": "127.0.0.1", "port": 9000, "vrchatFullSet": true,
           "customPath": "/avatar/parameters/HeartRate", "preset": "standard",
           "minHr": 0, "maxHr": 150, "beatPulse": true, "chatbox": false,
           "chatboxFormat": "❤️ {bpm} BPM | 〰️ {hrv} HRV" },
  "discord": { "enabled": false, "details": "❤️ {bpm} BPM • {zone}",
               "state": "Stress: {stresstext} ({stress}%)",
               "clientId": "" },
  "alarms": { "highHrTone": true, "bpmLimit": 130, "durationSec": 3,
              "audio": true, "oscFlag": true },
  "overlay": { "showBpm": true, "showStress": false },
  "pacer": { "sound": false },
  "stressOffset": 0
}
```

## OSC avatar parameter set (1 Hz, unchanged from PulseLink for avatar compat)

`HRPercent f`, `FullHRPercent f(-1..1)`, `HR i`, `onesHR i`, `tensHR i`, `hundredsHR i`,
`isHRConnected T`, `isHRActive T`, `Heartrate i`, `Heartrate2 f(bpm/255)`, `Heartrate3 i`,
`HeartRate i`, `HeartRateFloat f`, `HeartRateInt i`, `HRV f(0..1)`, `Stress f(0..1)`,
`StressInt i`, `HeartrateBeat f`, `HeartRateBPM i`, `VRCOSC/Heartrate i`.
Beat pulse owns: `HeartBeatPulse`, `HeartBeat`, `isHRBeat`, `HBListen` (bools).
Threshold alarm owns: `HeartRateWarning` (bool).

## Build targets

- `pc-app`: electron-builder → `dist/PulseNX.AppImage` (linux) and `dist/PulseNX.exe`
  (win portable). Electron 31.x (cached locally), builder ^26.
  Tests: `npm run test:unit` (node --test, pure logic) and `npm run test:e2e` (launches the real
  app; needs a DISPLAY or xvfb).
- `android-app`: gradle 8.13 (cached), AGP 8.x compatible with it, JDK 21 at
  `/run/media/nerdrx/Lex/claude/tools/jdk-21.0.12+8`, SDK at
  `/run/media/nerdrx/Lex/claude/tools/android-sdk` (build-tools 34/35, platform android-34).
  Release APK signed with repo-local generated keystore → `pulsenx_bridge.apk`.

### Port overrides (test isolation)

Every listening port is read once at startup from the environment, falling back to the documented
default, so a test instance can run beside a live one that already owns them:
`PULSENX_PORT_WS` (LAN WebSocket, 9000), `PULSENX_PORT_DISCOVERY` (UDP beacon, 9001),
`PULSENX_PORT_OBS` (OBS widget, 9005), `PULSENX_PORT_E2E` (`--e2e-hooks` probe, 9010).
`PULSENX_NO_BEACON=1` skips the discovery broadcaster entirely, so a test instance never
advertises itself to the user's phone. An unset or invalid value means the default, and the OBS
widget page + `app:info` endpoints follow whatever the overrides resolve to.

The OSC target is an outbound client, i.e. a normal setting rather than a listening port, so it
needs no override: `npm run test:e2e` pre-seeds `<user-data-dir>/settings.json` with
`{"osc":{"port":19100}}` before launch, which the store's shaped merge applies over the defaults.
The harness therefore runs fully isolated on 19000/19005/19010/19100 with the beacon off, and a
production instance streaming OSC to :9000 can no longer contaminate its assertions.
