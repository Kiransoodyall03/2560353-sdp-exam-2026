# ARL monitoring & control platform

A single-pane-of-glass platform for the **A**stro-**R**esearch **L**aboratory. It subscribes to the
laboratory's MQTT bus, records **every** message the services emit, models the three services that
operators actually watch — **RTA** (Radio Telescope Array), **LWM** (Local Weather Monitoring) and
**OPG** (On-demand Power Generation) — and serves a live web console over REST + Server-Sent Events.

On top of ingestion the platform:

- derives per-entity **state** and history from raw telemetry/state/event messages;
- raises, acknowledges and resolves **alerts** (service alerts plus its own platform alerts for
  broker loss, ingestion degradation and sequence gaps);
- lets an authenticated **researcher** send **operator commands** to a service, guarded by the
  service's own safeguards and tracked end-to-end through the service's acknowledgements;
- persists everything to SQLite so the whole timeline is **replayable** from our own data.

The ARL services themselves are supplied as a Podman simulator stack (see `arl-sim/` and
`docs/specs/running-the-arl.txt`); this repository is the platform that sits alongside them.

---

## Architecture

```
  ARL services (podman sim)     rta · lwm · opg        [mhe · owt: recorded raw only]
        │  MQTT  subscribe arl/#    telemetry · state · events · $topology · ack
        ▼
  ┌─────────────────────────────────── server/src ───────────────────────────────────┐
  │ INGEST        mqtt/client.ts — reconnect every 1 s, resubscribe on every connect  │
  │   │                                                                               │
  │   ▼                                                                               │
  │ RAW STORE     BatchWriter → SQLite raw_messages  (every message, appended first)  │
  │   │           WAL · synchronous=NORMAL · bounded queue · batched transactions     │
  │   ▼                                                                               │
  │ PLUGINS       parse → SeqTracker (gaps / backfill) → plugin chosen from $topology │
  │   │           rta · lwm · opg   (generic fallback records + passes through)       │
  │   ▼                                                                               │
  │ STATE /       state-store · alert store + workflow · command service + ack tracker│
  │ ALERTS /           ▲  ARL API: verify researcher, alert limits, target catalogue  │
  │ COMMANDS           ▼  publish arl/<svc>/cmd/<entity>/<control>  (qos 1)           │
  │   │                ◀  service acks on arl/<svc>/ack/<command_id>                  │
  │   ▼                                                                               │
  │ SSE           /api/stream/<channel> — snapshot then coalesced patch/append,       │
  │               250 ms tick (≤ 4 Hz); channels do work only while subscribed        │
  └───┬───────────────────────────────────────────────────────────────────────────────┘
      │  HTTP (REST) + SSE
      ▼
  WEB              Vite + React + uPlot: overview · annunciator · rta / lwm / opg ·
                   scans · alert detail · command history & progress

  REPLAY (planned)  fold stored raw_messages back through parse → plugins → the same
                    reducers to rebuild state and history for any time window.
```

The spine is deliberately one-directional: **ingest → raw store → plugins → state/alerts/commands →
SSE → web**. Raw storage happens *before* any interpretation, so a bug in a plugin never costs data,
and **replay** can later re-fold `raw_messages` through the identical reducers to reproduce history.

---

## Design decisions

- **SQLite in WAL mode with batched writes.** `openDb` sets `journal_mode = WAL`, `synchronous =
  NORMAL`, `foreign_keys = ON` and `busy_timeout = 2000`, so a single writer and many readers coexist
  without blocking and a crash loses at most the last un-checkpointed page. All writes go through
  parameterised statements (no string-built SQL).
- **Bounded write queue and a degraded mode.** `BatchWriter` flushes every 250 ms or at 500 rows, in
  transactions of at most 5 000 rows. The queue holds up to 50 000 full items (raw + parsed); beyond
  that it degrades to **raw-only** for up to 200 000 more items and finally drops (counted) rather
  than growing without bound. Entering/leaving degraded mode raises/clears an `ingestion_degraded`
  platform alert — the operator always knows ingestion is behind.
- **Every message is stored raw, first (exam rule 3).** Regardless of whether a plugin understands a
  message, it is appended to `raw_messages` before dispatch. Unknown services (`mhe`, `owt`) and
  unknown streams are therefore still captured and replayable.
- **Reconnection is automatic and lossless.** The MQTT client reconnects every 1 s, resubscribes to
  `arl/#` on every (re)connect, and retained `$topology`/`state` messages rebuild the picture on
  return. A dropped broker raises a `broker_disconnected` platform alert, cleared on reconnect.
- **Sequence-gap tracking.** Each topic carries a monotonic `seq`; `SeqTracker` records the last seq
  and any missing ones (≤ 5 000 per topic), detects service restarts (seq reset to 0 or a large step
  back), and recognises **backfill** — LWM re-publishes samples it buffered during a comms loss with
  their original `seq` and `backfill: true`, which fills earlier gaps. Outstanding gaps raise a
  `seq_gap` platform alert carrying the worst topics as metadata. Backfilled samples are stored but
  never treated as live.
- **A plugin interface driven by `$topology`.** Each service publishes a retained `$topology`
  describing its entities, kinds, streams, state items and controls. Plugins declare which service
  they own; the platform routes parsed messages to the matching plugin and falls back to a generic
  plugin that records and passes through. Adding a service means adding a plugin, not touching the core.
- **Researcher verification via the ARL API.** Commands are authorised by the laboratory's own
  register: `POST /v1/researchers/verify {code, service}` (and `GET /v1/researchers/{code}` for
  platform alerts). Results are cached 60 s and single-flighted; the target/alert-limit catalogue is
  cached 5 min and served stale through API blips; HTTP 429 is honoured via `Retry-After`. A
  sliding-window `FailureLimiter` (10 failed verifications per 60 s per client address) short-circuits
  to 429 to blunt brute-forcing of researcher codes.
- **Controls are tracked through acks, not fire-and-forget.** A command is validated (zod), authorised
  (researcher guard), checked against the control's safeguards (`guard` refuses, `confirm` requires a
  second submit with a token), persisted to `commands`, then published on
  `arl/<svc>/cmd/<entity>/<control>` at qos 1. The ack tracker follows progress on
  `arl/<svc>/ack/<command_id>` and, if nothing arrives within 30 s, marks the command `failed`
  (reason `timeout`). Terminal states are `completed`, `failed` and `rejected`; every transition is
  recorded so the web UI can show live progress and history.
- **Replay from our own data.** Because the raw store is complete and ordered, replaying a window is a
  pure re-fold of `raw_messages` through the same parse → plugin → reducer path used live — no
  dependency on the simulator still running. (The replay endpoint/UI is a documented placeholder; see
  Known limitations.)
- **SSE, coalesced and cheap.** The hub sends a snapshot on connect, then coalesces keyed patches and
  appends per channel on a 250 ms tick (≤ 4 Hz) with a 15 s keep-alive ping. A channel only does work
  while someone is subscribed, so idle consoles cost nothing.

---

## Security notes

- **Researcher codes and passwords are never logged in full.** The logger masks codes (first three
  characters + `***`) and redacts `x-researcher-code`, `authorization` and any `*.password` field
  (`server/src/log.ts`). No credential is ever committed — `.env` is git-ignored; `.env.example`
  carries only non-secret local defaults.
- **Authorisation is delegated, not reinvented.** Whether a researcher may control a service is
  decided by the ARL API's register (active status + the service in their experiments); the platform
  only enforces that answer and rate-limits failures. Codes are accepted from the `x-researcher-code`
  header and verified per request (cached briefly).
- **Least-privilege egress.** Operator commands leave the platform only through the single publisher
  and only while the broker is connected; there is no path to publish a control without going through
  the command service's validation, safeguards and audit trail.
- **CORS is restricted** to the configured `WEB_ORIGIN` (default `http://localhost:5173`); the API is
  bound to `127.0.0.1` by default. Input is validated with zod at every boundary (HTTP params/bodies,
  MQTT payloads, ARL API responses), and errors are returned in a uniform `{error, detail}` shape.
- **The simulator stack is hardened for local use**: services run `read_only` with a `/tmp` tmpfs and
  are wired to a local Mosquitto broker and Postgres. `ARL_SERVICE_TOKEN` (`test-service-token`) is a
  local test value, not a production secret.

---

## Setup

### 1. Prerequisites

- **Node ≥ 18.19** (developed on v18.19.1) and npm.
- **Podman** (and `podman compose`). This project uses Podman, not the Docker CLI (exam rule 9).

### 2. Start the ARL simulator stack

The service images ship as tarballs in `arl-sim/images/`. Load them, then re-tag into the
`localhost/` namespace that `arl-sim/arl-test.yaml` references:

```bash
# Load the six service images. The tars store the unqualified name arl/<svc>:0.1.0, which podman
# resolves against the default registry, so they land as docker.io/arl/<svc>:0.1.0 …
for f in arl-sim/images/arl-*.tar; do podman load -i "$f"; done

# … and arl-test.yaml asks for localhost/arl/<svc>:0.1.0, so re-tag each one:
for s in api rta mhe lwm opg owt; do
  podman tag "docker.io/arl/$s:0.1.0" "localhost/arl/$s:0.1.0"
done
```

Bring up the broker, the ARL API (with its Postgres) and the three services we model, with time
compressed 10× and the exam incident scenario loaded:

```bash
ARL_SPEEDUP=10 ARL_SCENARIO=/scenarios/exam-test.toml \
  podman compose -f arl-sim/arl-test.yaml up -d api rta lwm opg
```

- Starting a service also starts what it depends on (Mosquitto, the ARL API and Postgres).
- `ARL_SCENARIO` is a path **inside** the container (`arl-sim/scenarios/` is mounted at `/scenarios`).
  Omit it for a steady-state run; use `arl-sim/scenarios/example.toml` for the supplied example.
- Mosquitto listens on `localhost:1883` and the ARL API on `localhost:8080` — the defaults in
  `.env.example`.
- The scenario `arl-sim/scenarios/exam-test.toml` plays a ~20 simulated-minute incident (≈2 real
  minutes at `ARL_SPEEDUP=10`) that raises at least one alert per service: an RTA storm/high-wind
  stow and an overheating dish, an LWM lightning approach plus a comms loss (with backfill on
  recovery), and an OPG generator failed start plus low solar. Each event is commented with the alert
  it produces.

Tear the stack down with:

```bash
podman compose -f arl-sim/arl-test.yaml down            # add -v to also drop the Postgres volume
```

### 3. Configure and run the platform

```bash
cp .env.example .env      # then edit if your broker/API are not on the default localhost ports
npm install
npm run dev               # server (tsx watch, :4000) + web (Vite, :5173) with an /api proxy
```

Open the web console at **http://localhost:5173**. `npm start` runs just the server against the
already-built web bundle; `npm run build` produces that bundle in `web/dist/`.

All configuration is read from `.env` in exactly one place (`server/src/config.ts`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `MQTT_BROKER_ADDRESS` / `MQTT_BROKER_PORT` | `localhost` / `1883` | MQTT bus to subscribe (`arl/#`) |
| `MQTT_BROKER_USER` / `MQTT_BROKER_PASSWORD` | *(empty)* | broker credentials, if any |
| `ARL_API_ADDRESS` / `ARL_API_PORT` | `localhost` / `8080` | ARL HTTP API (`…/v1`) |
| `SERVER_HOST` / `SERVER_PORT` | `127.0.0.1` / `4000` | where our HTTP + SSE server listens |
| `WEB_ORIGIN` | `http://localhost:5173` | allowed CORS origin(s), comma-separated |
| `DB_PATH` | `server/data/arl.sqlite` | SQLite file (`:memory:` is used by tests) |
| `LOG_LEVEL` | `info` | `fatal`…`trace` |

### 4. Tests

```bash
npm test          # unit + contract tests (fixtures, no live stack needed)
npm run typecheck # tsc --noEmit across the whole project
npm run test:int  # integration tests against the live podman stack
```

`npm run test:int` (config `vitest.int.config.ts`) exercises the whole pipeline end to end: it probes
the broker from `.env` and **skips the entire suite cleanly if the broker is unreachable**. When the
stack is up it boots our own server in-process (in-memory DB, ephemeral port) wired to the live
broker and ARL API, then:

- waits for retained `$topology` for `rta`, `lwm` and `opg`;
- publishes **one safe command per service** through our HTTP API and asserts the service's ack
  reaches `completed`;
- with a scenario running, asserts **at least one alert per service** arrives and appears in
  `/api/alerts`.

Operator-command checks need a researcher code the local ARL API accepts, read from
**`TEST_RESEARCHER_CODE`** (never hard-coded — exam rule 1). If it is unset, those checks skip with a
clear message; if the code is not permitted for a given service, that service's check skips rather
than fails. To run the full suite against the scenario stack:

```bash
TEST_RESEARCHER_CODE=<a-code-the-ARL-API-accepts> npm run test:int
```

Seeded researcher codes and their permitted services are documented in `docs/specs/arl-api-spec.txt`
(`arl-as3`, for example, may control `rta` and `lwm` but not `opg`). For the alert assertions to pass
for every service, start the stack with the scenario (`ARL_SCENARIO=/scenarios/exam-test.toml`); an
idle stack keeps only RTA alerts, so the alert test skips with a message telling you to load one.

---

## Repository layout

```
server/src/    ingest, plugins (rta/lwm/opg + generic), state, alerts, commands, db, routes, SSE
web/src/       React console: pages, components, lib (api/sse/live/actions/rta/lwm/opg/scan)
shared/        types and command schemas shared by server and web
arl-sim/       the podman simulator: images, config, scenarios, compose file (arl-test.yaml)
docs/specs/    per-service specifications and running-the-arl.txt (the simulator handbook)
scripts/       dev.mjs (runs server+web), extract-fixtures.mjs (builds test fixtures)
```

---

## Known limitations

- **Replay is planned, not wired.** Every message is already persisted to `raw_messages` before
  dispatch, so history recorded now is replayable, but the replay endpoint and the `web` Replay page
  are placeholders for a later phase.
- **LWM modelling is in progress.** On the committed baseline LWM is ingested through the **generic**
  plugin — its `$topology`, telemetry, state and events are recorded and surfaced, but it exposes no
  LWM-specific derived metrics or operator controls yet. A dedicated LWM plugin (derived weather /
  soiling / lightning metrics and controls such as `enable_site`, `sample_interval`,
  `request_recalibration`) is being added on the `p5-lwm` branch.
- **MHE and OWT are recorded raw only.** The Mars Habitation Experiment and On-demand Water Treatment
  services are captured to `raw_messages` (and are replayable) but have no dedicated plugin, state
  model or UI.
- **Single-node, single-writer.** The platform is one Node process writing one SQLite file; it is not
  sharded or horizontally scaled, and the write queue sheds load (raw-only, then drop) rather than
  blocking ingestion if the disk cannot keep up.
- **Integration tests need a live stack.** `npm run test:int` is meaningful only with the Podman
  simulator running; without it the suite skips by design.

---

## AI declaration

This project was developed with the assistance of **Qoder**, an AI coding assistant. Qoder was used
for code generation, refactoring, test authoring, debugging and documentation across the phases of
this work. All AI-assisted output was reviewed, verified against the specifications in `docs/specs/`,
and tested (`npm test`, `npm run typecheck`, `npm run test:int`) by the author, who takes full
responsibility for the correctness and integrity of the code in this repository.
