# ARL exam project rules (Always Apply)

PROJECT: ARL (astro-research lab) monitoring & control web platform. Exam build, graded by rubric.
Services built: RTA (required), LWM, OPG. Choice fixed - MHE and OWT are NOT built.
The specs are in docs/specs/*.txt — they are the source of truth. Read the relevant spec before writing any parser, control or alert code. Never invent field names.

STACK (do not change): Node 20 + TypeScript strict, Fastify, mqtt.js, better-sqlite3 (WAL, synchronous=NORMAL), zod, Vitest.
Web: Vite + React + TypeScript, uPlot, <canvas>, Leaflet with docs/assets/arl.geojson only (no CDNs, no tile servers).
Containers: PODMAN ONLY. Never use the docker CLI. Use podman, podman load, podman cp, podman compose. Prefer fully-qualified images (docker.io/library/eclipse-mosquitto:2, docker.io/library/postgres:16). Bind mounts need :Z on SELinux hosts.

## Facts from the specs (all services share this layout)
- Topics: arl/<svc>/$topology (retained, machine-readable entities/streams/fields/units/periods/state/events/controls),
  arl/<svc>/<entity>/telemetry/<stream>, arl/<svc>/<entity>/state/<item> (retained),
  arl/<svc>/events/<kind> (incl. alert), arl/<svc>/cmd/<entity>/<control> (we publish), arl/<svc>/ack/<command_id>.
  Subscribe to arl/#. <svc> ∈ rta, mhe, lwm, opg, owt. <entity> may be "global".
- Envelope on telemetry/events: v, ts (SIMULATED time, unix ms), seq (per topic; gaps = lost messages), entity. Null = measurement not taken.
- State payload: {v, ts, entity, item, value}. An EMPTY retained payload means the state was removed (e.g. RTA sub-array deleted).
- Every service publishes retained global state: online (false = stopped / last will) and active_alerts (ids).
- Commands: {command_id, researcher, value}. Acks on arl/<svc>/ack/<command_id>: command_id, target, control, researcher,
  state (accepted|rejected|in_progress|completed|failed), progress 0..1, reason, detail.
- Alerts are PUBLISHED BY THE SERVICES on arl/<svc>/events/alert: alert_id, type, severity (info|warning|critical),
  state (raised|cleared), value, limit, unit, message, metadata. Escalation = re-raise with same alert_id and higher severity.
  Our platform adds the operator workflow (acknowledge, resolve, audit) on top; it does not re-implement the thresholds.
- ARL API base http://${ARL_API_ADDRESS}:${ARL_API_PORT}/v1 : GET researchers/{code}; POST researchers/verify {code, service} -> {valid, reason};
  GET targets, targets/{id}; GET alert-limits/{service}; GET backlog/{service}/streams; GET backlog/{service}.csv. GET /healthz.
  Live API is read-only and rate limited (20 req/s, 429 + Retry-After). Cache verify results ~60 s, targets/limits ~5 min.
- Local broker is anonymous: MQTT_BROKER_USER/PASSWORD may be empty strings. Live broker has controls disabled (acks come back rejected/controls_disabled).
- Simulated time can run faster than real time (ARL_SPEEDUP). ALWAYS store and replay by envelope ts, keep recv_ts separately.
- LWM: backfill:true samples are old data re-published after an outage (original ts/seq). Store them, never treat them as live.

## Hard rules
1. No hard-coded hosts, ports, usernames, passwords, codes. Config only via server/src/config.ts from process.env:
   MQTT_BROKER_ADDRESS, MQTT_BROKER_PORT, ARL_API_ADDRESS, ARL_API_PORT required (throw if missing);
   MQTT_BROKER_USER, MQTT_BROKER_PASSWORD optional (may be empty). Only .env.example in git. .env in .gitignore and .qoderignore.
2. Never log passwords or researcher codes in full; store the verified researcher code + name from the API in audit rows.
3. Every MQTT message is appended to raw_messages (batched) before plugin dispatch.
4. Topic routing comes from $topology + the layout above, not scattered string literals.
5. No sign-in. Data is readable by all. Every control and every alert ack/resolve takes a researcher code, verified server-side with POST /v1/researchers/verify for that service BEFORE we publish or record anything.
6. Controls: zod-validate → verify researcher → our safeguards → insert commands row → publish → update from ack topic (timeout 30 s with no ack).
7. parse() functions are pure; every parser and alert-workflow rule has Vitest tests on real fixtures in server/test/fixtures/.
8. Never run long-lived servers in the foreground. Never delete podman volumes or prune.
9. Small focused diffs; don't refactor unrelated modules; don't delete or weaken tests.
10. Finish every task by listing changed files and exact verify commands.
