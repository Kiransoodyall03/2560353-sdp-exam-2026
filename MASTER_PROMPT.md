# Qoder Master Prompt (filled in from the released specs)

## 0. Setup (5 min, you run these)
1. Copy this kit into the root of your exam repo: `.qoder/rules/exam.md`, `docs/specs/`, `docs/reference/`, `docs/assets/`.
   Edit the `[[...]]` line at the top of `.qoder/rules/exam.md` with your service choice. In Qoder, set the rule to **Always Apply**.
2. Start the simulators with Podman, from the `arl-sim/` folder:
   ```bash
   for i in images/*.tar; do podman load -i "$i"; done
   # If compose complains about short image names, edit arl-test.yaml:
   #   eclipse-mosquitto:2 -> docker.io/library/eclipse-mosquitto:2
   #   postgres:16         -> docker.io/library/postgres:16
   #   arl/api:0.1.0       -> localhost/arl/api:0.1.0  (same for arl/rta, arl/lwm, ...)
   # On Fedora/SELinux, change ":ro" mounts to ":ro,Z".
   ARL_SPEEDUP=10 podman compose -f arl-test.yaml up -d api rta lwm opg
   podman compose -f arl-test.yaml ps
   ```
   `podman compose` needs podman-compose or docker-compose installed as the provider. Check with `podman compose version`.
3. Capture fixtures for the agent (keep this running ~3 min, then Ctrl-C):
   ```bash
   podman exec -it $(podman ps -qf name=mosquitto) mosquitto_sub -t 'arl/#' -v -C 400 > docs/samples.txt
   curl -s localhost:8080/openapi.json > docs/openapi.json
   ```
   Commit, then paste the prompt in section 1.

## 1. Master `/plan` prompt (Agent mode, Ultimate tier)

```
/plan Build the ARL monitoring & control platform. Follow @.qoder/rules/exam.md strictly. Read @docs/specs/running-the-arl.txt, @docs/specs/arl-api-spec.txt, @docs/specs/arl-rta-spec.txt, @docs/specs/arl-lwm-spec.txt, @docs/specs/arl-opg-spec.txt, @docs/samples.txt and @docs/openapi.json first. Produce a phased plan (files, interfaces, acceptance commands per phase). Do NOT write code yet; I will run each phase in its own chat.

SERVICES: RTA (30% of mark), LWM (17.5%), OPG (17.5%). Storms affect all three (wind stow on RTA, high wind/lightning on LWM, lower solar on OPG). Use that for cross-service correlation views.

ARCHITECTURE
- Monorepo: server/ (Fastify + ingestor + SSE), web/ (Vite React), deploy/ (podman notes, .env.example), docs/, README.md.
- Ingestor: mqtt.js, subscribe arl/#, reconnectPeriod 1000, resubscribe; expose broker connection state. Handle retained messages and empty retained payloads (= delete). Track seq gaps per topic.
- Bounded in-memory queue (50k), flush every 250 ms or 500 rows in one transaction. On overflow keep raw only and set degraded=true (UI shows it). RTA peaks ~90 msg/s during scans; LWM bursts during backfill.
- Plugin interface (server/src/plugins/types.ts): id; onTopology($topology) ; parse(topic, payload) -> Parsed[] (pure); persist(batch, db); derive(state, parsed); commands: CommandSpec[] (zod schema, safeguards, presets); snapshot()/restore() for replay; views registered in web.
- Generic shared parts (NOT per service): $topology registry, state store, alert ingestion + workflow, command publisher + ack tracker, researcher verification, replay engine, SSE hub, service health (online flag, last-seen vs stream period from $topology, seq gaps).
- SQLite tables: raw_messages(id, sim_ts, recv_ts, service, entity, kind, topic, payload); telemetry(service, entity, stream, sim_ts, json) + typed tables where queries need them (rta_scan_samples(scan_id, dish, sim_ts, dra, ddec, signal, snr_db, band_hz, fault_code)); state_history(service, entity, item, sim_ts, value_json); aggregates(service, entity, metric, bucket_ts, min, max, avg, count); alerts(service, alert_id, type, severity, max_severity, entity, svc_state raised|cleared, op_state unacked|acked|resolved, raised_ts, cleared_ts, value, limit, unit, message, metadata_json, ack_ts, ack_by, ack_note, resolved_ts, resolved_by, resolution_note); alert_events(append-only audit: alert key, sim_ts, wall_ts, action, actor, detail); commands(command_id, service, entity, control, value_json, researcher, requested_ts, state, progress, reason, detail, updated_ts); presets; schedules; state_snapshots(service, sim_ts, json) every 60 s sim time.
- Live push via SSE, throttled per channel (≤4 Hz aggregates; full scan samples only for the scan being viewed).

ALERT SYSTEM (annunciator, 10% + 10% per service)
- Ingest arl/<svc>/events/alert. Key = (service, alert_id). Raised -> create/update (escalation keeps id, raise severity, log event). Cleared -> svc_state=cleared but stays on the annunciator until resolved.
- On startup reconcile with retained active_alerts (ids raised before we connected -> placeholder rows marked "raised before capture").
- Platform alerts we raise ourselves: service offline (online=false), stream silent > 3x its $topology period, seq gaps, broker disconnected, ARL API unreachable, ingestion degraded.
- Workflow: Acknowledge (researcher code + optional note) -> Resolve (researcher code + required note: how it was handled). Researcher must be verified for THAT service (platform alerts: any active researcher). Record code, name, timestamps. Full audit timeline per alert.
- Annunciator page: grouped by severity, then service; unacked blink; colour + icon; filter by service/state/severity; show value vs limit, unit, metadata, related entity link, the commands issued around that time, and a suggested action per alert type. A banner on every page always shows unacked critical/warning counts.

RTA (docs/specs/arl-rta-spec.txt)
- Entities: dish-001..dish-100 (10x10, row/col in $topology and docs/assets/arl.geojson), sub-arrays (main + up to 3, appear/disappear), global.
- Streams: normal (every 120 s, not scanning), scan (every 1 s while scanning; scan_id, pointing_offset_ra_rad, pointing_offset_dec_rad, signal_strength, snr_db, band_hz, scan_progress). State: commanded, subarray, last_calibration, enabled, stowed, members, scan_state, target, observation_frequency, next_scan, scan_id, active_dishes, wind_stow. Events: scan (lifecycle + started details: grid_size, overlap, fov_rad, dishes, origin), alert.
- Scan image: N = grid_size, theta = fov_rad. Pixel x = floor(N*(dra/theta + 0.5)), y = floor(N*(0.5 - ddec/theta)), clamp 0..N-1, north at top. Skip null samples.
  Clean-up pipeline (data is deliberately noisy): drop samples with snr_db below the scan.min_snr_db limit or from dishes with fault_code receiver_fault/power_fault; normalise per-dish gain (divide by dish median / global median); per pixel use the MEDIAN of its samples; subtract background (5th percentile); colour-scale 1st–99th percentile; fill holes by neighbour average and show a holes overlay toggle. Show a raw vs cleaned toggle. Compare against docs/reference/rta/tgt-<id>-<L|C|K>.png (bands: L 1–2 GHz, C 4–8 GHz, K 18–26 GHz). Store images per scan so past scans can be reopened and compared side by side (bands, targets).
- Derived: dishes in service vs 80 limit (trend), per-sub-array health, scan coverage % and ETA, mean SNR per dish, dish temperature vs irradiance/time of day, calibration age, power outliers.
- Controls (sub-array): start_scan, schedule_scan, pause_scan, cancel_scan, set_target (catalogue id ^tgt-[a-z]{3}$ from /v1/targets, or {ra_rad 0..2π, dec_rad −π/2..π/2, fov_rad 0.0005..0.05}), set_observation_frequency (0.5e9..50e9 Hz). Controls (dish): assign_subarray (name ^[a-z][a-z0-9-]{0,15}$, not dish-*, not global, max 4 sub-arrays), adjust_azimuth (0..2π), adjust_elevation (0.0873..1.5708), enable_dish, stow_dish, request_recalibration.
  Safeguards: block set_target / frequency / assign while scanning; block start during wind_stow; confirm + warn when disabling or stowing a dish would drop active_dishes below 80; block slews while stowed; target elevation check (compute alt from RA/Dec, site lat/lon and sim time; need ≥15°) with a clear message; presets for catalogue targets x bands; multi-dish selection (shift-click on grid) with batch commands.
- Views: 10x10 dish grid (status colour + icon, sub-array outline, wind stow overlay, click -> dish drill-down with telemetry history), sub-array cards (target, band, scan state, progress, next scan), live scan image building up, scan library + compare, wind (from LWM) vs stowed dishes correlation.

LWM (docs/specs/arl-lwm-spec.txt)
- Sites lwm-1..5 (positions in state + geojson). Streams: weather (all sites), sonic (lwm-3), soiling (lwm-4), pan (lwm-5), global lightning summary. Events: lightning (distance_km, bearing_rad, detected_by), alert. State: enabled, sample_interval_s, last_calibration, last_anemometer_service, position, last_cleaning, last_refill, active_sites.
- Derived: IDW-interpolated regional maps (temperature, pressure, wind, rain) on a canvas over the geojson, selectable variable + time (works in replay); dew point; hourly rain rate; 3 h pressure tendency; wind rose; lightning map (strikes by distance/bearing) with storm approach speed; sonic vs main thermometer difference; battery drain forecast vs sample interval.
- Controls: enable_site, sample_interval (10..3600, multiple of 10), request_recalibration, service_anemometer, clean_reference_cell (lwm-4), refill_pan (lwm-5). Safeguards: technician visits blocked while lightning_proximity is active; recalibration blocked if latest gust > high_wind warn limit or backfill in progress; refill_pan blocked above 195 mm; warn on short intervals with low battery. Presets: "Storm watch" (all sites 10 s), "Battery saver" (600 s), "Normal" (60 s).

OPG (docs/specs/arl-opg-spec.txt)
- Entities global, solar, batteries, diesel; power stream every 60 s. State: generation_priority, load_shed, enabled (solar), reserve_pct (batteries). Events: refuel, alert.
- Derived: net balance, renewable fraction, energy (kWh) per source per hour/day, solar performance ratio (output vs irradiance-expected), battery time to reserve at current discharge (4000 kWh bank), diesel hours of fuel left at current burn (20,000 L tank), irradiance (OPG) vs LWM irradiance and cloud/storm correlation.
- Controls: generation_priority (solar_first|battery_first|diesel_first), load_shed, enable_solar_array, battery_reserve (10..80), start_generator, stop_generator. Safeguards: block start if fuel < 2% or already running; confirm stop_generator if load would be uncovered (load > solar + available battery); confirm disabling solar in daylight; presets "Storm prep" (reserve 50, load_shed on), "Generator test" (diesel_first + start), "Normal".
- Views: energy flow diagram (solar/battery/diesel -> load), stacked generation vs load chart, SoC gauge with reserve line, fuel gauge with refuel markers.

CONTROLS (common UX)
- Researcher code entered once per session tab and kept in memory only (not localStorage), sent in a header; verified per service.
- Each control shows current vs target state, pending spinner with progress (acks in_progress/progress), final completed/failed/rejected with reason mapped to plain language (controls_disabled -> "Controls are disabled on the live broker").
- Command history per entity. Schedules: server timer runs presets at a sim time, re-checking safeguards.

REPLAY (10%)
- Source of truth: our own raw_messages, ordered by sim_ts (NOT the API backlog; the backlog may optionally pre-fill history but is labelled as such).
- ReplaySession {t, speed, playing}; seek = nearest state_snapshot ≤ t, then fold raw_messages through each plugin's parse/derive (same code as live). Separate SSE channel.
- UI: global replay bar on every page, "REPLAY @ <sim time> x<speed>" banner, play/pause, step, rewind/fast-forward, speeds 0.5–60x, jump to time, window presets (last 1 h / 3 h / 24 h), overview sparkline + alert/command/scan markers; clicking a marker seeks there. All views (dish grid, scan images, weather map, power flow, annunciator state at time t) render from the replay state. Controls disabled in replay.

SECURITY: verify via API for every control/ack/resolve; zod everywhere; parameterised SQL; escape all payload text in UI; rate-limit verification failures; CORS to web origin; no secrets in repo/logs; handle API 429 with Retry-After.

UI/UX: left nav (Overview, RTA, LWM, OPG, Annunciator, Replay), Overview page with one tile per service (online, last seen, key KPIs, alert counts). Stale data greyed with "last seen". Stays usable with many alerts (virtualised list) or services offline.

TESTING: Vitest: parsers on fixtures from docs/samples.txt; alert workflow (raise, escalate same id, clear, ack, resolve requires ack + note, reconcile active_alerts); scan pixel mapping + clean-up; persistence (batch flush, replay fold == live state); researcher verification with mocked API (valid, unknown, defunct, not_permitted, 429). Integration (npm run test:int): against the local podman stack with a scenario file in docs/scenarios/test.toml (storm + dish overheat + generator_fail_start + lwm comms_loss), assert alerts arrive and a command reaches completed.

README: Podman setup (load images, compose up, ARL_SPEEDUP), .env.example (local: MQTT_BROKER_ADDRESS=localhost, MQTT_BROKER_PORT=1883, ARL_API_ADDRESS=localhost, ARL_API_PORT=8080, empty user/password), npm install / dev / test / test:int, architecture diagram, design decisions, AI declaration placeholder.

PHASES
P1 Skeleton + generic core (config, ingestor, topology registry, raw store, state store, SSE, service health, web shell with nav + alert banner). Acceptance: dev server shows live online state for rta/lwm/opg.
P2 Alert ingestion + annunciator + researcher verification + audit.
P3 RTA data, derived, dish grid, drill-down, scan image pipeline.
P4 RTA controls + safeguards + presets + command tracking.   <- push before LUNCH snapshot
P5 LWM plugin (data, maps, controls).
P6 OPG plugin (data, flow view, controls).
P7 Replay across all services with markers.
P8 Tests, scenario file, README, polish.   <- push 30 min before the end
```

## 2. Per-phase prompt (new chat each time, Auto tier)
```
Implement phase P<n> of the approved plan exactly. Read @.qoder/rules/exam.md and the spec @docs/specs/arl-<svc>-spec.txt before coding. Use real payloads from @docs/samples.txt. When done run `npx tsc --noEmit` and `npm test`, fix failures, and list changed files + how to check it in the browser.
```

## 3. Scan image check (Ask mode, after a scan completes)
```
Here is my reconstructed image for <tgt-id> band <L|C|K> (attached) and the reference @docs/reference/rta/<file>.png. Compare orientation, structure and noise. Point to the exact step in the clean-up pipeline to change.
```

## 4. Tests until green (Goal, Efficient tier, ~8 turns)
```
Goal: `npx tsc --noEmit` and `npm test` both exit 0. Do not change public interfaces, do not delete or weaken tests, do not touch .env.
```

## 5. Podman troubleshooting (Ask mode)
```
`podman compose -f arl-test.yaml up -d <svc>` fails with: <error>. Rootless Podman on <OS>. Give the minimal fix (image names, :Z labels, compose provider, ports). Do not suggest Docker.
```

## 6. Pre-push check (Ask mode, before each snapshot)
```
Review the diff for: hard-coded hosts/ports/passwords/researcher codes, secrets in logs, control or ack/resolve paths that skip POST /v1/researchers/verify, unvalidated inputs, unescaped payload text in the UI. List findings with file:line.
```

Git after every phase: `git add -A && git commit -m "P<n>: <summary>" && git push`
