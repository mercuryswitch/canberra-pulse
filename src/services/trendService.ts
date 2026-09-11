/**
 * Historic trends (2026-09-11) - the "second act" of the demo Ross planned
 * during the historic-data-capture ideation session: the live app is the
 * anchor, this is what shows once there's real multi-day history sitting in
 * Kusto (ACTBusEventLoader/ACTStopIdLoader/ACTTrafficLoader now run on a
 * 5-minute Fabric schedule through the demo - see PROJECT_STATUS.md).
 *
 * Deliberately server-side aggregated (`summarize ... by bin(ts, 1h)`), not
 * "fetch everything and bucket in the browser" - TrafficLinkStats alone is
 * already growing by ~10K rows/hour (it reports all ~725 segments every
 * poll regardless of activity), so by the time the two-week capture is done
 * this could be single-digit millions of rows. An hourly bucket over two
 * weeks is at most ~336 rows back from Kusto, regardless of how much raw
 * data it queried over - this scales fine for the whole capture window.
 */
import { colIndex, queryKusto, type KustoTable } from './kustoClient';

export interface HourlyTrendPoint {
  /** Start of the hour bucket, ms since epoch (UTC). */
  hourMs: number;
  avgDelayMinutes: number | null;
  onTimeSamples: number;
  avgCongestionScore: number | null;
  congestionSamples: number;
  activeVehicles: number;
}

const ONTIME_TREND_KQL = `
BusStopObservations
| summarize avgDelay = avg(delay_minutes), n = count() by bin(ts, 1h)
| order by ts asc
`;

// Closed segments have no meaningful speed/score reading for a "how bad is
// traffic" trend - same "closed is its own category, not a data point on
// the congestion scale" convention as the live congestion map.
const CONGESTION_TREND_KQL = `
TrafficLinkStats
| where Closed == false
| summarize avgScore = avg(Score), n = count() by bin(ts, 1h)
| order by ts asc
`;

// timestamp is stored as a string (see busService.ts's own note on this) -
// todatetime() before bin()'ing it, same conversion used there.
const ACTIVITY_TREND_KQL = `
EventSchemaBUS_v1
| extend t = todatetime(timestamp)
| summarize activeVehicles = dcount(vehicle_id) by bin(t, 1h)
| order by t asc
`;

/** Truncate to the hour so three independently-binned queries (each already
 * bin()'d server-side, but as separate result sets) align on the same key
 * when merged client-side. Returns null for anything unparseable - a
 * handful of rows in EventSchemaBUS_v1 have an empty/malformed timestamp
 * string (confirmed directly: querying `bin(todatetime(timestamp), 1h)`
 * against real data produces one `null`-keyed bucket alongside the real
 * ones) - skip those rather than let `new Date(...)` silently produce an
 * Invalid Date whose .getTime() is NaN and corrupts the Map key. */
function hourKeyMs(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}

/** Kusto's avg()/avgif() over a bucket with zero non-null inputs returns NaN
 * (correct - there's nothing to average), not null. Left un-normalised,
 * that NaN would poison sparklinePoints' Math.min/Math.max over the whole
 * series (Math.min with any NaN present is itself NaN), breaking the chart
 * scale for every hour, not just the empty one - confirmed directly against
 * real data (an early-morning bucket with no schedule-matched delay
 * readings came back as literal "NaN"). Treat it as the same "no reading
 * this hour" null every other gap already means. */
function finiteOrNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/** Fetch and merge all three trend series into one hour-indexed series, oldest first. Never throws - a table with no data yet (or not created yet) just contributes nothing, same graceful-empty convention as every other optional layer in this app. */
export async function fetchHourlyTrends(signal?: AbortSignal): Promise<HourlyTrendPoint[]> {
  const byHour = new Map<number, HourlyTrendPoint>();
  function get(hourMs: number): HourlyTrendPoint {
    let p = byHour.get(hourMs);
    if (!p) {
      p = { hourMs, avgDelayMinutes: null, onTimeSamples: 0, avgCongestionScore: null, congestionSamples: 0, activeVehicles: 0 };
      byHour.set(hourMs, p);
    }
    return p;
  }

  const [onTime, congestion, activity] = await Promise.all([
    queryKusto(ONTIME_TREND_KQL, signal).catch((): KustoTable | null => null),
    queryKusto(CONGESTION_TREND_KQL, signal).catch((): KustoTable | null => null),
    queryKusto(ACTIVITY_TREND_KQL, signal).catch((): KustoTable | null => null),
  ]);

  if (onTime) {
    const iTs = colIndex(onTime, 'ts');
    const iAvg = colIndex(onTime, 'avgDelay');
    const iN = colIndex(onTime, 'n');
    for (const r of onTime.Rows) {
      const hourMs = hourKeyMs(String(r[iTs]));
      if (hourMs === null) continue;
      const p = get(hourMs);
      p.avgDelayMinutes = finiteOrNull(Number(r[iAvg]));
      p.onTimeSamples = Number(r[iN]);
    }
  }
  if (congestion) {
    const iTs = colIndex(congestion, 'ts');
    const iAvg = colIndex(congestion, 'avgScore');
    const iN = colIndex(congestion, 'n');
    for (const r of congestion.Rows) {
      const hourMs = hourKeyMs(String(r[iTs]));
      if (hourMs === null) continue;
      const p = get(hourMs);
      p.avgCongestionScore = finiteOrNull(Number(r[iAvg]));
      p.congestionSamples = Number(r[iN]);
    }
  }
  if (activity) {
    const iTs = colIndex(activity, 't');
    const iCount = colIndex(activity, 'activeVehicles');
    for (const r of activity.Rows) {
      const hourMs = hourKeyMs(String(r[iTs]));
      if (hourMs === null) continue;
      const p = get(hourMs);
      p.activeVehicles = Number(r[iCount]);
    }
  }

  return Array.from(byHour.values()).sort((a, b) => a.hourMs - b.hourMs);
}
