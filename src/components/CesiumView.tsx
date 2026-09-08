import {
  CallbackPositionProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ColorBlendMode,
  ConstantPositionProperty,
  createGooglePhotorealistic3DTileset,
  createOsmBuildingsAsync,
  ExtrapolationType,
  HeadingPitchRoll,
  HeightReference,
  ImageryLayer,
  Ion,
  JulianDate,
  LabelStyle,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  Quaternion,
  Rectangle,
  SampledProperty,
  Terrain,
  Transforms,
  Viewer,
  type Entity,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  type BusPosition,
  fetchBuses,
  fetchHeatmapGrid,
  HEATMAP_GRID_DEGREES,
  type HeatmapCell,
} from '@/services/busService';
import { connectDataInteractive, KustoInteractionRequiredError } from '@/services/kustoClient';
import { getPopulationCells, preloadPopulation, type PopulationCell } from '@/services/populationService';
import {
  getHeadsignForTrip,
  getShapeById,
  getShapeForTrip,
  getShapeIdForTrip,
  haversineMeters,
  pointAtDistance,
  preloadShapes,
  shapeOrigin,
  type ShapePoint,
  snapToShape,
} from '@/services/shapeService';
import {
  computePunctuality,
  formatArrivalClock,
  getAllStopCoordinates,
  getNearestStopName,
  getNearestStops,
  getScheduledArrival,
  getStopName,
  getStopsForTrip,
  minutesUntil,
  type NearestStop,
  preloadStopArrivals,
  type Punctuality,
  secondsSinceMidnightNow,
  secondsSinceMidnightOf,
  type TripStop,
} from '@/services/stopService';

// Optional: a free Cesium Ion token (ion.cesium.com) unlocks world terrain and
// Google Photorealistic 3D Tiles. Without it we fall back to keyless
// OpenStreetMap imagery on a plain ellipsoid - fine for an MVP.
const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN;

const CANBERRA = { lon: 149.13, lat: -35.28, height: 15000 };
const POLL_MS = 8_000;

// Continuous vehicle motion (2026-09-08) - see the position CallbackProperty
// in the poll loop for how these get used. A generous upper bound well
// above any real bus/light rail, so a GPS/snapping blip can't imply an
// absurd projected speed; and how long to keep coasting on a stale speed
// estimate before just holding still, comfortably longer than one normal
// ~8s poll gap (POLL_MS) plus network latency, so an ordinary gap between
// fixes never causes a visible stall while still not coasting forever if
// a vehicle genuinely stops reporting.
const MAX_EXTRAPOLATION_SPEED_MPS = 30; // ~108 km/h
const COAST_MAX_SECONDS = 30;

// Light rail vehicle IDs follow the "LRV<n>" pattern in this feed; everything
// else is a bus. Model choice (and, before this, marker color) encodes type.
const RAIL_ID = /^LRV/i;
function isLightRail(id: string): boolean {
  return RAIL_ID.test(id);
}
// tram.glb doesn't render in Cesium despite a structurally valid file (no
// extensions, standard accessors, normal materials - confirmed by isolating
// it against the working bus model with identical entity code). Using the
// bus mesh for both vehicle types until a working tram/light-rail model is
// sourced; color is what actually distinguishes them on screen for now.
const VEHICLE_MODEL = { uri: '/models/bus.glb', scale: 1.15 };
// The model's own authored "forward" axis doesn't line up with the axis
// Cesium treats as heading-0-points-north, so every vehicle renders with the
// same fixed rotational offset regardless of its (correct) real bearing.
// Was +90 (fixed the original "facing 90 degrees sideways" bug), but Ross
// confirmed 2026-09-05 that reads as driving backwards - flipping the sign
// is exactly a 180 degree change (90 - (-90) = 180), which is precisely
// "backwards" vs "sideways", so this is the anticipated fix, not a guess.
const MODEL_HEADING_OFFSET_DEG = -90;
// Matches the actual model tint colors below, so the legend swatches are
// accurate rather than an arbitrary separate palette.
const TYPE_COLOR = { bus: '#FFA500', rail: '#CF1A2B' };

const STATUS_LABEL: Record<string, string> = {
  IN_TRANSIT_TO: 'In transit',
  STOPPED_AT: 'Stopped',
  INCOMING_AT: 'Approaching stop',
};

/** "320 m" below 1km, "1.2 km" above - matches how people actually read distances. */
function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

/** One row in the "NextBus" panel - the nearest live vehicle on one route serving a clicked stop. */
interface NextBusRow {
  routeId: string;
  vehicleId: string;
  /** Sitting at/near the start of its shape - not yet meaningfully underway. */
  atTerminus: boolean;
  /** Metres from the vehicle to the clicked stop, straight-line. */
  distanceMeters: number;
  /** "Dickson to City (25)" - nearest-stop-to-shape-origin + headsign + route. Null if unresolvable. */
  directionLabel: string | null;
  /** Nearest stop name to the vehicle's current position, e.g. "Dickson Interchange". */
  currentLocationName: string | null;
}

/** One row in the #2 on-time performance panel - a currently-stopped vehicle with a resolvable schedule match. */
interface OnTimeEntry {
  vehicleId: string;
  routeId: string;
  stopId: string;
  punctuality: Punctuality;
}

function VehiclePanel({ bus, onClose }: { bus: BusPosition; onClose: () => void }) {
  // #2 on-time performance (2026-09-06): only meaningful when the vehicle
  // is actually stopped at a known stop - "on time" isn't well-defined for
  // a vehicle mid-route between stops. stop_id only exists on rows ingested
  // since the pipeline change, so older-looking vehicles simply won't have
  // one yet even while STOPPED_AT.
  const [punctuality, setPunctuality] = useState<Punctuality | null>(null);
  const [stopName, setStopName] = useState<string | null>(null);
  useEffect(() => {
    setPunctuality(null);
    setStopName(null);
    if (bus.status !== 'STOPPED_AT' || !bus.stopId) return;
    let cancelled = false;
    void getStopName(bus.stopId).then((name) => {
      if (!cancelled) setStopName(name);
    });
    void getScheduledArrival(bus.tripId, bus.stopId).then((scheduledSeconds) => {
      if (cancelled || scheduledSeconds == null) return;
      setPunctuality(computePunctuality(scheduledSeconds, secondsSinceMidnightOf(new Date(bus.ts))));
    });
    return () => {
      cancelled = true;
    };
  }, [bus.tripId, bus.stopId, bus.status, bus.ts]);

  const rows: [string, string][] = [
    ['Vehicle', bus.id],
    ['Type', isLightRail(bus.id) ? 'Light rail' : 'Bus'],
    ['Route', bus.routeId],
    ['Trip', bus.tripId],
    ['Status', STATUS_LABEL[bus.status] ?? bus.status],
    ['Position', `${bus.lat.toFixed(5)}, ${bus.lon.toFixed(5)}`],
    ['Last update', new Date(bus.ts).toLocaleTimeString()],
  ];
  if (stopName) rows.push(['At stop', stopName]);
  if (punctuality) rows.push(['Punctuality', punctuality.label]);
  // A bottom bar rather than a tall left-side panel (2026-09-05, Ross's
  // ask) - the left side is where the Bus/Rail/Routes/etc. lists live, and
  // the old top-20/bottom-4 panel was covering them whenever a vehicle from
  // one of those lists was selected.
  return (
    <div className="absolute left-4 right-4 bottom-4 z-30 rounded-2xl border border-white/10 bg-slate-950/85 text-white shadow-2xl backdrop-blur-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
        <span className="font-medium text-sm">Vehicle {bus.id}</span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-white/50 hover:text-white transition-colors text-lg leading-none"
        >
          &times;
        </button>
      </div>
      <div className="px-4 py-3 flex flex-wrap gap-x-8 gap-y-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <div className="text-[11px] uppercase tracking-wide text-white/40">{label}</div>
            <div className="text-sm">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CesiumView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const entitiesRef = useRef<Map<string, Entity>>(new Map());
  const positionsRef = useRef<Map<string, CallbackPositionProperty>>(new Map());
  const orientationsRef = useRef<Map<string, SampledProperty>>(new Map());
  const lastSampleTsRef = useRef<Map<string, number>>(new Map());
  const lastTripIdRef = useRef<Map<string, string>>(new Map());
  // #3 bus bunching (2026-09-05): each vehicle's position along its own
  // shape, kept only for vehicles that successfully map-matched (bunching
  // comparisons need "same physical route+direction", which shape_id
  // captures exactly - route_id alone can span multiple directions/patterns).
  const vehicleProgressRef = useRef<Map<string, { shapeId: string; distanceAlong: number; routeId: string }>>(
    new Map(),
  );
  // Continuous vehicle motion (2026-09-08): the position CallbackProperty
  // below reads this live, every render frame, to project a vehicle's
  // recent real speed forward *along its own shape* since the last real
  // fix - see pointAtDistance's doc comment for why. Separate from
  // vehicleProgressRef above: that one is deliberately absent for an
  // unmatched trip (bunching should just skip it), but rendering always
  // needs *something* to draw, hence the fallbackLat/Lon raw-fix escape
  // hatch when shape is null.
  const vehicleTrackRef = useRef<
    Map<
      string,
      {
        shape: ShapePoint[] | null;
        distanceAlong: number;
        atTimeMs: number;
        speedMps: number;
        fallbackLat: number;
        fallbackLon: number;
      }
    >
  >(new Map());
  const busDataRef = useRef<Map<string, BusPosition>>(new Map());
  const [needsConnect, setNeedsConnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busCount, setBusCount] = useState(0);
  const [railCount, setRailCount] = useState(0);
  const [pollTick, setPollTick] = useState(0);
  const [filterType, setFilterType] = useState<'all' | 'bus' | 'rail'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedBus, setSelectedBus] = useState<BusPosition | null>(null);
  const [nearMeActive, setNearMeActive] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const userEntityRef = useRef<Entity | null>(null);
  const stopEntitiesRef = useRef<Entity[]>([]);
  const hasFlownToUserRef = useRef(false);

  // Fetch the route-shapes snapshot once up front, so by the time real
  // position polling starts, map-matching lookups resolve near-instantly
  // from the in-memory cache rather than racing the first live update.
  useEffect(() => {
    void preloadShapes();
  }, []);

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;
    if (ION_TOKEN) Ion.defaultAccessToken = ION_TOKEN;

    const viewer = new Viewer(containerRef.current, {
      baseLayer: ION_TOKEN
        ? undefined
        : ImageryLayer.fromProviderAsync(
            Promise.resolve(
              new OpenStreetMapImageryProvider({ url: 'https://a.tile.openstreetmap.org/' }),
            ),
            {},
          ),
      terrain: ION_TOKEN ? Terrain.fromWorldTerrain() : undefined,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: true,
    });
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(CANBERRA.lon, CANBERRA.lat, CANBERRA.height),
      orientation: { pitch: CesiumMath.toRadians(-45) },
      duration: 0,
    });
    viewerRef.current = viewer;
    // Debug aid only - lets DevTools console inspect live entity/viewer
    // state directly (e.g. window.__viewer.entities.values) without another
    // guess-and-redeploy cycle. Harmless in production, just a global.
    (window as unknown as { __viewer: Viewer }).__viewer = viewer;

    // SampledPositionProperty only glides smoothly if the clock is actually
    // advancing in real time - without this, currentTime stays wherever it
    // was initialized and every entity just jumps straight to whatever's
    // current each time something else forces a redraw.
    viewer.clock.shouldAnimate = true;
    viewer.clock.multiplier = 1;

    // Photoreal 3D city mesh when an Ion token is present. Try Google's tiles
    // first (the real "wow" factor); fall back to Cesium OSM Buildings if
    // that asset isn't enabled on this Ion account.
    //
    // enableCollision is required for HeightReference.CLAMP_TO_GROUND to
    // clamp against this tileset's own surface rather than falling back to
    // the bare terrain height field underneath - per Cesium's own docs on
    // HeightReference.CLAMP_TO_GROUND: "When clamping to 3D Tilesets such as
    // photorealistic 3D Tiles, ensure the tileset has enableCollision set to
    // true. Otherwise, the entity may not be correctly clamped to the
    // tileset surface." Root cause of vehicles appearing to hover ~10m above
    // the visible street (2026-09-05) - bare terrain and the photorealistic
    // tileset's actual road/ground surface are different height fields, and
    // without this flag vehicles were clamped to the former while the
    // visible ground came from the latter. Confirmed the model file itself
    // was not the cause first (its own pivot sits within 1.2cm of the
    // vehicle's true ground contact point - checked directly against the
    // glTF's node transforms and mesh bounding box).
    if (ION_TOKEN) {
      void createGooglePhotorealistic3DTileset(undefined, { enableCollision: true })
        .then((ts) => viewer.scene.primitives.add(ts))
        .catch(() => {
          void createOsmBuildingsAsync()
            .then((ts) => {
              ts.enableCollision = true;
              viewer.scene.primitives.add(ts);
            })
            .catch(() => {
              /* keyless base already renders fine without buildings */
            });
        });
    }

    // Drive our own side panel off Cesium's selection state, rather than its
    // built-in infoBox, so the panel matches the app's own visual style.
    viewer.selectedEntityChanged.addEventListener((entity) => {
      setSelectedId(entity ? String(entity.id) : null);
    });

    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // Keep the panel's data fresh from the latest poll, and clear it if the
  // vehicle drops out of the active window.
  useEffect(() => {
    setSelectedBus(selectedId ? (busDataRef.current.get(selectedId) ?? null) : null);
  }, [selectedId, busCount, railCount]);

  // #12 route navigator (2026-09-05): pick a specific route_id from a list
  // of every route currently in the live feed, rather than just bus/rail
  // type. Takes priority over the type filter when set - mutually exclusive
  // with it and with Near Me in the UI, same "avoid two competing panels"
  // rule as everything else here.
  const [routeFilter, setRouteFilter] = useState<string | null>(null);
  const [showRoutesList, setShowRoutesList] = useState(false);
  const [showBunching, setShowBunching] = useState(false);
  // #1 service coverage heat map (2026-09-05): fetched once per toggle-open,
  // not on every poll - it's a 24h history aggregate, not a live view, so
  // there's nothing meaningful to refresh every 8s.
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatmapCells, setHeatmapCells] = useState<HeatmapCell[]>([]);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  // #4 equity overlay (2026-09-08): "how population is spread across the
  // city, and where that doesn't match actual bus service." Shares the
  // exact same heatmapCells data the heat map itself uses (see the fetch
  // effect below, widened to trigger on either toggle) - this is a real
  // correlation against the heat map, not a separate approximation of it.
  const [showEquity, setShowEquity] = useState(false);
  const [populationCells, setPopulationCells] = useState<PopulationCell[]>([]);
  const [equityLoading, setEquityLoading] = useState(false);
  const equityEntitiesRef = useRef<Entity[]>([]);
  // Boost applied to each cell's relative intensity before colouring - see
  // the rendering effect below. 1 = linear; higher values pull mid/low
  // values UP toward the hot end (any cell with real traffic, however
  // little, reads as more prominent), while genuinely zero-count cells
  // stay exactly at zero regardless (0 raised to any power is still 0) -
  // so "no traffic at all" stays visually distinct even at high boost.
  // 2026-09-07 (Ross): after the percentile fix, the map was too binary -
  // pale blue or dark red with barely any transition - so this needed to
  // let more of the low/mid range show up as warm, not be compressed
  // further toward cold as the original (inverse) exponent direction did.
  // Default 25 (halfway across the 1-50 slider) per Ross's 2026-09-08 ask -
  // was 1 (neutral/linear), which undersold the gradient before anyone
  // touched the slider.
  const [heatmapSensitivity, setHeatmapSensitivity] = useState(25);
  const heatmapEntitiesRef = useRef<Entity[]>([]);
  const routeLineEntitiesRef = useRef<Entity[]>([]);
  // #2 on-time performance (2026-09-06): every currently STOPPED_AT vehicle
  // with a resolvable schedule match, recomputed each poll. Only meaningful
  // for vehicles actually at a stop right now - "on time" isn't well-defined
  // mid-route - and only for rows carrying stop_id, which only exists on
  // data ingested since the pipeline change (see PROJECT_STATUS.md).
  const [showOnTime, setShowOnTime] = useState(false);
  const [onTimeEntries, setOnTimeEntries] = useState<OnTimeEntry[]>([]);
  // Summary stat (2026-09-07, Ross's ask) - a single stopped vehicle's
  // punctuality isn't network-level information; the median plus the
  // min/max range across every currently-matched vehicle is. Median rather
  // than mean since a handful of very early/very late outliers shouldn't
  // drag a "typical" figure around.
  const onTimeSummary = useMemo(() => {
    if (onTimeEntries.length === 0) return null;
    const sorted = onTimeEntries.map((e) => e.punctuality.delayMinutes).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return { median, min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length };
  }, [onTimeEntries]);
  // On-time gauge/histogram pop-out (2026-09-08, Ross's ask) - a separate
  // panel, doesn't touch the existing on-time block above at all. Only a
  // *this-session* trend, not real history - see the median-tracking
  // notebook work still in progress for durable multi-day tracking; this
  // rolling buffer resets whenever the on-time panel closes, deliberately,
  // so a reopened panel never shows a stale/discontinuous graph.
  const [showOnTimeViz, setShowOnTimeViz] = useState(false);
  const MEDIAN_HISTORY_MAX = 60; // ~8 minutes of session history at the 8s poll cadence
  const [medianHistory, setMedianHistory] = useState<{ t: number; median: number }[]>([]);
  useEffect(() => {
    if (!showOnTime) {
      setMedianHistory([]);
      return;
    }
    if (!onTimeSummary) return;
    setMedianHistory((prev) => {
      const next = [...prev, { t: Date.now(), median: onTimeSummary.median }];
      return next.length > MEDIAN_HISTORY_MAX ? next.slice(next.length - MEDIAN_HISTORY_MAX) : next;
    });
  }, [showOnTime, onTimeSummary]);
  const allRoutes = useMemo(() => {
    const routes = new Set<string>();
    for (const bus of busDataRef.current.values()) routes.add(bus.routeId);
    return Array.from(routes).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- busDataRef is a
    // ref; pollTick is the actual trigger for recomputing this each poll.
  }, [pollTick]);

  // #3 bus bunching (2026-09-05): two vehicles on the exact same shape (same
  // route, same direction) closer together along the route than they'd
  // realistically be if evenly spread - a classic under-resourcing/recovery-
  // time signal. MVP version: real headway only, no comparison against
  // scheduled headway (that needs the same per-trip schedule work #2 does -
  // a reasonable follow-up once #2's snapshot exists, not built yet).
  const BUNCHING_THRESHOLD_METERS = 400;
  const bunchingAlerts = useMemo(() => {
    const byShape = new Map<string, { vehicleId: string; distanceAlong: number; routeId: string }[]>();
    for (const [vehicleId, p] of vehicleProgressRef.current) {
      let group = byShape.get(p.shapeId);
      if (!group) {
        group = [];
        byShape.set(p.shapeId, group);
      }
      group.push({ vehicleId, ...p });
    }
    const alerts: { routeId: string; vehicleA: string; vehicleB: string; gapMeters: number }[] = [];
    for (const group of byShape.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.distanceAlong - b.distanceAlong);
      for (let i = 0; i < group.length - 1; i++) {
        const gap = group[i + 1].distanceAlong - group[i].distanceAlong;
        if (gap <= BUNCHING_THRESHOLD_METERS) {
          alerts.push({
            routeId: group[i].routeId,
            vehicleA: group[i].vehicleId,
            vehicleB: group[i + 1].vehicleId,
            gapMeters: gap,
          });
        }
      }
    }
    return alerts.sort((a, b) => a.gapMeters - b.gapMeters);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vehicleProgressRef
    // is a ref; pollTick is the actual trigger for recomputing this each poll.
  }, [pollTick]);

  // Fetch the heat map grid once per toggle-open (not on every poll - see
  // the state comment above for why). Unions in every known stop location,
  // binned to the same grid, as a synthetic zero-count cell wherever the
  // live-ping query didn't already cover it - this is what lets the map
  // show "there's a stop here but barely anything actually stops" as a
  // distinct cold cell, rather than that area just being blank (Ross's ask,
  // 2026-09-05: "areas that are underutilised or not close to a bus stop").
  // A location with no rectangle at all still means something too: no stop
  // and no observed activity either.
  useEffect(() => {
    // Equity also needs this same ping/stop grid to correlate against - see
    // showEquity's own doc comment above.
    if (!showHeatmap && !showEquity) return;
    let cancelled = false;
    setHeatmapLoading(true);
    const controller = new AbortController();
    void Promise.all([fetchHeatmapGrid(controller.signal), getAllStopCoordinates()])
      .then(([pingCells, stops]) => {
        if (cancelled) return;
        const byBin = new Map<string, HeatmapCell>();
        for (const cell of pingCells) byBin.set(`${cell.latBin}|${cell.lonBin}`, cell);
        for (const stop of stops) {
          const latBin = Math.floor(stop.lat / HEATMAP_GRID_DEGREES) * HEATMAP_GRID_DEGREES;
          const lonBin = Math.floor(stop.lon / HEATMAP_GRID_DEGREES) * HEATMAP_GRID_DEGREES;
          const key = `${latBin}|${lonBin}`;
          if (!byBin.has(key)) byBin.set(key, { latBin, lonBin, count: 0 });
        }
        setHeatmapCells(Array.from(byBin.values()));
      })
      .catch(() => {
        if (!cancelled) setHeatmapCells([]);
      })
      .finally(() => {
        if (!cancelled) setHeatmapLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [showHeatmap, showEquity]);

  // Population doesn't change between Census years - fetch once, when
  // first needed, same lazy-preload pattern as stop arrivals/route shapes.
  useEffect(() => {
    if (!showEquity) return;
    let cancelled = false;
    setEquityLoading(true);
    void preloadPopulation()
      .then(() => getPopulationCells())
      .then((cells) => {
        if (!cancelled) setPopulationCells(cells);
      })
      .finally(() => {
        if (!cancelled) setEquityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showEquity]);

  // Percentile RANK (position in sorted order, not value-relative-to-a-
  // reference) for each entry - deliberately robust to skew, unlike a
  // percentage-of-max approach, since population density and heat-map
  // ping counts are both likely to have a handful of extreme outliers
  // (a CBD block, a busy interchange) that would otherwise flatten
  // everything else toward one end, exactly the problem the heat map
  // itself hit before its own percentile fix.
  function percentileRanks(values: number[]): number[] {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const ranks = new Array<number>(values.length);
    const denom = values.length > 1 ? values.length - 1 : 1;
    order.forEach(([, originalIndex], rank) => {
      ranks[originalIndex] = rank / denom;
    });
    return ranks;
  }

  // Draw each SA1 as a filled polygon, colored by how much more densely
  // populated it is than it is well-served, *relative to every other area
  // in the ACT* - not an absolute ratio (population and a single 100m
  // ping-count cell are different scales entirely, so dividing one by the
  // other would be numerically meaningless), but a genuine percentile-rank
  // gap: red means "more densely populated than average, relative to how
  // little service reaches it" - the literal "overpopulated but
  // underutilised" framing Ross asked for (2026-09-08). Reuses heatColor
  // for visual consistency with the heat map itself.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const entity of equityEntitiesRef.current) viewer.entities.remove(entity);
    equityEntitiesRef.current = [];
    if (!showEquity || populationCells.length === 0) return;

    const heatByBin = new Map<string, number>();
    for (const cell of heatmapCells) heatByBin.set(`${cell.latBin}|${cell.lonBin}`, cell.count);

    const densities = populationCells.map((c) => c.population / c.areaSqKm);
    const heats = populationCells.map((c) => {
      const latBin = Math.floor(c.centroidLat / HEATMAP_GRID_DEGREES) * HEATMAP_GRID_DEGREES;
      const lonBin = Math.floor(c.centroidLon / HEATMAP_GRID_DEGREES) * HEATMAP_GRID_DEGREES;
      return heatByBin.get(`${latBin}|${lonBin}`) ?? 0;
    });
    const densityRanks = percentileRanks(densities);
    const heatRanks = percentileRanks(heats);

    equityEntitiesRef.current = populationCells.map((cell, i) => {
      const gap = densityRanks[i] - heatRanks[i]; // -1..1
      const intensity = Math.max(0, Math.min(1, (gap + 1) / 2));
      const color = heatColor(intensity).withAlpha(0.2 + 0.5 * intensity);
      const positions = cell.polygon.flatMap(([lat, lon]) => [lon, lat]);
      return viewer.entities.add({
        polygon: {
          hierarchy: Cartesian3.fromDegreesArray(positions),
          material: color,
          height: 0,
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      });
    });
    return () => {
      for (const entity of equityEntitiesRef.current) viewer.entities.remove(entity);
      equityEntitiesRef.current = [];
    };
  }, [showEquity, populationCells, heatmapCells]);

  // Draw the grid as translucent colored rectangles: blue (cold - a stop
  // exists here but little/no observed activity) through yellow to red
  // (hot - genuinely high traffic), scaled against the hottest cell in the
  // *current* dataset (not a fixed absolute scale - with only ~2 weeks of
  // history so far, an absolute scale would need constant recalibration as
  // more data lands). `heatmapSensitivity` (a user-adjustable slider,
  // 2026-09-05 - Ross's ask, replacing a fixed linear scale that made
  // moderate cells look misleadingly "hot") is an exponent applied to the
  // 0-1 relative intensity before mapping to color: >1 compresses low/mid
  // values toward cold and reserves red for only the genuinely highest
  // cells ("ultra-high" per Ross), 1 is the original linear behaviour.
  //
  // 2026-09-07 fix: scaling against the single busiest cell (the original
  // approach) breaks badly once ~2500 zero/low-traffic stop cells are
  // unioned in alongside a handful of genuinely mega-busy interchange
  // cells - that's an extremely skewed (long-tail) distribution, and a
  // linear-or-power ratio against the one absolute max crushes nearly
  // everything toward one end (Ross: "either red or blue, often all
  // blue"), since almost every real cell sits far below that one outlier.
  // Scaling against the 90th percentile of *non-zero* cells instead (any
  // cell at/above that point just reads as fully hot) keeps one freak busy
  // stop from flattening the whole map's dynamic range.
  // Darker red top end (was #D32F2F) per Ross's ask 2026-09-07 for a more
  // dramatic hot end once cells actually reach it.
  function heatColor(intensity: number): Color {
    if (intensity <= 0.5) {
      return Color.lerp(
        Color.fromCssColorString('#2979FF'),
        Color.fromCssColorString('#FFF59D'),
        intensity * 2,
        new Color(),
      );
    }
    return Color.lerp(
      Color.fromCssColorString('#FFF59D'),
      Color.fromCssColorString('#8B0000'),
      (intensity - 0.5) * 2,
      new Color(),
    );
  }
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const entity of heatmapEntitiesRef.current) viewer.entities.remove(entity);
    heatmapEntitiesRef.current = [];
    if (!showHeatmap || heatmapCells.length === 0) return;
    const sortedNonZero = heatmapCells
      .map((c) => c.count)
      .filter((c) => c > 0)
      .sort((a, b) => a - b);
    const referenceMax =
      sortedNonZero.length > 0
        ? sortedNonZero[Math.floor(sortedNonZero.length * 0.9)]
        : 1;
    heatmapEntitiesRef.current = heatmapCells.map((cell) => {
      const raw = referenceMax > 0 ? Math.min(1, cell.count / referenceMax) : 0;
      const intensity = Math.pow(raw, 1 / heatmapSensitivity);
      const color = heatColor(intensity).withAlpha(0.15 + 0.55 * intensity);
      return viewer.entities.add({
        rectangle: {
          coordinates: Rectangle.fromDegrees(
            cell.lonBin,
            cell.latBin,
            cell.lonBin + HEATMAP_GRID_DEGREES,
            cell.latBin + HEATMAP_GRID_DEGREES,
          ),
          material: color,
          height: 0,
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      });
    });
    return () => {
      for (const entity of heatmapEntitiesRef.current) viewer.entities.remove(entity);
      heatmapEntitiesRef.current = [];
    };
  }, [showHeatmap, heatmapCells, heatmapSensitivity]);

  // #2 on-time performance: recomputed every poll while the panel is open.
  // Deliberately scans every currently-active vehicle each time rather than
  // caching between polls - the set of STOPPED_AT vehicles changes
  // constantly, and schedule lookups are cheap in-memory object gets once
  // the snapshot is loaded (no network cost after the first call).
  useEffect(() => {
    if (!showOnTime) {
      setOnTimeEntries([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const entries: OnTimeEntry[] = [];
      for (const bus of busDataRef.current.values()) {
        if (bus.status !== 'STOPPED_AT' || !bus.stopId) continue;
        const scheduled = await getScheduledArrival(bus.tripId, bus.stopId);
        if (scheduled == null) continue;
        const punctuality = computePunctuality(scheduled, secondsSinceMidnightOf(new Date(bus.ts)));
        entries.push({ vehicleId: bus.id, routeId: bus.routeId, stopId: bus.stopId, punctuality });
      }
      if (!cancelled) {
        entries.sort((a, b) => b.punctuality.delayMinutes - a.punctuality.delayMinutes);
        setOnTimeEntries(entries);
      }
    })();
    return () => {
      cancelled = true;
    };
    // busDataRef is a ref (no lint complaint about it as a missing dep);
    // pollTick is the actual trigger for recomputing this each poll.
  }, [showOnTime, pollTick]);

  // Draw the actual route line(s) as a visible overlay (2026-09-05, Ross's
  // ask) - a direct visual answer to "are vehicles actually locked to their
  // route", using the exact same shape data already used for map-matching,
  // not a separate/approximate line. Two triggers: selecting a single
  // vehicle draws just that vehicle's own shape; selecting a route via the
  // Routes navigator draws every distinct shape currently in use by that
  // route's active vehicles (a route_id can have more than one - different
  // directions are different shapes).
  useEffect(() => {
    if (!viewerRef.current) return;
    let cancelled = false;

    async function draw() {
      const viewer = viewerRef.current;
      if (!viewer) return;
      const shapeIds = new Set<string>();
      if (routeFilter) {
        for (const p of vehicleProgressRef.current.values()) {
          if (p.routeId === routeFilter) shapeIds.add(p.shapeId);
        }
      } else if (selectedBus) {
        const shapeId = await getShapeIdForTrip(selectedBus.tripId);
        if (shapeId) shapeIds.add(shapeId);
      }

      const shapes = await Promise.all(
        Array.from(shapeIds).map(async (shapeId) => ({
          shapeId,
          points: await getShapeById(shapeId),
        })),
      );
      if (cancelled) return;

      for (const entity of routeLineEntitiesRef.current) viewer.entities.remove(entity);
      routeLineEntitiesRef.current = shapes
        .filter((s): s is { shapeId: string; points: NonNullable<typeof s.points> } => !!s.points)
        .map((s) =>
          viewer.entities.add({
            polyline: {
              positions: Cartesian3.fromDegreesArray(
                s.points.flatMap((p) => [p.lon, p.lat]),
              ),
              width: 4,
              material: Color.CYAN.withAlpha(0.65),
              clampToGround: true,
            },
          }),
        );
    }

    void draw();
    return () => {
      cancelled = true;
      if (viewerRef.current) {
        for (const entity of routeLineEntitiesRef.current) viewerRef.current.entities.remove(entity);
      }
      routeLineEntitiesRef.current = [];
    };
    // vehicleProgressRef is a ref (no lint complaint about it as a missing
    // dep); pollTick keeps the route-filter case's shape set current as
    // vehicles come and go.
  }, [routeFilter, selectedBus, pollTick]);

  // The poll loop below has an empty dependency array (it's a long-lived
  // interval, not something to restart on every filter click), so it reads
  // the current filter through this ref rather than a stale closure value.
  const filterTypeRef = useRef(filterType);
  const routeFilterRef = useRef(routeFilter);
  useEffect(() => {
    filterTypeRef.current = filterType;
    routeFilterRef.current = routeFilter;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const visible: Entity[] = [];
    for (const [id, entity] of entitiesRef.current) {
      const show = routeFilter
        ? busDataRef.current.get(id)?.routeId === routeFilter
        : filterType === 'all' || (filterType === 'rail') === isLightRail(id);
      entity.show = show;
      if (show) visible.push(entity);
    }
    if ((filterType !== 'all' || routeFilter) && visible.length > 0) void viewer.flyTo(visible);
  }, [filterType, routeFilter]);

  // Raw data list backing the "Bus"/"Light rail" filter buttons - lets you
  // verify exactly which vehicle IDs are actually in the feed right now,
  // not just a count.
  const filteredList = useMemo(() => {
    if (filterType === 'all') return [];
    return Array.from(busDataRef.current.values())
      .filter((b) => (filterType === 'rail') === isLightRail(b.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- busDataRef is a
    // ref; pollTick is the actual trigger for recomputing this each poll.
  }, [filterType, pollTick]);

  // #11 "next vehicle near me", v2 (2026-09-05): nearest STOP(s), not nearest
  // live vehicle. Both sides of the street are separate stop_ids a few
  // metres apart, so "nearest 4" usually covers both directions without
  // needing to explicitly pair them up - not guaranteed for every stop
  // layout (a busy intersection can have more than 2 stops within the same
  // radius), which is why this is a count, not real direction-pairing logic.
  // Recomputed only when the user's
  // location actually changes (stop positions/schedules don't change every
  // 8s poll) - see stopService.ts. The live-proximity check below is the
  // thing that needs to re-run every poll.
  const [nearestStops, setNearestStops] = useState<NearestStop[]>([]);
  useEffect(() => {
    if (!nearMeActive || !userLocation) {
      setNearestStops([]);
      return;
    }
    let cancelled = false;
    void getNearestStops(userLocation.lat, userLocation.lon, 4).then((stops) => {
      if (!cancelled) setNearestStops(stops);
    });
    return () => {
      cancelled = true;
    };
  }, [nearMeActive, userLocation]);

  // A live vehicle actually on the route, within this radius of the stop, is
  // a far better "next bus" signal than the static timetable - no ETA/shape
  // math needed: a physical stop only serves one direction, so any live
  // vehicle on that exact route_id nearby is (per Ross, 2026-09-05) reliably
  // the one approaching THIS stop, not some other direction's service.
  const NEAR_BUS_RADIUS_METERS = 3000;
  const liveRouteProximity = useMemo(() => {
    // `${stopId}|${routeId}` -> nearest live match, so clicking it can
    // select/fly to that exact vehicle, not just show its distance.
    const nearby = new Map<string, { vehicleId: string; distanceMeters: number }>();
    for (const stop of nearestStops) {
      for (const route of stop.routes) {
        let best: { vehicleId: string; distanceMeters: number } | null = null;
        for (const bus of busDataRef.current.values()) {
          if (bus.routeId !== route.routeId) continue;
          const d = haversineMeters(bus.lat, bus.lon, stop.lat, stop.lon);
          if (!best || d < best.distanceMeters) best = { vehicleId: bus.id, distanceMeters: d };
        }
        if (best && best.distanceMeters <= NEAR_BUS_RADIUS_METERS) {
          nearby.set(`${stop.stopId}|${route.routeId}`, best);
        }
      }
    }
    return nearby;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- busDataRef is a
    // ref; pollTick is the actual trigger for recomputing this each poll.
  }, [nearestStops, pollTick]);

  // "NextBus" side panel (2026-09-05, Ross's ask): clicking a stop opens a
  // dedicated panel next to the stop list showing, per route serving that
  // stop, the single nearest live vehicle on that exact route_id - no
  // distance cap this time (unlike liveRouteProximity above, which only
  // flags a live match within 3km of the stop for the inline indicator).
  // A vehicle still sitting at/near the start of its shape is labelled
  // "at terminus" rather than a stop-distance, since "close to the terminus"
  // isn't a meaningful signal for when it'll actually arrive. A route with no
  // live vehicle at all is silently omitted - never a placeholder row.
  const [nextBusStopId, setNextBusStopId] = useState<string | null>(null);
  const [nextBusRows, setNextBusRows] = useState<NextBusRow[]>([]);
  const TERMINUS_THRESHOLD_METERS = 300;
  // A vehicle already past the stop along its own route isn't "next" for
  // that stop, no matter how physically close it now is (2026-09-07, Ross:
  // "showing the bus that has passed and is continuing on its route" - it
  // was picking nearest by straight-line distance alone, with no concept
  // of before/after). A small tolerance absorbs snapping noise right at
  // the stop itself rather than flickering a vehicle in/out as "passed".
  const PASSED_TOLERANCE_METERS = 50;
  useEffect(() => {
    const stop = nextBusStopId ? nearestStops.find((s) => s.stopId === nextBusStopId) : undefined;
    if (!stop) {
      setNextBusRows([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const rows: NextBusRow[] = [];
      for (const route of stop.routes) {
        // Per-shape, not per-route: two vehicles nominally on "the same
        // route" can be on different shapes (opposite directions/patterns),
        // and the stop's own position along the route only makes sense
        // measured on the specific shape a given candidate is actually on.
        //
        // route_id alone isn't enough to pick candidates, though (2026-09-07,
        // Ross: opposite-side stops on the same route both showed the same
        // direction - e.g. Madigan St opp Hackett Shops showing "to Dickson"
        // when it should show "to National Museum"). A route can run both
        // directions, and a candidate merely being geometrically close to
        // this stop doesn't mean its own trip actually serves it - the two
        // directions' shapes run along nearly the same physical road, just
        // reversed, so a wrong-direction vehicle can still look "not yet
        // passed" against this stop's coordinates snapped onto its shape.
        // Confirming the exact trip_id+stop_id pair has a real scheduled
        // arrival (reusing #2's per-trip schedule data) proves this specific
        // trip genuinely visits this specific stop, not just the same route
        // number in the other direction.
        let best: { bus: BusPosition; shape: ShapePoint[]; distanceAlong: number } | null = null;
        for (const bus of busDataRef.current.values()) {
          if (bus.routeId !== route.routeId) continue;
          const scheduledHere = await getScheduledArrival(bus.tripId, stop.stopId);
          if (scheduledHere == null) continue; // this trip doesn't actually serve this stop - wrong direction
          const shape = await getShapeForTrip(bus.tripId);
          if (!shape) continue;
          const stopHere = snapToShape(shape, stop.lat, stop.lon).distanceAlong;
          const busHere = snapToShape(shape, bus.lat, bus.lon).distanceAlong;
          if (busHere > stopHere + PASSED_TOLERANCE_METERS) continue; // already gone past - not "next" for this stop
          if (!best || busHere > best.distanceAlong) best = { bus, shape, distanceAlong: busHere };
        }
        if (!best) continue; // every vehicle on this route/shape has already passed, or none active - do nothing
        const { bus: nearest, shape } = best;
        const atTerminus = best.distanceAlong <= TERMINUS_THRESHOLD_METERS;
        let directionLabel: string | null = null;
        const origin = shapeOrigin(shape);
        const [originName, headsign] = await Promise.all([
          origin ? getNearestStopName(origin.lat, origin.lon) : Promise.resolve(null),
          getHeadsignForTrip(nearest.tripId),
        ]);
        if (originName && headsign) directionLabel = `${originName} to ${headsign} (${route.routeId})`;
        const currentLocationName = await getNearestStopName(nearest.lat, nearest.lon);
        rows.push({
          routeId: route.routeId,
          vehicleId: nearest.id,
          atTerminus,
          distanceMeters: haversineMeters(nearest.lat, nearest.lon, stop.lat, stop.lon),
          directionLabel,
          currentLocationName,
        });
      }
      if (!cancelled) setNextBusRows(rows);
    })();
    return () => {
      cancelled = true;
    };
    // busDataRef is a ref (no lint complaint about it as a missing dep);
    // pollTick is the actual trigger for recomputing this each poll.
  }, [nextBusStopId, nearestStops, pollTick]);

  // "Near me for this bus" (2026-09-08, Ross): selecting a vehicle while
  // Near Me is active re-anchors the same panel to that bus's own upcoming
  // stops, instead of stops nearest your own location - "if I've clicked
  // near me, and then clicked on a bus... update the near me pane to show
  // the newly selected bus and route as opposed to the nearest to me."
  // Deliberately doesn't touch the vehicle info bar at the bottom (Ross:
  // "don't change the vehicle bar") - this only affects the Near Me panel
  // itself, and only while Near Me is on; selecting a vehicle with Near Me
  // off behaves exactly as before. "Ahead" is measured the same
  // before/after-along-the-shape way as NextBus above (distanceAlong on
  // the vehicle's own live shape), not by schedule time - a late-running
  // bus should still see its real next stop, not whatever the timetable
  // says should be next.
  const [vehicleUpcomingStops, setVehicleUpcomingStops] = useState<
    (TripStop & { distanceAlong: number })[]
  >([]);
  useEffect(() => {
    const bus = selectedId ? busDataRef.current.get(selectedId) : undefined;
    if (!nearMeActive || !bus) {
      setVehicleUpcomingStops([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const progress = vehicleProgressRef.current.get(bus.id);
      const shape = progress ? await getShapeForTrip(bus.tripId) : null;
      if (!progress || !shape) {
        if (!cancelled) setVehicleUpcomingStops([]);
        return;
      }
      const tripStops = await getStopsForTrip(bus.tripId);
      const upcoming = tripStops
        .map((s) => ({ ...s, distanceAlong: snapToShape(shape, s.lat, s.lon).distanceAlong }))
        .filter((s) => s.distanceAlong > progress.distanceAlong + PASSED_TOLERANCE_METERS)
        .sort((a, b) => a.distanceAlong - b.distanceAlong);
      if (!cancelled) setVehicleUpcomingStops(upcoming);
    })();
    return () => {
      cancelled = true;
    };
    // busDataRef/vehicleProgressRef are refs; pollTick is the actual
    // trigger for recomputing this each poll.
  }, [nearMeActive, selectedId, pollTick]);

  // Toggling "Near me" on/off starts/stops the browser's own geolocation
  // watch. watchPosition (not a one-shot getCurrentPosition) so the list and
  // the on-globe marker stay live if you're actually walking around with the
  // demo, matching the "Pulse" real-time framing.
  function toggleNearMe() {
    if (nearMeActive) {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      setNearMeActive(false);
      setUserLocation(null);
      setLocationError(null);
      setNextBusStopId(null);
      hasFlownToUserRef.current = false;
      const viewer = viewerRef.current;
      if (viewer && userEntityRef.current) {
        viewer.entities.remove(userEntityRef.current);
        userEntityRef.current = null;
      }
      return;
    }
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not available in this browser');
      return;
    }
    setFilterType('all'); // avoid two competing side-panels at once
    setNearMeActive(true);
    setLocationError(null);
    void preloadStopArrivals(); // bigger asset than route shapes - fetch only when actually needed
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setLocationError(null);
        setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      (err) => {
        setLocationError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied'
            : 'Could not get your location',
        );
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
  }

  // Draw/update a simple marker for the browser's own location, and fly the
  // camera there once when it's first acquired (not on every update - that
  // would fight anyone panning the globe manually).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !userLocation) return;
    const position = Cartesian3.fromDegrees(userLocation.lon, userLocation.lat);
    if (!userEntityRef.current) {
      userEntityRef.current = viewer.entities.add({
        id: '__user_location',
        position,
        point: {
          pixelSize: 14,
          color: Color.DODGERBLUE,
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      });
    } else {
      userEntityRef.current.position = new ConstantPositionProperty(position);
    }
    if (!hasFlownToUserRef.current) {
      hasFlownToUserRef.current = true;
      void viewer.flyTo(userEntityRef.current, { duration: 1.5 });
    }
  }, [userLocation]);

  // Small markers for the nearest stops themselves, so "Near me" has a
  // visual anchor on the globe, not just a text list. Cheap to fully
  // rebuild on each change since there are at most 4.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const entity of stopEntitiesRef.current) viewer.entities.remove(entity);
    stopEntitiesRef.current = nearestStops.map((stop) =>
      viewer.entities.add({
        id: `__stop_${stop.stopId}`,
        position: Cartesian3.fromDegrees(stop.lon, stop.lat),
        point: {
          pixelSize: 10,
          color: Color.WHITE,
          outlineColor: Color.fromCssColorString('#334155'),
          outlineWidth: 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text: stop.name,
          font: '12px sans-serif',
          pixelOffset: new Cartesian2(0, -16),
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          heightReference: HeightReference.CLAMP_TO_GROUND,
        },
      }),
    );
    return () => {
      for (const entity of stopEntitiesRef.current) viewer.entities.remove(entity);
      stopEntitiesRef.current = [];
    };
  }, [nearestStops]);

  // Stop the geolocation watch if the component unmounts with it running.
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function poll() {
      try {
        const feed = await fetchBuses(controller.signal);
        if (cancelled) return;
        setError(null);
        setNeedsConnect(false);
        let buses = 0;
        let rails = 0;
        for (const bus of feed.buses) {
          if (isLightRail(bus.id)) rails += 1;
          else buses += 1;
        }
        setBusCount(buses);
        setRailCount(rails);
        setPollTick((t) => t + 1);

        const viewer = viewerRef.current;
        if (!viewer) return;
        const seen = new Set<string>();
        for (const bus of feed.buses) {
          seen.add(bus.id);
          busDataRef.current.set(bus.id, bus);
          const sampleTime = JulianDate.fromDate(new Date(bus.ts));

          // A trip_id change means a genuinely different journey (the
          // vehicle finished one trip and started another, often on a
          // different shape entirely - e.g. light rail's outbound vs return
          // shape) - not a continuation of the same route. Cesium's
          // SampledPositionProperty only knows about straight-line Cartesian
          // interpolation/extrapolation between the raw samples it's given;
          // it has no idea two consecutive samples belong to different
          // trips. Left unhandled, the big real-world jump between "end of
          // trip A's shape" and "start of trip B's shape" gets treated as a
          // huge implied velocity, and EXTRAPOLATE (see below) then draws a
          // straight line from that velocity for up to 5 minutes - visually
          // a vehicle flying far off both shapes before the next real fix
          // corrects it. Root-caused 2026-09-05 (Ross: "trains showing 1km
          // off route") - light rail hits this far more than buses since it
          // updates much less often, so there's more real-world distance
          // between "last sample of trip A" and "first sample of trip B".
          // Fix: wipe this vehicle's position/orientation history outright
          // on a trip change, so the new trip starts a clean SampledProperty
          // with nothing to extrapolate from until its own second sample.
          if (lastTripIdRef.current.get(bus.id) !== bus.tripId) {
            positionsRef.current.delete(bus.id);
            orientationsRef.current.delete(bus.id);
            lastSampleTsRef.current.delete(bus.id);
            lastTripIdRef.current.set(bus.id, bus.tripId);
          }

          // Position is a CallbackPositionProperty, not a SampledPositionProperty.
          // Third rewrite of this same problem in one day (2026-09-08) -
          // EXTRAPOLATE flew off the route in a straight Cartesian line
          // ("as the crow flies" - Ross, caught directly from a screenshot);
          // switching to HOLD then froze the vehicle solid for most of each
          // ~8s poll gap, only snapping at the moment a new fix landed
          // ("the movement has stopped completely" - Ross). Both are
          // symptoms of the same underlying mismatch: Cesium's own
          // extrapolation only knows straight-line Cartesian motion or no
          // motion at all - it has no way to keep moving *and* stay
          // constrained to a curved path.
          //
          // Fix: don't use Cesium's extrapolation at all. This callback re-
          // evaluates every render frame (the false 2nd arg means "not
          // constant"), reading the vehicle's live track from
          // vehicleTrackRef - the real distanceAlong from its last actual
          // fix, plus a speed estimate from the *previous* real fix before
          // that (computed below). It projects distance = last distanceAlong
          // + speed * (time elapsed since that fix), capped at
          // COAST_MAX_SECONDS, and asks pointAtDistance for the actual
          // point on the shape at that distance. The vehicle is
          // *mathematically incapable* of leaving the shape - every point
          // it can ever be asked to render for is a real point taken
          // directly from the polyline - while still moving continuously
          // between real fixes, at a speed grounded in what it was actually
          // doing a moment ago rather than a guess. Falls back to the last
          // raw/snapped (lat, lon) directly, no projection, for a trip with
          // no map-matched shape at all - same graceful degradation as
          // every other shape-dependent feature in this file.
          let positionProperty = positionsRef.current.get(bus.id);
          if (!positionProperty) {
            const vehicleId = bus.id; // stable string to close over - `bus` itself is a per-poll local
            positionProperty = new CallbackPositionProperty((time) => {
              const track = vehicleTrackRef.current.get(vehicleId);
              if (!track) {
                const live = busDataRef.current.get(vehicleId);
                return Cartesian3.fromDegrees(live?.lon ?? 0, live?.lat ?? 0);
              }
              if (!track.shape) return Cartesian3.fromDegrees(track.fallbackLon, track.fallbackLat);
              const nowMs = JulianDate.toDate(time ?? JulianDate.now()).getTime();
              const elapsedSec = Math.max(0, Math.min((nowMs - track.atTimeMs) / 1000, COAST_MAX_SECONDS));
              const projected = track.distanceAlong + track.speedMps * elapsedSec;
              const pt = pointAtDistance(track.shape, projected);
              return Cartesian3.fromDegrees(pt.lon, pt.lat);
            }, false);
            positionsRef.current.set(bus.id, positionProperty);
          }

          // Orientation from the feed's own reported bearing, not derived
          // from position motion (VelocityOrientationProperty needs a real
          // rate of change - it doesn't work with a snapped/map-matched
          // position sampled only every ~15s, and defaulted to a fixed
          // heading). Kept on HOLD deliberately, unlike position above:
          // extrapolating a *rotation* for minutes risks visibly spinning
          // if two real bearing readings disagree slightly, whereas a
          // heading that snaps cleanly to each new real reading is safer
          // than one that drifts.
          let sampledOrientation = orientationsRef.current.get(bus.id);
          if (!sampledOrientation) {
            sampledOrientation = new SampledProperty(Quaternion);
            sampledOrientation.forwardExtrapolationType = ExtrapolationType.HOLD;
            sampledOrientation.forwardExtrapolationDuration = 0;
            orientationsRef.current.set(bus.id, sampledOrientation);
          }

          // Only process a sample when the feed's own reported timestamp has
          // actually advanced - a repeat poll of an unchanged fix shouldn't
          // reset the speed estimate the position callback above relies on.
          if (lastSampleTsRef.current.get(bus.id) !== bus.ts) {
            // Captured before either ref below gets overwritten this
            // iteration - this is genuinely the *previous* poll's state,
            // needed to derive a speed between it and the new fix.
            const prevTs = lastSampleTsRef.current.get(bus.id);
            const prevProgress = vehicleProgressRef.current.get(bus.id);

            // Map-match onto the trip's actual route geometry when we have
            // it, so the vehicle sits on the road/track instead of
            // wherever raw GPS noise placed it. Falls back to the raw fix
            // for any trip_id not found in the static snapshot (e.g. a
            // trip pattern that changed since the snapshot was built).
            let lat = bus.lat;
            let lon = bus.lon;
            const shape = await getShapeForTrip(bus.tripId);
            let trackShape: ShapePoint[] | null = null;
            let trackDistanceAlong = 0;
            let trackSpeedMps = 0;
            if (shape) {
              const shapeId = await getShapeIdForTrip(bus.tripId);
              // Anchor the search to where this vehicle was last, when we
              // have a same-shape previous fix to anchor to - see
              // snapToShape's own doc comment for why a pure global-
              // nearest search can snap to the wrong stretch of a curvy
              // road that loops back near itself.
              const nearHint =
                prevProgress && shapeId === prevProgress.shapeId
                  ? prevProgress.distanceAlong
                  : undefined;
              const snapped = snapToShape(shape, bus.lat, bus.lon, nearHint);
              lat = snapped.lat;
              lon = snapped.lon;
              trackShape = shape;
              trackDistanceAlong = snapped.distanceAlong;

              // Real speed from the last two same-shape fixes, feeding the
              // position callback above so it can keep the vehicle moving
              // between polls instead of holding still. Clamped: a GPS/
              // snapping blip shouldn't imply an absurd speed (generous
              // upper bound, comfortably above any real bus/light rail),
              // and a decrease - noise, or the first poll of a new trip
              // where prevProgress's shapeId won't match - just means
              // "don't move yet" (0) rather than going backward.
              if (shapeId && prevProgress && prevProgress.shapeId === shapeId && prevTs != null) {
                const elapsedSec = (bus.ts - prevTs) / 1000;
                const distDelta = snapped.distanceAlong - prevProgress.distanceAlong;
                if (elapsedSec > 0 && distDelta > 0) {
                  trackSpeedMps = Math.min(distDelta / elapsedSec, MAX_EXTRAPOLATION_SPEED_MPS);
                }
              }

              if (shapeId) {
                vehicleProgressRef.current.set(bus.id, {
                  shapeId,
                  distanceAlong: snapped.distanceAlong,
                  routeId: bus.routeId,
                });
              }
            } else {
              vehicleProgressRef.current.delete(bus.id);
            }

            vehicleTrackRef.current.set(bus.id, {
              shape: trackShape,
              distanceAlong: trackDistanceAlong,
              atTimeMs: bus.ts,
              speedMps: trackSpeedMps,
              fallbackLat: lat,
              fallbackLon: lon,
            });

            const position = Cartesian3.fromDegrees(lon, lat);
            const heading = CesiumMath.toRadians(bus.bearing + MODEL_HEADING_OFFSET_DEG);
            const hpr = new HeadingPitchRoll(heading, 0, 0);
            sampledOrientation.addSample(
              sampleTime,
              Transforms.headingPitchRollQuaternion(position, hpr),
            );
            lastSampleTsRef.current.set(bus.id, bus.ts);
          }

          if (!entitiesRef.current.has(bus.id)) {
            const entity = viewer.entities.add({
              id: bus.id,
              position: positionProperty,
              orientation: sampledOrientation,
              name: `Vehicle ${bus.id} (route ${bus.routeId})`,
              // RESOLVED (2026-08-25 night): the "model never renders for
              // light rail" symptom was never about points vs models, or
              // the tram.glb file, at all - it was the position property
              // going undefined between light rail's sparser real updates
              // (see the SampledPositionProperty HOLD fix above). Every
              // earlier "fix" here (points instead of models, extreme
              // height/scale) coincidentally seemed to work or fail based
              // purely on how recently that vehicle had last reported, not
              // on anything about the graphics config itself. Back to a
              // single shared path for both types now that the real cause
              // is fixed.
              model: {
                uri: VEHICLE_MODEL.uri,
                scale: VEHICLE_MODEL.scale,
                minimumPixelSize: 32,
                maximumScale: 20000,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                // Light rail red is Canberra Metro's actual documented line
                // color; no official hex is published for the bus livery
                // (current buses are mostly blue, orange was the old
                // pre-2020 "ACTION" scheme) so that one's an approximation.
                color: isLightRail(bus.id)
                  ? Color.fromCssColorString('#CF1A2B')
                  : Color.ORANGE,
                colorBlendMode: ColorBlendMode.HIGHLIGHT,
              },
            });
            entity.show = routeFilterRef.current
              ? bus.routeId === routeFilterRef.current
              : filterTypeRef.current === 'all' ||
                (filterTypeRef.current === 'rail') === isLightRail(bus.id);
            entitiesRef.current.set(bus.id, entity);
          }
        }
        // Remove entities for vehicles no longer in the active window.
        for (const [id, entity] of entitiesRef.current) {
          if (!seen.has(id)) {
            viewer.entities.remove(entity);
            entitiesRef.current.delete(id);
            busDataRef.current.delete(id);
            positionsRef.current.delete(id);
            orientationsRef.current.delete(id);
            lastSampleTsRef.current.delete(id);
            lastTripIdRef.current.delete(id);
            vehicleProgressRef.current.delete(id);
            vehicleTrackRef.current.delete(id);
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof KustoInteractionRequiredError) {
          setNeedsConnect(true);
        } else {
          setError((err as Error).message);
        }
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  // On-time gauge/histogram helpers - pure functions, no reason for these
  // to live outside render. GAUGE_RANGE_MINUTES is the widest delay this
  // gauge/histogram bother distinguishing - beyond it, "how late" stops
  // being the interesting question.
  const GAUGE_RANGE_MINUTES = 15;
  function clampGaugeMinutes(v: number): number {
    return Math.max(-GAUGE_RANGE_MINUTES, Math.min(GAUGE_RANGE_MINUTES, v));
  }
  // -15..+15 minutes maps to 180..0 degrees (math convention, 0deg = right)
  // - sweeping left-to-right as delay goes early-to-late.
  function gaugeAngleDeg(minutes: number): number {
    return 180 - ((clampGaugeMinutes(minutes) + GAUGE_RANGE_MINUTES) / (2 * GAUGE_RANGE_MINUTES)) * 180;
  }
  function polarPoint(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
  }
  function gaugeArcPath(cx: number, cy: number, r: number, fromMinutes: number, toMinutes: number): string {
    const start = polarPoint(cx, cy, r, gaugeAngleDeg(fromMinutes));
    const end = polarPoint(cx, cy, r, gaugeAngleDeg(toMinutes));
    return `M ${start.x} ${start.y} A ${r} ${r} 0 0 1 ${end.x} ${end.y}`;
  }
  // Fixed-width bins rather than one bar per whole-minute value - readable
  // as a small chart, and matches the same early/on-time/late color coding
  // used everywhere else in this panel (Punctuality label, on-time rows).
  const HISTOGRAM_BINS: { label: string; min: number; max: number; color: string }[] = [
    { label: '<-10', min: -Infinity, max: -10, color: '#2979FF' },
    { label: '-10..-6', min: -10, max: -6, color: '#2979FF' },
    { label: '-6..-2', min: -6, max: -2, color: '#2979FF' },
    { label: '-2..2', min: -2, max: 2, color: '#22c55e' },
    { label: '2..6', min: 2, max: 6, color: '#dc2626' },
    { label: '6..10', min: 6, max: 10, color: '#dc2626' },
    { label: '>10', min: 10, max: Infinity, color: '#dc2626' },
  ];

  return (
    <div className="relative w-full h-screen">
      <div ref={containerRef} className="w-full h-full" />
      <div className="absolute top-4 left-4 bg-white/90 rounded-lg px-2 py-2 text-sm text-gray-700 shadow flex items-center gap-1">
        <button
          onClick={() => {
            if (nearMeActive) toggleNearMe();
            setShowRoutesList(false);
            setRouteFilter(null);
            setShowBunching(false);
            setShowHeatmap(false);
            setShowEquity(false);
            setShowOnTime(false);
            setFilterType((t) => (t === 'bus' ? 'all' : 'bus'));
          }}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
            filterType === 'bus' ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'
          }`}
        >
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: TYPE_COLOR.bus }}
          />
          {busCount} Bus
        </button>
        <button
          onClick={() => {
            if (nearMeActive) toggleNearMe();
            setShowRoutesList(false);
            setRouteFilter(null);
            setShowBunching(false);
            setShowHeatmap(false);
            setShowEquity(false);
            setShowOnTime(false);
            setFilterType((t) => (t === 'rail' ? 'all' : 'rail'));
          }}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
            filterType === 'rail' ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'
          }`}
        >
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: TYPE_COLOR.rail }}
          />
          {railCount} Light rail
        </button>
        <button
          onClick={() => {
            setShowRoutesList(false);
            setRouteFilter(null);
            setShowBunching(false);
            setShowHeatmap(false);
            setShowEquity(false);
            setShowOnTime(false);
            toggleNearMe();
          }}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
            nearMeActive ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'
          }`}
        >
          <span aria-hidden>📍</span>
          Near me
        </button>
        <button
          onClick={() => {
            if (showRoutesList) {
              setShowRoutesList(false);
              setRouteFilter(null);
              return;
            }
            if (nearMeActive) toggleNearMe();
            setShowBunching(false);
            setShowHeatmap(false);
            setShowEquity(false);
            setShowOnTime(false);
            setFilterType('all');
            setShowRoutesList(true);
          }}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
            showRoutesList ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'
          }`}
        >
          <span aria-hidden>🛣️</span>
          Routes
        </button>
        <button
          onClick={() => {
            if (showBunching) {
              setShowBunching(false);
              return;
            }
            if (nearMeActive) toggleNearMe();
            setShowRoutesList(false);
            setRouteFilter(null);
            setShowHeatmap(false);
            setShowEquity(false);
            setShowOnTime(false);
            setFilterType('all');
            setShowBunching(true);
          }}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
            showBunching ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'
          } ${bunchingAlerts.length > 0 && !showBunching ? 'text-amber-600' : ''}`}
        >
          <span aria-hidden>⚠️</span>
          {bunchingAlerts.length > 0 ? `${bunchingAlerts.length} Bunched` : 'Bunching'}
        </button>
        <button
          onClick={() => {
            if (showHeatmap) {
              setShowHeatmap(false);
              return;
            }
            if (nearMeActive) toggleNearMe();
            setShowRoutesList(false);
            setRouteFilter(null);
            setShowBunching(false);
            setShowOnTime(false);
            setFilterType('all');
            setShowHeatmap(true);
          }}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
            showHeatmap ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'
          }`}
        >
          <span aria-hidden>🔥</span>
          {heatmapLoading ? 'Loading…' : 'Heat map'}
        </button>
        <button
          onClick={() => {
            if (showOnTime) {
              setShowOnTime(false);
              return;
            }
            if (nearMeActive) toggleNearMe();
            setShowRoutesList(false);
            setRouteFilter(null);
            setShowBunching(false);
            setShowHeatmap(false);
            setShowEquity(false);
            setFilterType('all');
            setShowOnTime(true);
          }}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
            showOnTime ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'
          }`}
        >
          <span aria-hidden>⏱</span>
          On-time
        </button>
        <button
          onClick={() => {
            if (showEquity) {
              setShowEquity(false);
              return;
            }
            if (nearMeActive) toggleNearMe();
            setShowRoutesList(false);
            setRouteFilter(null);
            setShowBunching(false);
            setShowHeatmap(false);
            setShowOnTime(false);
            setFilterType('all');
            setShowEquity(true);
          }}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
            showEquity ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'
          }`}
        >
          <span aria-hidden>🏘️</span>
          {equityLoading ? 'Loading…' : 'Equity'}
        </button>
      </div>
      {showHeatmap && (
        <div className="absolute top-16 left-4 z-20 bg-white/95 rounded-lg shadow text-xs px-3 py-2 flex flex-col gap-2 w-64">
          <div className="flex items-center gap-2">
            <span className="text-gray-500 shrink-0">Last 24h ping density:</span>
            <span
              className="inline-block flex-1 h-3 rounded"
              style={{ background: 'linear-gradient(to right, #2979FF, #FFF59D, #D32F2F)' }}
            />
          </div>
          <div className="flex justify-between text-gray-400">
            <span>no stop nearby / underutilised</span>
            <span>ultra-high</span>
          </div>
          <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
            <span className="text-gray-500 shrink-0">Sensitivity</span>
            <input
              type="range"
              min={1}
              max={50}
              step={1}
              value={heatmapSensitivity}
              onChange={(e) => setHeatmapSensitivity(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-gray-400 w-8 text-right">{heatmapSensitivity}</span>
          </div>
        </div>
      )}
      {showEquity && (
        <div className="absolute top-16 left-4 z-20 bg-white/95 rounded-lg shadow text-xs px-3 py-2 flex flex-col gap-2 w-72">
          <div className="text-gray-600 font-medium">
            2021 Census population vs. observed service (last 24h)
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500 shrink-0">Per SA1 area, relative to the rest of the ACT:</span>
          </div>
          <div
            className="inline-block h-3 rounded"
            style={{ background: 'linear-gradient(to right, #2979FF, #FFF59D, #8B0000)' }}
          />
          <div className="flex justify-between text-gray-400">
            <span>well served for its population</span>
            <span>densely populated, underserved</span>
          </div>
          <div className="text-gray-400 pt-1 border-t border-gray-100">
            {populationCells.length > 0
              ? `${populationCells.length} SA1 areas · ${populationCells.reduce((n, c) => n + c.population, 0).toLocaleString()} people`
              : 'Loading population data…'}
          </div>
        </div>
      )}
      {/* "Near me for this bus" (2026-09-08): selecting a vehicle while Near
          Me is active re-anchors this same panel to that bus's own upcoming
          stops - see the vehicleUpcomingStops effect above for why. The
          vehicle info bar at the bottom is untouched either way. */}
      {nearMeActive && selectedBus && (
        <div className="absolute top-16 left-4 z-20 w-80 max-h-[70vh] overflow-y-auto bg-white/95 rounded-lg shadow text-sm">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 sticky top-0 bg-white/95">
            <span className="font-medium truncate">
              Route {selectedBus.routeId} · Vehicle {selectedBus.id}
            </span>
            <button
              onClick={() => {
                setSelectedId(null);
                if (viewerRef.current) viewerRef.current.selectedEntity = undefined;
              }}
              className="text-gray-400 hover:text-gray-700 text-xs shrink-0 ml-2 underline decoration-dotted"
            >
              Back to near me
            </button>
          </div>
          {vehicleUpcomingStops.length > 0 && (
            <div className="px-3 py-1.5 border-b border-gray-100 text-[11px] text-gray-400">
              Now: {formatArrivalClock(secondsSinceMidnightNow())} — arrival times below are offsets
              from this
            </div>
          )}
          {vehicleUpcomingStops.length === 0 ? (
            <div className="px-3 py-2 text-gray-400">
              No upcoming stops found for this trip (may not be in today's schedule)
            </div>
          ) : (
            vehicleUpcomingStops.map((stop) => {
              const nowSecs = secondsSinceMidnightNow();
              return (
                <div
                  key={stop.stopId}
                  className="px-3 py-2 border-b border-gray-100 last:border-0 cursor-pointer hover:bg-gray-50"
                  onClick={() => {
                    const viewer = viewerRef.current;
                    if (viewer) {
                      void viewer.camera.flyTo({
                        destination: Cartesian3.fromDegrees(stop.lon, stop.lat, 800),
                        duration: 1.2,
                      });
                    }
                  }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium truncate">{stop.name}</span>
                    <span className="text-gray-500 text-xs shrink-0">
                      {formatArrivalClock(stop.arrivalSeconds)} (+
                      {minutesUntil(stop.arrivalSeconds, nowSecs)}m)
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
      {nearMeActive && !selectedBus && (
        <div className="absolute top-16 left-4 z-20 w-80 max-h-[70vh] overflow-y-auto bg-white/95 rounded-lg shadow text-sm">
          {userLocation && nearestStops.length > 0 && (
            <div className="px-3 py-1.5 border-b border-gray-100 text-[11px] text-gray-400 sticky top-0 bg-white/95">
              Now: {formatArrivalClock(secondsSinceMidnightNow())} — arrival times below are offsets
              from this
            </div>
          )}
          {!userLocation ? (
            <div className="px-3 py-2 text-gray-400">
              {locationError ?? 'Finding your location…'}
            </div>
          ) : nearestStops.length === 0 ? (
            <div className="px-3 py-2 text-gray-400">Loading nearby stops…</div>
          ) : (
            nearestStops.map((stop) => {
              const nowSecs = secondsSinceMidnightNow();
              return (
                <div
                  key={stop.stopId}
                  className={`px-3 py-2 border-b border-gray-100 last:border-0 cursor-pointer hover:bg-gray-50 ${
                    nextBusStopId === stop.stopId ? 'bg-blue-50' : ''
                  }`}
                  onClick={() => {
                    const viewer = viewerRef.current;
                    if (viewer) {
                      void viewer.camera.flyTo({
                        destination: Cartesian3.fromDegrees(stop.lon, stop.lat, 800),
                        duration: 1.2,
                      });
                    }
                    setNextBusStopId(stop.stopId);
                  }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium truncate">{stop.name}</span>
                    <span className="text-gray-400 text-xs shrink-0">
                      {formatDistance(stop.distanceMeters)}
                    </span>
                  </div>
                  {stop.routes.length === 0 ? (
                    <div className="text-gray-400 text-xs mt-1">No scheduled services today</div>
                  ) : (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {stop.routes.map((route) => {
                        const live = liveRouteProximity.get(`${stop.stopId}|${route.routeId}`);
                        return (
                          <div
                            key={route.routeId}
                            className="flex items-center justify-between text-xs gap-2"
                          >
                            <span className="font-medium text-gray-700 shrink-0">
                              Route {route.routeId}
                            </span>
                            {live !== undefined ? (
                              // A live match on this exact route is a click target of its own -
                              // selects and flies to that specific vehicle, not just the stop.
                              // stopPropagation so this doesn't also trigger the stop's own
                              // fly-to-stop click above.
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedId(live.vehicleId);
                                  const entity = entitiesRef.current.get(live.vehicleId);
                                  const viewer = viewerRef.current;
                                  if (entity && viewer) void viewer.flyTo(entity);
                                }}
                                className="text-green-600 hover:text-green-700 font-medium truncate underline decoration-dotted"
                              >
                                🔴 Live · ~{formatDistance(live.distanceMeters)} away
                              </button>
                            ) : (
                              <span className="text-gray-500 truncate">
                                {route.nextArrivalsSeconds
                                  .map(
                                    (t) =>
                                      `${formatArrivalClock(t)} (+${minutesUntil(t, nowSecs)}m)`,
                                  )
                                  .join(', ')}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
      {/* "NextBus" panel - opens next to the stop list when a stop is
          clicked. Silently absent whenever nextBusRows is empty (no live
          vehicle on any route serving that stop) rather than showing an
          empty/placeholder panel - per Ross's "if there is none on route do
          nothing" instruction. */}
      {nearMeActive && nextBusStopId && nextBusRows.length > 0 && (
        <div className="absolute top-16 left-[22rem] z-20 w-64 max-h-[70vh] overflow-y-auto bg-white/95 rounded-lg shadow text-sm">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="font-medium">Next bus</span>
            <button
              onClick={() => setNextBusStopId(null)}
              aria-label="Close"
              className="text-gray-400 hover:text-gray-700 text-lg leading-none"
            >
              &times;
            </button>
          </div>
          {nextBusRows.map((row) => (
            <button
              key={row.routeId}
              onClick={() => {
                setSelectedId(row.vehicleId);
                const entity = entitiesRef.current.get(row.vehicleId);
                const viewer = viewerRef.current;
                if (entity && viewer) void viewer.flyTo(entity);
              }}
              className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-gray-50 border-b border-gray-100 last:border-0"
            >
              <span className="font-medium text-gray-700">
                {row.directionLabel ?? `Route ${row.routeId}`}
              </span>
              <span className="text-xs text-gray-500">
                {row.currentLocationName ? `Near ${row.currentLocationName}` : 'Location unknown'}
                {' · '}
                {row.atTerminus ? (
                  <span className="text-amber-600 font-medium">At terminus</span>
                ) : (
                  <span>~{formatDistance(row.distanceMeters)} from stop</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      {!nearMeActive && filterType !== 'all' && (
        <div className="absolute top-16 left-4 z-20 w-64 max-h-[60vh] overflow-y-auto bg-white/95 rounded-lg shadow text-sm">
          {filteredList.length === 0 ? (
            <div className="px-3 py-2 text-gray-400">No vehicles right now</div>
          ) : (
            filteredList.map((b) => (
              <button
                key={b.id}
                onClick={() => {
                  setSelectedId(b.id);
                  const entity = entitiesRef.current.get(b.id);
                  const viewer = viewerRef.current;
                  if (entity && viewer) void viewer.flyTo(entity);
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-gray-100 border-b border-gray-100 last:border-0"
              >
                <span className="font-medium">{b.id}</span>
                <span className="text-gray-400 text-xs">route {b.routeId}</span>
              </button>
            ))
          )}
        </div>
      )}
      {/* #12 route navigator (2026-09-05): every route currently in the live
          feed, clickable to isolate just that route's vehicles on the map.
          Kept as a plain scrollable list rather than inline buttons like
          Bus/Rail - there can be dozens of routes, unlike two vehicle types,
          so this needed a different visual treatment. */}
      {showRoutesList && (
        <div className="absolute top-16 left-4 z-20 w-56 max-h-[70vh] overflow-y-auto bg-white/95 rounded-lg shadow text-sm">
          {routeFilter && (
            <button
              onClick={() => setRouteFilter(null)}
              className="w-full px-3 py-2 text-left text-gray-500 hover:bg-gray-100 border-b border-gray-100"
            >
              &larr; Show all routes
            </button>
          )}
          {allRoutes.length === 0 ? (
            <div className="px-3 py-2 text-gray-400">No routes active right now</div>
          ) : (
            allRoutes.map((routeId) => (
              <button
                key={routeId}
                onClick={() => setRouteFilter(routeId)}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-gray-100 border-b border-gray-100 last:border-0 ${
                  routeFilter === routeId ? 'bg-gray-900 text-white hover:bg-gray-900' : ''
                }`}
              >
                <span className="font-medium">Route {routeId}</span>
              </button>
            ))
          )}
        </div>
      )}
      {/* #3 bus bunching (2026-09-05): vehicles on the exact same shape
          (route + direction) closer together than BUNCHING_THRESHOLD_METERS.
          Real headway only for now - no comparison against scheduled
          headway yet, see the comment on bunchingAlerts above. */}
      {showBunching && (
        <div className="absolute top-16 left-4 z-20 w-64 max-h-[70vh] overflow-y-auto bg-white/95 rounded-lg shadow text-sm">
          {bunchingAlerts.length === 0 ? (
            <div className="px-3 py-2 text-gray-400">No bunching detected right now</div>
          ) : (
            bunchingAlerts.map((alert) => (
              <button
                key={`${alert.vehicleA}-${alert.vehicleB}`}
                onClick={() => {
                  const viewer = viewerRef.current;
                  if (!viewer) return;
                  const entities = [alert.vehicleA, alert.vehicleB]
                    .map((id) => entitiesRef.current.get(id))
                    .filter((e): e is Entity => !!e);
                  if (entities.length > 0) void viewer.flyTo(entities);
                }}
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50 border-b border-gray-100 last:border-0"
              >
                <span className="font-medium text-gray-700">
                  Route {alert.routeId}: {alert.vehicleA} &amp; {alert.vehicleB}
                </span>
                <span className="text-xs text-amber-600 font-medium shrink-0">
                  {formatDistance(alert.gapMeters)} apart
                </span>
              </button>
            ))
          )}
        </div>
      )}
      {/* #2 on-time performance (2026-09-06): every currently STOPPED_AT
          vehicle with a resolvable schedule match. Empty until stop_id
          starts landing on live rows - see PROJECT_STATUS.md for the
          pipeline-side status of that. */}
      {showOnTime && (
        <div className="absolute top-16 left-4 z-20 w-72 max-h-[70vh] overflow-y-auto bg-white/95 rounded-lg shadow text-sm">
          {onTimeSummary && (
            <div className="px-3 py-2 border-b border-gray-100 sticky top-0 bg-white/95">
              <div className="flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-wide text-gray-400">
                  Network median (n={onTimeSummary.n})
                </div>
                <button
                  onClick={() => setShowOnTimeViz((v) => !v)}
                  title="Gauge, trend, and distribution"
                  className={`text-xs rounded px-1.5 py-0.5 shrink-0 ${
                    showOnTimeViz ? 'bg-gray-900 text-white' : 'text-gray-400 hover:bg-gray-100'
                  }`}
                >
                  📊
                </button>
              </div>
              <div className="flex items-baseline justify-between">
                <span
                  className={`text-lg font-semibold ${
                    Math.abs(onTimeSummary.median) < 2
                      ? 'text-green-600'
                      : onTimeSummary.median > 0
                        ? 'text-red-600'
                        : 'text-blue-600'
                  }`}
                >
                  {onTimeSummary.median > 0 ? '+' : ''}
                  {onTimeSummary.median}m
                </span>
                <span className="text-xs text-gray-400">
                  range {onTimeSummary.min > 0 ? '+' : ''}
                  {onTimeSummary.min}m to {onTimeSummary.max > 0 ? '+' : ''}
                  {onTimeSummary.max}m
                </span>
              </div>
            </div>
          )}
          {onTimeEntries.length === 0 ? (
            <div className="px-3 py-2 text-gray-400">
              No stopped vehicles with a schedule match right now
            </div>
          ) : (
            onTimeEntries.map((entry) => (
              <button
                key={entry.vehicleId}
                onClick={() => {
                  setSelectedId(entry.vehicleId);
                  const entity = entitiesRef.current.get(entry.vehicleId);
                  const viewer = viewerRef.current;
                  if (entity && viewer) void viewer.flyTo(entity);
                }}
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50 border-b border-gray-100 last:border-0"
              >
                <span className="font-medium text-gray-700">
                  Route {entry.routeId}: {entry.vehicleId}
                </span>
                <span
                  className={`text-xs font-medium shrink-0 ${
                    Math.abs(entry.punctuality.delayMinutes) < 2
                      ? 'text-green-600'
                      : entry.punctuality.delayMinutes > 0
                        ? 'text-red-600'
                        : 'text-blue-600'
                  }`}
                >
                  {entry.punctuality.label}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      {/* On-time gauge/histogram/trend pop-out (2026-09-08, Ross's ask) -
          a separate panel on the right, doesn't touch the on-time block on
          the left at all. Trend is *this session only* (see
          medianHistory's own doc comment) - durable multi-day history
          needs the delay-at-ingestion pipeline still in progress. */}
      {showOnTime && showOnTimeViz && onTimeSummary && (
        <div className="absolute top-16 right-4 z-20 w-72 bg-white/95 rounded-lg shadow text-xs px-3 py-3 flex flex-col gap-4">
          <div>
            <div className="text-gray-500 font-medium mb-1">Network median, live</div>
            <svg viewBox="0 0 200 115" className="w-full">
              <path d={gaugeArcPath(100, 100, 80, -GAUGE_RANGE_MINUTES, -2)} stroke="#2979FF" strokeWidth={14} fill="none" />
              <path d={gaugeArcPath(100, 100, 80, -2, 2)} stroke="#22c55e" strokeWidth={14} fill="none" />
              <path d={gaugeArcPath(100, 100, 80, 2, GAUGE_RANGE_MINUTES)} stroke="#dc2626" strokeWidth={14} fill="none" />
              {(() => {
                const tip = polarPoint(100, 100, 68, gaugeAngleDeg(onTimeSummary.median));
                return (
                  <line x1={100} y1={100} x2={tip.x} y2={tip.y} stroke="#111827" strokeWidth={3} strokeLinecap="round" />
                );
              })()}
              <circle cx={100} cy={100} r={5} fill="#111827" />
              <text x={20} y={112} fontSize={9} fill="#9ca3af">
                early
              </text>
              <text x={165} y={112} fontSize={9} fill="#9ca3af">
                late
              </text>
            </svg>
          </div>
          <div>
            <div className="text-gray-500 font-medium mb-1">
              Median trend, this session ({medianHistory.length} polls)
            </div>
            {medianHistory.length < 2 ? (
              <div className="text-gray-400">Collecting more polls…</div>
            ) : (
              <svg viewBox="0 0 260 60" className="w-full">
                <line x1={0} y1={30} x2={260} y2={30} stroke="#e5e7eb" strokeWidth={1} />
                <polyline
                  fill="none"
                  stroke="#111827"
                  strokeWidth={2}
                  points={medianHistory
                    .map((p, i) => {
                      const x = (i / (medianHistory.length - 1)) * 260;
                      const y = 30 - (clampGaugeMinutes(p.median) / GAUGE_RANGE_MINUTES) * 28;
                      return `${x},${y}`;
                    })
                    .join(' ')}
                />
              </svg>
            )}
          </div>
          <div>
            <div className="text-gray-500 font-medium mb-1">
              Distribution right now (n={onTimeEntries.length})
            </div>
            <svg viewBox="0 0 260 70" className="w-full">
              {(() => {
                const counts = HISTOGRAM_BINS.map(
                  (bin) =>
                    onTimeEntries.filter(
                      (e) => e.punctuality.delayMinutes >= bin.min && e.punctuality.delayMinutes < bin.max,
                    ).length,
                );
                const maxCount = Math.max(1, ...counts);
                const barWidth = 260 / HISTOGRAM_BINS.length;
                return HISTOGRAM_BINS.map((bin, i) => {
                  const h = (counts[i] / maxCount) * 50;
                  return (
                    <g key={bin.label}>
                      <rect
                        x={i * barWidth + 2}
                        y={55 - h}
                        width={barWidth - 4}
                        height={h}
                        fill={bin.color}
                        opacity={0.85}
                      />
                      <text x={i * barWidth + barWidth / 2} y={67} fontSize={7} fill="#9ca3af" textAnchor="middle">
                        {bin.label}
                      </text>
                    </g>
                  );
                });
              })()}
            </svg>
          </div>
        </div>
      )}
      {selectedBus && (
        <VehiclePanel
          bus={selectedBus}
          onClose={() => {
            setSelectedId(null);
            if (viewerRef.current) viewerRef.current.selectedEntity = undefined;
          }}
        />
      )}
      {/* Deliberately a hard-to-miss modal, not a small corner button - a small
          button here is how the 2026-09 "0 vehicles, no error" saga happened:
          signing into the app itself (Rayfin auth) is a separate step from
          authorizing this specific Kusto/Eventhouse client, and the small
          version of this prompt went unnoticed for days while everyone
          assumed the *data* was broken. Make the state itself undeniable. */}
      {needsConnect && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm text-center">
            <div className="text-3xl mb-2">🔌</div>
            <h2 className="font-bold text-lg mb-1 text-gray-900">Live data not connected</h2>
            <p className="text-sm text-gray-500 mb-4">
              One extra sign-in step is needed to read live vehicle positions - separate from
              signing into this app.
            </p>
            <button
              onClick={() => void connectDataInteractive()}
              className="bg-gray-900 hover:bg-gray-800 transition-colors text-white rounded-lg px-6 py-3 font-medium w-full"
            >
              Connect live data
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute bottom-4 left-4 bg-red-50 text-red-700 rounded-lg px-4 py-2 text-sm">
          {error}
        </div>
      )}
      <div className="absolute bottom-2 right-3 text-[11px] text-white/50">
        3D model: "Bus low poly simple GLB" by Chelebonchik Games (CC-BY 4.0)
      </div>
    </div>
  );
}
