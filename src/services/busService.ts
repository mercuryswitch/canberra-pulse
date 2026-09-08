import { colIndex, queryKusto } from './kustoClient';

export interface BusPosition {
  id: string;
  routeId: string;
  tripId: string;
  lat: number;
  lon: number;
  bearing: number;
  status: string;
  ts: number;
  /**
   * Which stop the vehicle is at, when known - powers #2 on-time performance
   * and the vehicle panel's "at stop" display. EventSchemaBUS_v1's own
   * stop_id column is always empty in practice - the Eventstream's CloudEvents
   * schema registry silently rejects any message carrying a field outside
   * its original registered shape, confirmed by direct test (2026-09-07).
   * Real values come from a join against BusStopObservations instead, a
   * small table fed by a separate, isolated notebook (ACTStopIdLoader) that
   * talks to Kusto directly and never touches the Eventstream at all - see
   * fetchStopObservations below.
   */
  stopId: string;
}

export interface BusFeed {
  asOf: string;
  buses: BusPosition[];
}

// Only surface vehicles whose latest ping is within this window of "now" -
// i.e. buses that are actually in service, not stale rows from a past run.
const ACTIVE_WINDOW = '5m';

const BUSES_KQL = `
EventSchemaBUS_v1
| extend ts = todatetime(timestamp)
| summarize arg_max(ts, *) by vehicle_id
| where ts > now() - ${ACTIVE_WINDOW}
| project vehicle_id, route_id, trip_id, latitude, longitude, bearing, current_status, stop_id, ts
`;

// BusStopObservations is fed by ACTStopIdLoader, a small notebook that talks
// to Kusto directly - see the stopId doc comment on BusPosition above for
// why this exists instead of just reading stop_id off EventSchemaBUS_v1
// itself. Window is short (not the 5m ACTIVE_WINDOW used for positions):
// this table only ever gets a row while a vehicle is actually STOPPED_AT a
// stop, so a short window keeps a vehicle that left the stop minutes ago
// from still showing a stale "at stop" - the consumers of BusPosition.stopId
// already gate on the vehicle's *current* status being STOPPED_AT too, but
// there's no reason to carry a stale match longer than it could plausibly
// still be true.
const STOP_OBS_WINDOW = '2m';

const STOP_OBSERVATIONS_KQL = `
BusStopObservations
| where ts > now() - ${STOP_OBS_WINDOW}
| summarize arg_max(ts, stop_id) by vehicle_id
`;

/** Latest known stop_id per vehicle, from the direct-to-Kusto path (see stopId doc above). */
async function fetchStopObservations(signal?: AbortSignal): Promise<Map<string, string>> {
  const t = await queryKusto(STOP_OBSERVATIONS_KQL, signal);
  const iVehicle = colIndex(t, 'vehicle_id');
  const iStop = colIndex(t, 'stop_id');
  const map = new Map<string, string>();
  for (const r of t.Rows) {
    const stop = r[iStop] == null ? '' : String(r[iStop]);
    if (stop) map.set(String(r[iVehicle]), stop);
  }
  return map;
}

/** Fetch the latest position of every currently-active bus/light rail vehicle. */
export async function fetchBuses(signal?: AbortSignal): Promise<BusFeed> {
  const [t, stopObs] = await Promise.all([
    queryKusto(BUSES_KQL, signal),
    // Never let a problem with this secondary table take down the main
    // position feed - worst case we just show no stop name, same as today.
    fetchStopObservations(signal).catch(() => new Map<string, string>()),
  ]);
  const iId = colIndex(t, 'vehicle_id');
  const iRoute = colIndex(t, 'route_id');
  const iTrip = colIndex(t, 'trip_id');
  const iLat = colIndex(t, 'latitude');
  const iLon = colIndex(t, 'longitude');
  const iBearing = colIndex(t, 'bearing');
  const iStatus = colIndex(t, 'current_status');
  const iStopId = colIndex(t, 'stop_id');
  const iTs = colIndex(t, 'ts');
  const buses = t.Rows.map((r) => {
    const id = String(r[iId]);
    const ownStopId = r[iStopId] == null ? '' : String(r[iStopId]);
    return {
      id,
      routeId: String(r[iRoute]),
      tripId: String(r[iTrip]),
      lat: Number(r[iLat]),
      lon: Number(r[iLon]),
      bearing: Number(r[iBearing]),
      status: r[iStatus] == null ? '' : String(r[iStatus]),
      stopId: ownStopId || stopObs.get(id) || '',
      ts: new Date(String(r[iTs])).getTime(),
    };
  }).filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon));
  return { asOf: new Date().toISOString(), buses };
}

/** One grid cell of the service-coverage heat map - see fetchHeatmapGrid. */
export interface HeatmapCell {
  latBin: number;
  lonBin: number;
  count: number;
}

// #1 service coverage heat map (2026-09-05): "which parts of Canberra
// actually get frequent real service" - unlike busService's own live query,
// this deliberately looks at HISTORY, not the 5-minute active window, since
// Kusto retains every ingested row (busCount/railCount are the only reason
// the app has otherwise only ever queried "now"). 24h is a pragmatic
// default: recent enough to mean "today's actual service pattern", bounded
// enough to keep the query fast as the table keeps growing. Grid size
// (~0.005 degrees, roughly 500m at Canberra's latitude) is a resolution
// choice, not a precise measurement - a raw ping count per cell is a proxy
// for time-spent/frequency, not a true service-frequency metric (a vehicle
// idling in one spot generates many pings without representing "frequent
// service") - acceptable for a first pass, worth refining later if the
// heat map ever needs to distinguish idling from throughput.
const HEATMAP_WINDOW = '1d';
/**
 * Exported so the renderer draws cells the exact size the query actually
 * binned. 0.0009 deg is ~80-100m at Canberra's latitude (was 0.0025,
 * ~230-280m; before that 0.005, ~450-560m) - Ross's ask 2026-09-08 for
 * ~100m cells. Lat/lon degrees don't cover equal ground (a degree of
 * longitude shrinks with cos(latitude)), so cells are a touch narrower
 * east-west than north-south rather than perfectly square - the same
 * approximation this file has always used, just at a finer grid now.
 */
export const HEATMAP_GRID_DEGREES = 0.0009;

const HEATMAP_KQL = `
EventSchemaBUS_v1
| extend ts = todatetime(timestamp)
| where ts > now() - ${HEATMAP_WINDOW}
| extend latBin = bin(latitude, ${HEATMAP_GRID_DEGREES}), lonBin = bin(longitude, ${HEATMAP_GRID_DEGREES})
| summarize hits = count() by latBin, lonBin
`;

/** Grid-cell ping counts over the last 24h, for the service-coverage heat map. */
export async function fetchHeatmapGrid(signal?: AbortSignal): Promise<HeatmapCell[]> {
  const t = await queryKusto(HEATMAP_KQL, signal);
  const iLat = colIndex(t, 'latBin');
  const iLon = colIndex(t, 'lonBin');
  const iHits = colIndex(t, 'hits');
  return t.Rows.map((r) => ({
    latBin: Number(r[iLat]),
    lonBin: Number(r[iLon]),
    count: Number(r[iHits]),
  })).filter((c) => Number.isFinite(c.latBin) && Number.isFinite(c.lonBin));
}
