// Registry of the retained $topology documents: entities, streams (fields, periods), state items, controls.
import type { ServiceTopology, TopologyEntity, TopologyStream } from '../../../shared/types.js';
import { patternEntity, topicMatches, topics } from './topics.js';

type Listener = (service: string, topology: ServiceTopology | null) => void;

export class TopologyRegistry {
  private readonly docs = new Map<string, ServiceTopology>();
  private readonly listeners: Listener[] = [];

  set(service: string, topology: ServiceTopology | null): void {
    if (topology) this.docs.set(service, topology);
    else this.docs.delete(service);
    for (const l of this.listeners) l(service, topology);
  }

  get(service: string): ServiceTopology | null {
    return this.docs.get(service) ?? null;
  }

  onChange(l: Listener): void {
    this.listeners.push(l);
  }

  entity(service: string, id: string): TopologyEntity | null {
    return this.docs.get(service)?.entities.find((e) => e.id === id) ?? null;
  }

  entitiesOfKind(service: string, kind: string): TopologyEntity[] {
    return this.docs.get(service)?.entities.filter((e) => e.kind === kind) ?? [];
  }

  /** Stream definition that applies to a concrete entity (respects fixed-entity topics like lwm-3/sonic). */
  stream(service: string, entity: string, stream: string): TopologyStream | null {
    const doc = this.docs.get(service);
    if (!doc) return null;
    const topic = topics.telemetry(service, entity, stream);
    return doc.streams.find((s) => topicMatches(s.topic, topic)) ?? null;
  }

  /** Streams an entity is expected to publish, from its kind and the topic patterns. */
  streamsFor(service: string, entity: TopologyEntity): TopologyStream[] {
    const doc = this.docs.get(service);
    if (!doc) return [];
    return doc.streams.filter((s) => {
      const pe = patternEntity(s.topic);
      if (pe !== '+' && pe !== entity.id) return false;
      return s.entityKinds.length === 0 || s.entityKinds.includes(entity.kind);
    });
  }

  numericFields(service: string, entity: string, stream: string): string[] {
    const s = this.stream(service, entity, stream);
    if (!s) return [];
    return s.fields.filter((f) => f.type === 'float' || f.type === 'integer').map((f) => f.key);
  }

  services(): string[] {
    return [...this.docs.keys()];
  }
}
