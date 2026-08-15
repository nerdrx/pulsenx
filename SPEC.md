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
