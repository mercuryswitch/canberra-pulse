/**
 * ACT road congestion overlay (2026-09-08, Ross's find: the public
 * Addinsight Bluetooth-detector traffic API). Geometry is baked in at
 * build time (see vite/actTrafficLinks.ts - static/rarely-changing, same
 * pattern as GTFS shapes); live stats come from Kusto's TrafficLinkStats
 * table, fed by the ACTTrafficLoader notebook, queried the same way
 * busService.ts queries EventSchemaBUS_v1.
 */
import { colIndex, queryKusto } from './kustoClient';

export interface TrafficLink {
  linkId: number;
  name: string;
  lengthM: number;
  /** Free-flow travel time, seconds. */
  minTT: number;
  isFreeway: boolean;
  polyline: [number, number][];
}

let snapshotPromise: Promise<TrafficLink[]> | null = null;

function loadSnapshot(): Promise<TrafficLink[]> {
  if (!snapshotPromise) {
    const url = `${import.meta.env.BASE_URL}traffic-links.json`;
    snapshotPromise = fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<TrafficLink[]>) : []))
      .catch(() => []);
  }
  return snapshotPromise;
}

/** Preload the road-segment geometry - call when the congestion overlay is first toggled on, not at app startup (a few hundred KB most sessions won't need). */
export function preloadTrafficLinks(): Promise<void> {
  return loadSnapshot().then(() => undefined);
}

export async function getTrafficLinks(): Promise<TrafficLink[]> {
  return loadSnapshot();
}

export interface TrafficLinkLiveStats {
  linkId: number;
  ts: number;
  tt: number;
  delay: number;
  speed: number;
  excessDelay: number;
  congestion: number;
  /** 0 (free-flowing) to 7 (severe) - see link_scores.json's thresholds. */
  score: number;
  closed: boolean;
}

// A link's stats update roughly every 1-5 minutes depending on detector
// traffic - 10 minutes is generous enough that a link between updates
// never wrongly reads as "no data", without being so wide it shows a truly
// stale reading as current.
const LIVE_STATS_WINDOW = '10m';

const TRAFFIC_STATS_KQL = `
TrafficLinkStats
| where ts > now() - ${LIVE_STATS_WINDOW}
| summarize arg_max(ts, *) by LinkId
`;

/** Latest known stats per road segment, keyed by linkId. Empty (not thrown) if the table doesn't exist yet or the loader notebook isn't currently running. */
export async function fetchLiveLinkStats(signal?: AbortSignal): Promise<Map<number, TrafficLinkLiveStats>> {
  const map = new Map<number, TrafficLinkLiveStats>();
  try {
    const t = await queryKusto(TRAFFIC_STATS_KQL, signal);
    const iLinkId = colIndex(t, 'LinkId');
    const iTs = colIndex(t, 'ts');
    const iTT = colIndex(t, 'TT');
    const iDelay = colIndex(t, 'Delay');
    const iSpeed = colIndex(t, 'Speed');
    const iExcessDelay = colIndex(t, 'ExcessDelay');
    const iCongestion = colIndex(t, 'Congestion');
    const iScore = colIndex(t, 'Score');
    const iClosed = colIndex(t, 'Closed');
    for (const r of t.Rows) {
      const linkId = Number(r[iLinkId]);
      map.set(linkId, {
        linkId,
        ts: new Date(String(r[iTs])).getTime(),
        tt: Number(r[iTT]),
        delay: Number(r[iDelay]),
        speed: Number(r[iSpeed]),
        excessDelay: Number(r[iExcessDelay]),
        congestion: Number(r[iCongestion]),
        score: Number(r[iScore]),
        closed: Boolean(r[iClosed]),
      });
    }
  } catch {
    // Table not created yet, or the loader notebook has never run - same
    // graceful-empty handling as every other optional live layer here.
  }
  return map;
}
