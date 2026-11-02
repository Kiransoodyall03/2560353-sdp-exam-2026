// RTA live channel: snapshot {dishes, subarrays, global, scans} + keyed patches dish:/subarray:/scan:/global.
// While a replay session is active the live channel is closed (browser connection budget) and the session's
// folded view — the same snapshot shape — is fed through the identical parser, so the page follows the cursor.
import { useMemo } from 'react';
import type { DishDTO, RtaGlobalDTO, ScanSummaryDTO, SubarrayDTO } from '../../../shared/types';
import { useServiceState } from './service-state';
import { useKeyedChannel, type SseStatus } from './sse';

interface Snapshot {
  dishes: DishDTO[];
  subarrays: SubarrayDTO[];
  global: RtaGlobalDTO;
  scans: ScanSummaryDTO[];
}

function fromSnapshot(data: unknown): Record<string, unknown> {
  const s = data as Snapshot;
  const out: Record<string, unknown> = { global: s.global };
  for (const d of s.dishes) out[`dish:${d.id}`] = d;
  for (const a of s.subarrays) out[`subarray:${a.id}`] = a;
  for (const sc of s.scans) out[`scan:${sc.scanId}`] = sc;
  return out;
}

export interface RtaLive {
  dishes: DishDTO[];
  dishById: Map<string, DishDTO>;
  subarrays: SubarrayDTO[];
  global: RtaGlobalDTO | null;
  scans: ScanSummaryDTO[];
  status: SseStatus;
  simTs: number | null;
}

export function useRtaLive(): RtaLive {
  const svc = useServiceState('rta');
  const { items, status, simTs } = useKeyedChannel<unknown>(svc ? null : 'rta', fromSnapshot);
  const replayItems = useMemo(() => (svc?.view ? fromSnapshot(svc.view) : null), [svc]);
  const source = replayItems ?? items;
  const srcStatus: SseStatus = svc ? 'open' : status;
  const srcSimTs = svc ? (svc.state.lastSimTs ?? null) : simTs;
  return useMemo(() => {
    const dishes: DishDTO[] = [];
    const subarrays: SubarrayDTO[] = [];
    const scans: ScanSummaryDTO[] = [];
    for (const [k, v] of Object.entries(source)) {
      if (k.startsWith('dish:')) dishes.push(v as DishDTO);
      else if (k.startsWith('subarray:')) subarrays.push(v as SubarrayDTO);
      else if (k.startsWith('scan:')) scans.push(v as ScanSummaryDTO);
    }
    dishes.sort((a, b) => a.id.localeCompare(b.id));
    subarrays.sort((a, b) => a.id.localeCompare(b.id));
    scans.sort((a, b) => (b.startedTs ?? 0) - (a.startedTs ?? 0));
    return {
      dishes,
      dishById: new Map(dishes.map((d) => [d.id, d])),
      subarrays,
      global: (source['global'] as RtaGlobalDTO | undefined) ?? null,
      scans,
      status: srcStatus,
      simTs: srcSimTs,
    };
  }, [source, srcStatus, srcSimTs]);
}

/** Sub-array outlines follow the series order: accent, sunset, ochre, dust. */
const SUBARRAY_COLOURS = ['var(--accent)', 'var(--sunset)', 'var(--ochre)', 'var(--dust)'];

/** Stable colour per sub-array name (sorted order), used for grid outlines and cards. */
export function subarrayColours(names: string[]): Map<string, string> {
  return new Map([...new Set(names)].sort().map((n, i) => [n, SUBARRAY_COLOURS[i % SUBARRAY_COLOURS.length]!]));
}

export const DISH_ICON: Record<DishDTO['status'], string> = {
  ok: '●',
  scanning: '◉',
  stowed: '⏚',
  disabled: '⊘',
  fault: '▲',
  warning: '◆',
  offline: '✕',
  unknown: '?',
};

export const BAND_TEXT = { L: 'L band (1–2 GHz)', C: 'C band (4–8 GHz)', K: 'K band (18–26 GHz)' } as const;

export function referenceUrl(targetId: string | null, band: 'L' | 'C' | 'K' | null): string | null {
  if (!targetId || !band || !/^tgt-[a-z]{3}$/.test(targetId)) return null;
  return `/api/reference/rta/${targetId}-${band}.png`;
}
