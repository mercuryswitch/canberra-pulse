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
   * Which stop the vehicle is at/approaching, when known - powers #2
   * on-time performance. Only populated for rows ingested since 2026-09-06
   * (when this column was added); older/never-set rows come back as ''.
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

/** Fetch the latest position of every currently-active bus/light rail vehicle. */
export async function fetchBuses(signal?: AbortSignal): Promise<BusFeed> {
  const t = await queryKusto(BUSES_KQL, signal);
  const iId = colIndex(t, 'vehicle_id');
  const iRoute = colIndex(t, 'route_id');
  const iTrip = colIndex(t, 'trip_id');
  const iLat = colIndex(t, 'latitude');
  const iLon = colIndex(t, 'longitude');
  const iBearing = colIndex(t, 'bearing');
  const iStatus = colIndex(t, 'current_status');
  const iStopId = colIndex(t, 'stop_id');
  const iTs = colIndex(t, 'ts');
  const buses = t.Rows.map((r) => ({
    id: String(r[iId]),
    routeId: String(r[iRoute]),
    tripId: String(r[iTrip]),
    lat: Number(r[iLat]),
    lon: Number(r[iLon]),
    bearing: Number(r[iBearing]),
    status: r[iStatus] == null ? '' : String(r[iStatus]),
    stopId: r[iStopId] == null ? '' : String(r[iStopId]),
    ts: new Date(String(r[iTs])).getTime(),
  })).filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon));
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
 * binned. 0.0025 deg is ~230-280m at Canberra's latitude (was 0.005, ~450-
 * 560m) - Ross's ask 2026-09-07 for finer granularity so the gradient
 * spreads more evenly rather than a small number of coarse blocks.
 */
export const HEATMAP_GRID_DEGREES = 0.0025;

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
