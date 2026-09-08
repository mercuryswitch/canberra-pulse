/**
 * Client-side map-matching against the build-time route-shapes snapshot
 * (see vite/routeShapesSnapshot.ts). Snaps a raw GPS fix onto the nearest
 * point on its trip's actual route polyline, so vehicles sit on the road/
 * track rather than drifting off it from GPS noise.
 */

interface ShapesSnapshot {
  generatedAt: string;
  tripToShape: Record<string, string>;
  shapes: Record<string, [number, number][]>;
  tripHeadsign: Record<string, string>;
}

export interface ShapePoint {
  lat: number;
  lon: number;
  /** Cumulative real-world distance (metres) from the start of the shape. */
  dist: number;
}

export interface SnapResult {
  lat: number;
  lon: number;
  distanceAlong: number;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

let snapshotPromise: Promise<ShapesSnapshot | null> | null = null;
const shapeCache = new Map<string, ShapePoint[]>();

/** Fetch (once) and cache the route-shapes snapshot. Resolves to null if unavailable - callers fall back to raw GPS. */
function loadSnapshot(): Promise<ShapesSnapshot | null> {
  if (!snapshotPromise) {
    const url = `${import.meta.env.BASE_URL}route-shapes.json`;
    snapshotPromise = fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<ShapesSnapshot>) : null))
      .catch(() => null);
  }
  return snapshotPromise;
}

/** Preload the snapshot - call once at app startup so later lookups are synchronous-feeling. */
export function preloadShapes(): Promise<void> {
  return loadSnapshot().then(() => undefined);
}

/** A trip's destination/direction text (e.g. "City West"), or null if unmatched/unavailable. */
export async function getHeadsignForTrip(tripId: string): Promise<string | null> {
  const snap = await loadSnapshot();
  return snap?.tripHeadsign[tripId] ?? null;
}

/**
 * A trip's shape_id, or null if unmatched. Two trips sharing a shape_id are
 * the same physical route+direction - used for bunching detection, where
 * "same route, same direction" needs to be exact, not just same route_id
 * (a route_id can have multiple directions/patterns, each its own shape).
 */
export async function getShapeIdForTrip(tripId: string): Promise<string | null> {
  const snap = await loadSnapshot();
  return snap?.tripToShape[tripId] ?? null;
}

/** First point of a trip's route shape - a reasonable proxy for "where this route starts". */
export function shapeOrigin(shape: ShapePoint[]): { lat: number; lon: number } | null {
  return shape.length > 0 ? { lat: shape[0].lat, lon: shape[0].lon } : null;
}

/** Resolve a shape_id directly to its points (with cumulative distances precomputed). */
export async function getShapeById(shapeId: string): Promise<ShapePoint[] | null> {
  const snap = await loadSnapshot();
  if (!snap) return null;

  const cached = shapeCache.get(shapeId);
  if (cached) return cached;

  const raw = snap.shapes[shapeId];
  if (!raw || raw.length < 2) return null;

  const points: ShapePoint[] = [];
  let cumulative = 0;
  for (let i = 0; i < raw.length; i++) {
    const [lat, lon] = raw[i];
    if (i > 0) {
      const [prevLat, prevLon] = raw[i - 1];
      cumulative += haversineMeters(prevLat, prevLon, lat, lon);
    }
    points.push({ lat, lon, dist: cumulative });
  }
  shapeCache.set(shapeId, points);
  return points;
}

/** Resolve a trip's route shape (with cumulative distances precomputed), or null if unmatched/unavailable. */
export async function getShapeForTrip(tripId: string): Promise<ShapePoint[] | null> {
  const snap = await loadSnapshot();
  if (!snap) return null;
  const shapeId = snap.tripToShape[tripId];
  if (!shapeId) return null;
  return getShapeById(shapeId);
}

// How far forward/back of the vehicle's last known distanceAlong to trust a
// new snap, when we have one to anchor to. Forward window is generous
// (covers a genuine gap in real fixes - e.g. the vehicle briefly left the
// active window and reappeared several minutes of travel later), backward
// tolerance is small (just enough to absorb ordinary GPS/snapping noise,
// matching the same order of magnitude as PASSED_TOLERANCE_METERS in
// CesiumView's NextBus logic).
const SNAP_BACKWARD_TOLERANCE_METERS = 100;
const SNAP_FORWARD_WINDOW_METERS = 3000;

/**
 * Project (lat, lon) onto the nearest point on the shape's polyline.
 * Uses a simple equirectangular approximation (longitude scaled by cos(lat))
 * for the nearest-segment search - accurate enough at city scale, and only
 * used to pick the closest segment, not to measure real distances (those
 * come from the precomputed haversine `dist` values on each ShapePoint).
 *
 * `nearDistanceAlong`, when given, is the vehicle's own last known
 * distanceAlong on this same shape - the search then only considers
 * segments within a plausible forward-travel window of it. A pure global
 * nearest-segment search has no idea where the vehicle was a moment ago,
 * so on a genuinely curvy road (a bend that loops back near itself, or two
 * carriageways running close together on a curve) a noisy GPS fix can
 * legitimately be geometrically closer to the *wrong* nearby stretch of
 * the same shape than to the vehicle's actual, continuous position - that
 * snaps to the wrong segment outright, which looks like the vehicle
 * veering off route no matter how well the path between two snapped
 * points is later smoothed. Ross (2026-09-08): hit this specifically on a
 * curvy route, after the between-samples interpolation fix alone wasn't
 * enough. Falls back to an unrestricted global search when there's
 * nothing to anchor to yet (first fix, trip just started) or the window
 * genuinely contains no candidate (a real gap bigger than the window).
 */
export function snapToShape(
  shape: ShapePoint[],
  lat: number,
  lon: number,
  nearDistanceAlong?: number,
): SnapResult {
  const cosRef = Math.cos((shape[0].lat * Math.PI) / 180);
  const px = lon * cosRef;
  const py = lat;

  const inWindow = (distanceAlong: number) =>
    nearDistanceAlong == null ||
    (distanceAlong >= nearDistanceAlong - SNAP_BACKWARD_TOLERANCE_METERS &&
      distanceAlong <= nearDistanceAlong + SNAP_FORWARD_WINDOW_METERS);

  const initial: SnapResult & { d2: number } = {
    lat: shape[0].lat,
    lon: shape[0].lon,
    distanceAlong: 0,
    d2: Infinity,
  };
  let best = initial;
  let bestUnrestricted = initial;

  for (let i = 0; i < shape.length - 1; i++) {
    const a = shape[i];
    const b = shape[i + 1];
    const ax = a.lon * cosRef;
    const ay = a.lat;
    const bx = b.lon * cosRef;
    const by = b.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const sx = ax + t * dx;
    const sy = ay + t * dy;
    const d2 = (px - sx) ** 2 + (py - sy) ** 2;
    const distanceAlong = a.dist + t * (b.dist - a.dist);
    const candidate = {
      d2,
      lat: a.lat + t * (b.lat - a.lat),
      lon: a.lon + t * (b.lon - a.lon),
      distanceAlong,
    };
    if (d2 < bestUnrestricted.d2) bestUnrestricted = candidate;
    if (d2 < best.d2 && inWindow(distanceAlong)) best = candidate;
  }

  const result = best.d2 !== Infinity ? best : bestUnrestricted;
  return { lat: result.lat, lon: result.lon, distanceAlong: result.distanceAlong };
}

/**
 * The inverse of snapToShape's distanceAlong: given a distance along the
 * shape, the (lat, lon) at that point. Clamped to the shape's own length.
 * Powers continuous vehicle motion (2026-09-08): rather than Cesium
 * extrapolating a raw Cartesian straight line (which has no idea two
 * points are meant to follow a curve), CesiumView projects a vehicle's own
 * recent speed forward *along this shape* every render frame and asks
 * here for the actual on-track point at that distance - so the displayed
 * position can never leave the route, no matter how far it's coasting
 * past the last real fix.
 */
export function pointAtDistance(shape: ShapePoint[], distance: number): { lat: number; lon: number } {
  const clamped = Math.max(0, Math.min(distance, shape[shape.length - 1].dist));
  for (let i = 1; i < shape.length; i++) {
    if (shape[i].dist >= clamped) {
      const a = shape[i - 1];
      const b = shape[i];
      const span = b.dist - a.dist;
      const t = span > 0 ? (clamped - a.dist) / span : 0;
      return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
    }
  }
  const last = shape[shape.length - 1];
  return { lat: last.lat, lon: last.lon };
}
