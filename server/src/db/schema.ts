// SQLite schema (better-sqlite3, WAL). Migrations keyed on PRAGMA user_version.
export const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE raw_messages (
    id INTEGER PRIMARY KEY,
    sim_ts INTEGER,
    recv_ts INTEGER NOT NULL,
    service TEXT NOT NULL,
    entity TEXT,
    kind TEXT NOT NULL,
    topic TEXT NOT NULL,
    payload TEXT NOT NULL,
    retained INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX raw_sim_ts ON raw_messages(sim_ts);
  CREATE INDEX raw_service_sim_ts ON raw_messages(service, sim_ts);

  CREATE TABLE telemetry (
    service TEXT NOT NULL,
    entity TEXT NOT NULL,
    stream TEXT NOT NULL,
    sim_ts INTEGER NOT NULL,
    json TEXT NOT NULL,
    backfill INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (service, entity, stream, sim_ts)
  ) WITHOUT ROWID;
  CREATE INDEX telemetry_service_ts ON telemetry(service, stream, sim_ts);

  CREATE TABLE state_history (
    service TEXT NOT NULL,
    entity TEXT NOT NULL,
    item TEXT NOT NULL,
    sim_ts INTEGER NOT NULL,
    value_json TEXT,
    removed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (service, entity, item, sim_ts)
  ) WITHOUT ROWID;
  CREATE INDEX state_history_item_ts ON state_history(service, item, sim_ts);

  CREATE TABLE aggregates (
    service TEXT NOT NULL,
    entity TEXT NOT NULL,
    metric TEXT NOT NULL,
    bucket_ts INTEGER NOT NULL,
    min REAL NOT NULL,
    max REAL NOT NULL,
    avg REAL NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (service, entity, metric, bucket_ts)
  ) WITHOUT ROWID;
  CREATE INDEX aggregates_metric_ts ON aggregates(service, metric, bucket_ts);

  CREATE TABLE alerts (
    service TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    max_severity TEXT NOT NULL,
    entity TEXT,
    svc_state TEXT NOT NULL,
    op_state TEXT NOT NULL,
    raised_ts INTEGER,
    cleared_ts INTEGER,
    value REAL,
    "limit" REAL,
    unit TEXT,
    message TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    placeholder INTEGER NOT NULL DEFAULT 0,
    ack_ts INTEGER,
    ack_by TEXT,
    ack_name TEXT,
    ack_note TEXT,
    resolved_ts INTEGER,
    resolved_by TEXT,
    resolved_name TEXT,
    resolution_note TEXT,
    updated_wall_ts INTEGER NOT NULL,
    PRIMARY KEY (service, alert_id)
  );
  CREATE INDEX alerts_open ON alerts(op_state, severity);

  CREATE TABLE alert_events (
    id INTEGER PRIMARY KEY,
    service TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    sim_ts INTEGER,
    wall_ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX alert_events_key ON alert_events(service, alert_id, id);
  CREATE INDEX alert_events_sim_ts ON alert_events(sim_ts);
  CREATE TRIGGER alert_events_no_update BEFORE UPDATE ON alert_events
    BEGIN SELECT RAISE(ABORT, 'alert_events is append-only'); END;
  CREATE TRIGGER alert_events_no_delete BEFORE DELETE ON alert_events
    BEGIN SELECT RAISE(ABORT, 'alert_events is append-only'); END;

  CREATE TABLE commands (
    command_id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    entity TEXT NOT NULL,
    control TEXT NOT NULL,
    value_json TEXT NOT NULL,
    researcher TEXT NOT NULL,
    researcher_name TEXT,
    requested_ts INTEGER NOT NULL,
    state TEXT NOT NULL,
    progress REAL,
    reason TEXT,
    detail TEXT,
    updated_ts INTEGER NOT NULL,
    origin TEXT NOT NULL DEFAULT 'operator'
  );
  CREATE INDEX commands_service_ts ON commands(service, requested_ts);
  CREATE INDEX commands_entity ON commands(service, entity, requested_ts);

  CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    name TEXT NOT NULL,
    steps_json TEXT NOT NULL
  );

  CREATE TABLE schedules (
    id INTEGER PRIMARY KEY,
    service TEXT NOT NULL,
    name TEXT NOT NULL,
    preset_id TEXT,
    steps_json TEXT,
    at_sim_ts INTEGER NOT NULL,
    researcher TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    detail TEXT,
    created_wall_ts INTEGER NOT NULL
  );

  CREATE TABLE state_snapshots (
    service TEXT NOT NULL,
    sim_ts INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (service, sim_ts)
  ) WITHOUT ROWID;

  CREATE TABLE rta_scan_samples (
    scan_id TEXT NOT NULL,
    dish TEXT NOT NULL,
    sim_ts INTEGER NOT NULL,
    dra REAL NOT NULL,
    ddec REAL NOT NULL,
    signal REAL NOT NULL,
    snr_db REAL,
    band_hz REAL,
    fault_code TEXT,
    PRIMARY KEY (scan_id, dish, sim_ts)
  ) WITHOUT ROWID;

  CREATE TABLE rta_scans (
    scan_id TEXT PRIMARY KEY,
    subarray TEXT NOT NULL,
    target_json TEXT,
    target_id TEXT,
    ra_rad REAL,
    dec_rad REAL,
    fov_rad REAL NOT NULL,
    band_hz REAL,
    grid_size INTEGER NOT NULL,
    overlap INTEGER NOT NULL,
    dishes_json TEXT NOT NULL DEFAULT '[]',
    expected_duration_s REAL,
    origin TEXT,
    started_ts INTEGER,
    ended_ts INTEGER,
    status TEXT NOT NULL,
    reason TEXT,
    events_json TEXT NOT NULL DEFAULT '[]',
    geometry_from_event INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE scan_images (
    scan_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    n INTEGER NOT NULL,
    pixels BLOB NOT NULL,
    holes BLOB NOT NULL,
    filled BLOB NOT NULL,
    stats_json TEXT NOT NULL,
    min_snr_db REAL,
    created_wall_ts INTEGER NOT NULL,
    PRIMARY KEY (scan_id, mode)
  );
  `,
];
