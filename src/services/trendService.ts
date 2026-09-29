/**
 * Historic trends (2026-09-11) - the "second act" of the demo MercurySwitch planned
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
import { getTrafficLinks } from './trafficService';

export interface HourlyTrendPoint {
  /** Start of the hour bucket, ms since epoch (UTC). */
  hourMs: number;
  avgDelayMinutes: number | null;
  onTimeSamples: number;
  avgCongestionScore: number | null;
  congestionSamples: number;
  activeVehicles: number;
}

export type TrendScope = 'all' | 'weekday' | 'weekend';

// ACT runs on AEST (UTC+10) with no daylight saving from the first Sunday
// of October to the first Sunday of April - every day this capture window
// covers is plain AEST, so a flat 10h shift before taking dayofweek() is
// exact, not an approximation that happens to be close enough.
const LOCAL_UTC_OFFSET = '10h';

/** Weekday/weekend filter line for a KQL query, or '' for no filter - built
 * once here so every trend query in this file applies the same local-day
 * boundary (a plain UTC dayofweek() would misclassify roughly the first 10
 * hours of each UTC day, e.g. reading Saturday morning in Canberra as
 * still-Friday). `tsExpr` must already be a datetime-typed expression in
 * scope at the point this line is inserted (`ts` on tables that store it
 * natively, or a cast alias on EventSchemaBUS_v1 - see callers below). */
function scopeFilter(scope: TrendScope, tsExpr: string): string {
  if (scope === 'all') return '';
  const op = scope === 'weekend' ? 'in' : '!in';
  return `| where dayofweek(${tsExpr} + ${LOCAL_UTC_OFFSET}) ${op} (0d, 6d)`;
}

// A handful of rows (confirmed directly against live data: ~66 out of ~70K,
// both buses and light rail, clustered right at the midnight AEST boundary
// each night) carry delay_minutes around -1440 - a day-rollover defect
// upstream, not a real 24h-late arrival. Rare, but an hourly bucket with few
// samples can be dominated by just one or two of these, dragging that
// hour's avg to -1439-ish and blowing out the whole sparkline's scale (this
// is a wrong-but-finite number, so finiteOrNull()'s NaN guard doesn't catch
// it). No real ACT service is ever ~2h+ late, so that's a safe cutoff.
function buildOntimeTrendKql(scope: TrendScope): string {
  return [
    'BusStopObservations',
    '| where abs(delay_minutes) < 120',
    scopeFilter(scope, 'ts'),
    '| summarize avgDelay = avg(delay_minutes), n = count() by bin(ts, 1h)',
    '| order by ts asc',
  ]
    .filter(Boolean)
    .join('\n');
}

// Closed segments have no meaningful speed/score reading for a "how bad is
// traffic" trend - same "closed is its own category, not a data point on
// the congestion scale" convention as the live congestion map.
function buildCongestionTrendKql(scope: TrendScope): string {
  return [
    'TrafficLinkStats',
    '| where Closed == false',
    scopeFilter(scope, 'ts'),
    '| summarize avgScore = avg(Score), n = count() by bin(ts, 1h)',
    '| order by ts asc',
  ]
    .filter(Boolean)
    .join('\n');
}

// timestamp is stored as a string (see busService.ts's own note on this) -
// todatetime() before bin()'ing it, same conversion used there.
function buildActivityTrendKql(scope: TrendScope): string {
  return [
    'EventSchemaBUS_v1',
    '| extend t = todatetime(timestamp)',
    scopeFilter(scope, 't'),
    '| summarize activeVehicles = dcount(vehicle_id) by bin(t, 1h)',
    '| order by t asc',
  ]
    .filter(Boolean)
    .join('\n');
}

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

/** Fetch and merge all three trend series into one hour-indexed series, oldest first. `scope` restricts to local weekdays or weekends only ('all' by default) - see scopeFilter(). Never throws - a table with no data yet (or not created yet) just contributes nothing, same graceful-empty convention as every other optional layer in this app. */
export async function fetchHourlyTrends(scope: TrendScope = 'all', signal?: AbortSignal): Promise<HourlyTrendPoint[]> {
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
    queryKusto(buildOntimeTrendKql(scope), signal).catch((): KustoTable | null => null),
    queryKusto(buildCongestionTrendKql(scope), signal).catch((): KustoTable | null => null),
    queryKusto(buildActivityTrendKql(scope), signal).catch((): KustoTable | null => null),
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

export interface ModeComparisonStats {
  avgDelayMinutes: number;
  onTimePct: number;
  latePct: number;
  earlyPct: number;
  samples: number;
}

export interface ModeComparison {
  bus: ModeComparisonStats | null;
  rail: ModeComparisonStats | null;
}

function buildModeComparisonKql(scope: TrendScope): string {
  return [
    'BusStopObservations',
    '| where abs(delay_minutes) < 120',
    scopeFilter(scope, 'ts'),
    // Light rail vehicle_ids are "LRV*" (e.g. "LRV11"), buses are plain
    // numeric strings - same distinction used to confirm the day-rollover
    // bug affects both modes, and the only mode signal this table carries.
    '| extend isRail = vehicle_id startswith "LRV"',
    '| summarize n = count(), avgDelay = avg(delay_minutes), onTimePct = round(100.0 * countif(abs(delay_minutes) <= 2) / count(), 1), latePct = round(100.0 * countif(delay_minutes > 5) / count(), 1), earlyPct = round(100.0 * countif(delay_minutes < -5) / count(), 1) by isRail',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Bus vs light rail on-time reliability - confirmed directly against live data (2026-09-16 ideation session) as the single most striking number in the whole capture: light rail runs on-time ~98% of the time vs buses' ~59%, a real consequence of dedicated right-of-way vs mixed traffic, not a data artifact. Never throws - graceful-empty (both null) if the table has nothing in scope yet. */
export async function fetchModeComparison(scope: TrendScope = 'all', signal?: AbortSignal): Promise<ModeComparison> {
  const result: ModeComparison = { bus: null, rail: null };
  try {
    const t = await queryKusto(buildModeComparisonKql(scope), signal);
    const iIsRail = colIndex(t, 'isRail');
    const iN = colIndex(t, 'n');
    const iAvg = colIndex(t, 'avgDelay');
    const iOnTime = colIndex(t, 'onTimePct');
    const iLate = colIndex(t, 'latePct');
    const iEarly = colIndex(t, 'earlyPct');
    for (const r of t.Rows) {
      const stats: ModeComparisonStats = {
        avgDelayMinutes: Number(r[iAvg]),
        onTimePct: Number(r[iOnTime]),
        latePct: Number(r[iLate]),
        earlyPct: Number(r[iEarly]),
        samples: Number(r[iN]),
      };
      if (r[iIsRail]) result.rail = stats;
      else result.bus = stats;
    }
  } catch {
    // Table not created yet, or nothing in scope - same graceful-empty
    // convention as the rest of this file.
  }
  return result;
}

export interface CongestionLeaderboardEntry {
  linkId: number;
  name: string;
  avgScore: number;
  avgDelaySeconds: number;
  avgSpeedKmh: number;
  samples: number;
}

function buildCongestionLeaderboardKql(scope: TrendScope, limit: number): string {
  return [
    'TrafficLinkStats',
    '| where Closed == false',
    scopeFilter(scope, 'ts'),
    '| summarize avgScore = avg(Score), avgDelaySeconds = avg(Delay), avgSpeed = avg(Speed), n = count() by LinkId',
    '| order by avgScore desc',
    `| take ${limit}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Worst average-congestion road segments over the capture window, named via
 * the same static traffic-links.json snapshot the live congestion overlay
 * uses (see trafficService.ts's getTrafficLinks()) - a LinkId alone means
 * nothing to a reader, the real road name does. Confirmed directly
 * (2026-09-16): the worst links aren't spread across Canberra, they cluster
 * around one interchange (Parkes Way/Edinburgh Ave/Vernon Circle/
 * Constitution Ave near Civic), which is the actual finding worth surfacing
 * - not "here is a heatmap," but "here is the one interchange doing most of
 * the work." Never throws - empty list if either query has nothing yet. */
export async function fetchCongestionLeaderboard(
  scope: TrendScope = 'all',
  limit = 5,
  signal?: AbortSignal,
): Promise<CongestionLeaderboardEntry[]> {
  try {
    const [t, links] = await Promise.all([queryKusto(buildCongestionLeaderboardKql(scope, limit), signal), getTrafficLinks()]);
    const nameById = new Map(links.map((l) => [l.linkId, l.name]));
    const iLinkId = colIndex(t, 'LinkId');
    const iScore = colIndex(t, 'avgScore');
    const iDelay = colIndex(t, 'avgDelaySeconds');
    const iSpeed = colIndex(t, 'avgSpeed');
    const iN = colIndex(t, 'n');
    return t.Rows.map((r) => {
      const linkId = Number(r[iLinkId]);
      return {
        linkId,
        name: nameById.get(linkId) ?? `Link ${linkId}`,
        avgScore: Number(r[iScore]),
        avgDelaySeconds: Number(r[iDelay]),
        avgSpeedKmh: Number(r[iSpeed]),
        samples: Number(r[iN]),
      };
    });
  } catch {
    return [];
  }
}

export interface RouteOnTimeStat {
  routeId: string;
  avgDelayMinutes: number;
  onTimePct: number;
  samples: number;
}

export interface RouteLeaderboard {
  best: RouteOnTimeStat[];
  worst: RouteOnTimeStat[];
}

// Routes below this many matched observations swing wildly on a handful of
// stragglers (confirmed directly: several low-frequency route_ids show
// under 15% or over 90% on-time on fewer than ~50 samples, numbers that
// move drastically with the next hour of capture) - not a meaningful
// "worst route," just noise. 200 sits comfortably past where the ~60
// busiest routes' figures stop swinging significantly hour to hour.
const ROUTE_LEADERBOARD_MIN_SAMPLES = 200;

// BusStopObservations doesn't carry route_id (only vehicle_id/stop_id), so
// attributing an observation to a route means recovering it from
// EventSchemaBUS_v1. Rather than a true nearest-timestamp join (expensive
// over ~780K position rows), bucket positions into (vehicle_id, hour) and
// take each bucket's *most common* reported route_id (arg_max on the
// count, not on time - a vehicle can briefly report two route_ids near a
// terminus/depot changeover), then join BusStopObservations to that on the
// same (vehicle_id, hour) key. Confirmed directly against live data
// (2026-09-16): ~0.7s end to end, 98.7% of observations get a route match -
// the rare mid-hour route-change misattribution this trades away is a fine
// price for a leaderboard, not something safety- or billing-critical.
function buildRouteLeaderboardKql(scope: TrendScope, order: 'asc' | 'desc'): string {
  const vehicleRouteByHour = [
    'let vehicleRouteByHour = EventSchemaBUS_v1',
    // Two separate `extend` operators, not one comma-separated call - KQL
    // doesn't let a later assignment in the same `extend` reference an
    // earlier one from that same call (confirmed directly: combining them
    // throws "Failed to resolve scalar expression named 'evtTs'").
    '| extend evtTs = todatetime(timestamp)',
    '| extend hourBucket = bin(evtTs, 1h)',
    '| where isnotempty(route_id)',
    scopeFilter(scope, 'evtTs'),
    '| summarize n = count() by vehicle_id, hourBucket, route_id',
    '| summarize arg_max(n, route_id) by vehicle_id, hourBucket;',
  ]
    .filter(Boolean)
    .join('\n');
  const main = [
    'BusStopObservations',
    '| where abs(delay_minutes) < 120',
    scopeFilter(scope, 'ts'),
    '| extend hourBucket = bin(ts, 1h)',
    '| join kind=inner (vehicleRouteByHour) on vehicle_id, hourBucket',
    '| summarize avgDelay = round(avg(delay_minutes), 2), n = count(), pctOnTime = round(100.0 * countif(abs(delay_minutes) <= 2) / count(), 1) by route_id',
    `| where n >= ${ROUTE_LEADERBOARD_MIN_SAMPLES}`,
    `| order by pctOnTime ${order}`,
    '| take 5',
  ]
    .filter(Boolean)
    .join('\n');
  return `${vehicleRouteByHour}\n${main}`;
}

function parseRouteRows(t: KustoTable): RouteOnTimeStat[] {
  const iRoute = colIndex(t, 'route_id');
  const iAvg = colIndex(t, 'avgDelay');
  const iOnTime = colIndex(t, 'pctOnTime');
  const iN = colIndex(t, 'n');
  return t.Rows.map((r) => ({
    routeId: String(r[iRoute]),
    avgDelayMinutes: Number(r[iAvg]),
    onTimePct: Number(r[iOnTime]),
    samples: Number(r[iN]),
  }));
}

/** Best/worst on-time routes, restricted to routes with enough matched
 * samples to mean something (see ROUTE_LEADERBOARD_MIN_SAMPLES). Two
 * separate queries rather than one combined best+worst query - this is
 * fetched once on Trends-tab open (not polled), so the extra ~0.7s round
 * trip costs nothing next to the clarity of two plain `order by` queries.
 * Confirmed directly (2026-09-16): the busiest routes (5, 4, 6) are among
 * the *worst* for on-time performance, not the best - high frequency
 * doesn't buy reliability here, which is worth surfacing as its own
 * finding rather than assuming "busiest = best-run." Never throws -
 * graceful-empty (both lists empty) if nothing clears the sample bar yet. */
export async function fetchRouteLeaderboard(scope: TrendScope = 'all', signal?: AbortSignal): Promise<RouteLeaderboard> {
  try {
    const [bestTable, worstTable] = await Promise.all([
      queryKusto(buildRouteLeaderboardKql(scope, 'desc'), signal),
      queryKusto(buildRouteLeaderboardKql(scope, 'asc'), signal),
    ]);
    return { best: parseRouteRows(bestTable), worst: parseRouteRows(worstTable) };
  } catch {
    return { best: [], worst: [] };
  }
}
