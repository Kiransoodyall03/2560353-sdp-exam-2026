// The documented MQTT topic layout (all ARL services share it). Routing goes through here only (rule 4):
//   arl/<svc>/$topology
//   arl/<svc>/<entity>/telemetry/<stream>
//   arl/<svc>/<entity>/state/<item>
//   arl/<svc>/events/<kind>
//   arl/<svc>/cmd/<entity>/<control>
//   arl/<svc>/ack/<command_id>
export const TOPIC_ROOT = 'arl';
export const SUBSCRIBE_ALL = `${TOPIC_ROOT}/#`;

export type TopicInfo =
  | { kind: 'topology'; service: string }
  | { kind: 'telemetry'; service: string; entity: string; stream: string }
  | { kind: 'state'; service: string; entity: string; item: string }
  | { kind: 'event'; service: string; event: string }
  | { kind: 'cmd'; service: string; entity: string; control: string }
  | { kind: 'ack'; service: string; commandId: string }
  | { kind: 'unknown'; service: string | null };

export function classifyTopic(topic: string): TopicInfo {
  const parts = topic.split('/');
  if (parts[0] !== TOPIC_ROOT || parts.length < 3 || !parts[1]) {
    return { kind: 'unknown', service: parts[0] === TOPIC_ROOT ? (parts[1] ?? null) : null };
  }
  const service = parts[1];
  const p2 = parts[2]!;
  if (parts.length === 3 && p2 === '$topology') return { kind: 'topology', service };
  if (parts.length === 4) {
    if (p2 === 'events') return { kind: 'event', service, event: parts[3]! };
    if (p2 === 'ack') return { kind: 'ack', service, commandId: parts[3]! };
    const sub = parts[3];
    if (sub === 'telemetry' || sub === 'state') return { kind: 'unknown', service };
  }
  if (parts.length === 5) {
    if (p2 === 'cmd') return { kind: 'cmd', service, entity: parts[3]!, control: parts[4]! };
    if (parts[3] === 'telemetry') return { kind: 'telemetry', service, entity: p2, stream: parts[4]! };
    if (parts[3] === 'state') return { kind: 'state', service, entity: p2, item: parts[4]! };
  }
  return { kind: 'unknown', service };
}

export const topics = {
  topology: (svc: string) => `${TOPIC_ROOT}/${svc}/$topology`,
  telemetry: (svc: string, entity: string, stream: string) => `${TOPIC_ROOT}/${svc}/${entity}/telemetry/${stream}`,
  state: (svc: string, entity: string, item: string) => `${TOPIC_ROOT}/${svc}/${entity}/state/${item}`,
  event: (svc: string, kind: string) => `${TOPIC_ROOT}/${svc}/events/${kind}`,
  cmd: (svc: string, entity: string, control: string) => `${TOPIC_ROOT}/${svc}/cmd/${entity}/${control}`,
  ack: (svc: string, commandId: string) => `${TOPIC_ROOT}/${svc}/ack/${commandId}`,
};

/** Matches a $topology topic pattern (single-level `+` wildcards) against a concrete topic. */
export function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.split('/');
  const t = topic.split('/');
  if (p.length !== t.length) return false;
  return p.every((seg, i) => seg === '+' || seg === t[i]);
}

/** The entity segment of a $topology pattern ('+' = any entity of the listed kinds). */
export function patternEntity(pattern: string): string | null {
  const info = classifyTopic(pattern);
  if (info.kind === 'telemetry' || info.kind === 'state' || info.kind === 'cmd') return info.entity;
  return null;
}
