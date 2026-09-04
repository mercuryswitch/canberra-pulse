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
| project vehicle_id, route_id, trip_id, latitude, longitude, bearing, current_status, ts
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
  const iTs = colIndex(t, 'ts');
  const buses = t.Rows.map((r) => ({
    id: String(r[iId]),
    routeId: String(r[iRoute]),
    tripId: String(r[iTrip]),
    lat: Number(r[iLat]),
    lon: Number(r[iLon]),
    bearing: Number(r[iBearing]),
    status: r[iStatus] == null ? '' : String(r[iStatus]),
    ts: new Date(String(r[iTs])).getTime(),
  })).filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon));
  return { asOf: new Date().toISOString(), buses };
}
