import {
  CallbackPositionProperty,
  CallbackProperty,
  CameraEventType,
  Cartesian2,
  Cartesian3,
  Color,
  ColorBlendMode,
  ConstantPositionProperty,
  createGooglePhotorealistic3DTileset,
  createOsmBuildingsAsync,
  HeadingPitchRoll,
  HeightReference,
  ImageryLayer,
  Ion,
  JulianDate,
  KeyboardEventModifier,
  LabelStyle,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  Rectangle,
  Terrain,
  Transforms,
  Viewer,
  type Entity,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  type BusPosition,
  fetchBuses,
  fetchHeatmapGrid,
  HEATMAP_GRID_DEGREES,
  type HeatmapCell,
} from '@/services/busService';
import { resumePendingTriggerIfAny, triggerDataLoaders } from '@/services/fabricJobsService';
import { connectDataInteractive, KustoInteractionRequiredError } from '@/services/kustoClient';
import { getPopulationCells, preloadPopulation, type PopulationCell } from '@/services/populationService';
import {
  bearingAtDistance,
  getHeadsignForTrip,
  getShapeById,
  getShapeForTrip,
  getShapeIdForTrip,
  haversineMeters,
  nearestPointOnAnyShape,
  pointAtDistance,
  preloadShapes,
  shapeOrigin,
  type ShapePoint,
  snapToShape,
} from '@/services/shapeService';
import {
  computePunctuality,
  formatArrivalClock,
  getAllRouteIds,
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
import {
  fetchLiveLinkStats,
  getTrafficLinks,
  preloadTrafficLinks,
  type TrafficLink,
  type TrafficLinkLiveStats,
} from '@/services/trafficService';
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
// Was 30s, tuned for the live app's original ~15-30s live-poll cadence.
// ACTBusEventLoader has run on a 5-minute Fabric schedule since the
// historic-capture setup, though - confirmed directly against live data
// (2026-09-28): median real gap between two fixes for the same in-transit
// vehicle is 300s, both bus and rail. At 30s a vehicle coasted for the
// first 10% of that gap, then sat frozen for the remaining ~4.5 minutes -
// the actual cause of "not seeing vehicles move" (Ross), not a rendering
// bug. Raised to just under the measured real gap so vehicles keep
// gliding for nearly the whole interval instead of freezing early; a
// vehicle whose next fix is late or missing still just holds in place,
// same safe fallback as before.
const COAST_MAX_SECONDS = 280;

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
  lat: number;
  lon: number;
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
            <div className="font-display text-[11px] uppercase tracking-wide text-white/40">{label}</div>
            <div className="text-sm">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Permanent headline counter (2026-09-09, Ross's ask: "make the headline
 * figures permanent counters") - always visible in the top strip regardless
 * of which tab is open, unlike the more detailed per-tab headline cards
 * further down in the detail pane. Clicking one opens that tab, same as
 * clicking its nav rail entry.
 */
function CounterCard({
  icon,
  label,
  value,
  sub,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-start gap-0.5 px-4 py-2 text-left min-w-[150px] shrink-0 rounded-[5px] border transition-colors ${
        active ? 'bg-sky-500/20 border-sky-500/40' : 'bg-white/5 border-white/10 hover:bg-white/10'
      }`}
    >
      <div className="font-display flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-white/40">
        <span aria-hidden>{icon}</span>
        {label}
      </div>
      <div className="font-display text-xl font-semibold text-white">{value}</div>
      {sub && <div className="text-[11px] text-white/40 truncate w-full">{sub}</div>}
    </button>
  );
}

export function CesiumView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const entitiesRef = useRef<Map<string, Entity>>(new Map());
  const positionsRef = useRef<Map<string, CallbackPositionProperty>>(new Map());
  const orientationsRef = useRef<Map<string, CallbackProperty>>(new Map());
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
    // Explicit safeguard (2026-09-09, Ross reported Ctrl+left-drag tilt had
    // stopped working) - nothing else in this file ever touches the camera
    // controller, so this should already be Cesium's stock default. Setting
    // it outright rather than leaving it implicit at least rules out any
    // future change silently drifting away from it. Cesium's input system
    // only recognises Ctrl/Shift/Alt as modifiers - Cmd/Meta was never
    // wired to anything, which may explain why trying it felt broken.
    // The on-screen Tilt buttons below are the real fix: they work
    // regardless of modifier keys, OS trackpad settings, or browser quirks.
    //
    // Ctrl+right-drag was briefly added here too "since it costs nothing" -
    // it wasn't free. Cesium's own *default* lookEventTypes already binds
    // Ctrl+right-drag to a completely different camera action ("look":
    // rotate in place around the camera's own position, vs. tilt's orbit
    // around a fixed ground point). Registering the same input combination
    // against two different actions is exactly the kind of thing that can
    // make camera controls feel randomly broken - only one of the two ever
    // wins, and not necessarily consistently. Left out entirely now;
    // Ctrl+left-drag alone matches Cesium's real stock default with no
    // collision against anything else it also binds by default.
    viewer.scene.screenSpaceCameraController.tiltEventTypes = [
      CameraEventType.MIDDLE_DRAG,
      CameraEventType.PINCH,
      { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
    ];
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
    // Route-line entities (2026-09-08, Ross's ask: "click on one by
    // location... rather than just the drop-down list") are tagged with a
    // `routeline:` id prefix specifically so this same listener can tell
    // them apart from a vehicle click and route it to setRouteFilter
    // instead of treating it as a vehicle selection.
    viewer.selectedEntityChanged.addEventListener((entity) => {
      const id = entity ? String(entity.id) : null;
      if (id?.startsWith('routeline:')) {
        const routeId = id.split(':')[1];
        if (routeId) setRouteFilter(routeId);
        viewer.selectedEntity = undefined; // don't leave the line itself "selected"
        return;
      }
      setSelectedId(id);
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
  // Drill-down from the Trends page (2026-09-28, Ross's ask: "click a route
  // on a chart, drill to that route on the map"). TrendsPage navigates here
  // with ?route= or ?mode= rather than sharing React state directly - it's
  // a different page, mounted fresh, so a URL param is the only channel
  // that survives the navigation. Consumed once on mount, then stripped
  // from the URL so it doesn't re-fire on a later re-render or back/forward.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const route = searchParams.get('route');
    const mode = searchParams.get('mode');
    const congestion = searchParams.get('congestion');
    if (!route && !mode && !congestion) return;
    if (route) {
      setShowRoutesList(true);
      setRouteFilter(route);
    } else if (mode === 'bus' || mode === 'rail') {
      setFilterType(mode);
    } else if (congestion) {
      setShowCongestion(true);
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // Road congestion overlay (2026-09-08, Ross's find: ACT's public
  // Addinsight Bluetooth-detector traffic API - real per-road-segment
  // speed/delay/congestion, refreshed roughly every 1-5 minutes). Same
  // split as the population overlay: static road geometry loaded once,
  // live stats (from the ACTTrafficLoader notebook, via Kusto) refreshed
  // like any other live layer.
  const [showCongestion, setShowCongestion] = useState(false);
  const [trafficLinks, setTrafficLinks] = useState<TrafficLink[]>([]);
  const [linkStats, setLinkStats] = useState<Map<number, TrafficLinkLiveStats>>(new Map());
  const [congestionLoading, setCongestionLoading] = useState(false);
  const congestionEntitiesRef = useRef<Entity[]>([]);
  // Every route_id that exists in the static schedule, live or not
  // (2026-09-09, Ross's ask: "routes split to active and non active, still
  // shown but greyed out") - see allRouteRows below for where this is
  // merged with live counts. Fetched at startup, same as
  // population/traffic above, even though stop-arrivals.json is the
  // biggest of the three static snapshots (~1.5MB gzipped) - it's already
  // needed for Near Me, and the permanent "Active routes" counter now
  // wants the full picture from the first poll too, not just once Near Me
  // or Routes has been opened.
  const [allStaticRouteIds, setAllStaticRouteIds] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void preloadStopArrivals()
      .then(() => getAllRouteIds())
      .then((ids) => {
        if (!cancelled) setAllStaticRouteIds(ids);
      });
    return () => {
      cancelled = true;
    };
  }, []);
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
  // Default was briefly 25 ("halfway across the 1-50 slider", 2026-09-08) -
  // reverted the same day once that actually rendered live: the curve
  // (raw^(1/sensitivity)) is extremely front-loaded, so 25 pushes *any*
  // cell with as little as 5% of reference traffic to ~0.89 intensity,
  // already near-maximum red. Since only road/route cells ever have
  // nonzero traffic at all, the whole map degenerated into "red exactly on
  // roads, nothing off them" - no real gradient left between a lightly-
  // used stretch and a genuinely busy one (Ross: "traces of red only
  // around arterial roads"). "Halfway on the slider" isn't halfway in
  // perceived effect on this curve - confirmed numerically before picking
  // 4 instead: raw 0.1 -> 0.1 at s=1, 0.56 at s=4, 0.91 at s=25 - 4 still
  // gives a real boost while keeping a visible spread across the range,
  // whereas anything much above ~5-10 starts flattening toward the same
  // "any traffic = hot" degenerate case. Slider still goes to 50 for
  // anyone who deliberately wants that binary-looking view.
  const [heatmapSensitivity, setHeatmapSensitivity] = useState(4);
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
    // Categorical breakdown (2026-09-09) - same "within 2 minutes = on time"
    // threshold already used for each row's own colour, rolled up network-wide.
    const onTimeCount = sorted.filter((d) => Math.abs(d) < 2).length;
    const lateCount = sorted.filter((d) => d >= 2).length;
    const earlyCount = sorted.filter((d) => d <= -2).length;
    return { median, min: sorted[0], max: sorted[sorted.length - 1], n: sorted.length, onTimeCount, lateCount, earlyCount };
  }, [onTimeEntries]);
  // On-time gauge/histogram pop-out (2026-09-08, Ross's ask - auto-shown
  // alongside the network median as of the same day, not gated behind a
  // separate button anymore) - a separate panel, doesn't touch the
  // existing on-time block above at all. Only a *this-session* trend, not
  // real history - see the median-tracking notebook work still in
  // progress for durable multi-day tracking; this rolling buffer resets
  // whenever the on-time panel closes, deliberately, so a reopened panel
  // never shows a stale/discontinuous graph.
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

  // Right-side headline + ranked breakdown for Routes (2026-09-08, Ross's
  // ask - every panel gets an overall figure plus granular details, same
  // pattern as congestion/equity/heat map). The existing left-side picker
  // is untouched - it's a functional control (pick one route to filter
  // the map to), this is a separate informational "what's busiest" view.
  const routeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const bus of busDataRef.current.values()) {
      counts.set(bus.routeId, (counts.get(bus.routeId) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([routeId, count]) => ({ routeId, count }))
      .sort((a, b) => b.count - a.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- busDataRef is a
    // ref; pollTick is the actual trigger for recomputing this each poll.
  }, [pollTick]);

  // Live data stream bubble (2026-09-28, Ross's ask: "nice to see the data
  // coming in") - the most recently-updated vehicles, most recent first.
  // Genuinely reads busDataRef's own ts per vehicle rather than "just
  // fetched this poll", since the underlying feed lands on its own 5-minute
  // schedule (see COAST_MAX_SECONDS) - a vehicle can be the most recent
  // arrival even a few minutes into this app's own 8s poll cycle.
  const LIVE_FEED_SIZE = 8;
  const liveFeed = useMemo(() => {
    return Array.from(busDataRef.current.values())
      .sort((a, b) => b.ts - a.ts)
      .slice(0, LIVE_FEED_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- busDataRef is a
    // ref; pollTick is the actual trigger for recomputing this each poll.
  }, [pollTick]);
  function formatFeedAge(ms: number): string {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s ago`;
    return `${Math.round(sec / 60)}m ago`;
  }

  // Full route list, live counts merged in (2026-09-09, Ross's ask: "routes
  // split to active and non active, still shown but greyed out") - routeCounts
  // above only ever knew about routes with a vehicle on them right now; this
  // adds every route that exists in the static schedule at all, with count 0
  // for ones with nothing live. Kept separate from routeCounts rather than
  // changing it in place - the "Active routes" counter and "busiest route"
  // references elsewhere genuinely mean "has a live vehicle", not "exists".
  const allRouteRows = useMemo(() => {
    const counts = new Map(routeCounts.map((r) => [r.routeId, r.count]));
    const ids = new Set([...allStaticRouteIds, ...counts.keys()]);
    return Array.from(ids)
      .map((routeId) => ({ routeId, count: counts.get(routeId) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.routeId.localeCompare(b.routeId, undefined, { numeric: true }));
  }, [allStaticRouteIds, routeCounts]);

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
  // Headline figure (2026-09-09, matching every other panel's lead-with-a-
  // number treatment). bunchingAlerts is already sorted tightest-gap-first.
  const bunchingHeadline = useMemo(() => {
    if (bunchingAlerts.length === 0) return null;
    const affectedRoutes = new Set(bunchingAlerts.map((a) => a.routeId));
    const avgGapMeters = bunchingAlerts.reduce((sum, a) => sum + a.gapMeters, 0) / bunchingAlerts.length;
    return {
      affectedRouteCount: affectedRoutes.size,
      worstRouteId: bunchingAlerts[0].routeId,
      worstGapMeters: bunchingAlerts[0].gapMeters,
      avgGapMeters,
    };
  }, [bunchingAlerts]);

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
    // Always fetched now (2026-09-09) - the permanent headline counter strip
    // needs this regardless of which tab is open, not just heat map/equity.
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
  }, []);

  // Population doesn't change between Census years - fetch once, at
  // startup (2026-09-09: was lazy on showEquity, widened for the permanent
  // headline counter strip - equity's counters need this regardless of
  // which tab is open).
  useEffect(() => {
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
  }, []);

  // Road geometry doesn't change often - fetch once, at startup (2026-09-09:
  // was lazy on showCongestion/showOnTime, widened for the permanent
  // headline counter strip - same reasoning as population above).
  useEffect(() => {
    let cancelled = false;
    void preloadTrafficLinks()
      .then(() => getTrafficLinks())
      .then((links) => {
        if (!cancelled) setTrafficLinks(links);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live stats refresh every poll, same cadence as the rest of the live app
  // (2026-09-09: was gated on showCongestion/showOnTime, widened so the
  // permanent congestion counter stays live regardless of which tab is
  // open) - unlike the heat map's 24h-history query, this is a genuinely
  // live layer (stats go stale within a few minutes).
  useEffect(() => {
    let cancelled = false;
    setCongestionLoading(true);
    const controller = new AbortController();
    void fetchLiveLinkStats(controller.signal)
      .then((stats) => {
        if (!cancelled) setLinkStats(stats);
      })
      .finally(() => {
        if (!cancelled) setCongestionLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [pollTick]);

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

  // Shared by the polygon-rendering effect below and the ranked list panel
  // (2026-09-08, Ross's ask: "a list of the areas... densely populated,
  // underserved, and vice versa") - computed once, not duplicated. gap is
  // the percentile-rank difference (-1..1): positive means "more densely
  // populated than average, relative to how little service reaches it".
  const equityRanking = useMemo(() => {
    if (populationCells.length === 0) return [];
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
    return populationCells.map((cell, i) => ({
      cell,
      densityPerSqKm: densities[i],
      gap: densityRanks[i] - heatRanks[i],
    }));
  }, [populationCells, heatmapCells]);

  // Top/bottom of the same ranking, for the right-hand list panel
  // (2026-09-08, Ross's ask). Ties (several SA1s in the same suburb with
  // an identical gap, e.g. all-zero-service areas) aren't specially
  // broken - stable sort keeps them in a consistent order.
  const EQUITY_LIST_SIZE = 8;
  const equityLists = useMemo(() => {
    if (equityRanking.length === 0) return { underserved: [], wellServed: [] };
    const sorted = [...equityRanking].sort((a, b) => b.gap - a.gap);
    return {
      underserved: sorted.slice(0, EQUITY_LIST_SIZE),
      wellServed: sorted.slice(-EQUITY_LIST_SIZE).reverse(),
    };
  }, [equityRanking]);

  // Headline figure (2026-09-08, Ross's ask - every panel leads with an
  // overall number). "Underserved" here means a positive gap at all, not
  // just the worst few in the list below - a genuine network-wide count.
  const equityHeadline = useMemo(() => {
    if (equityRanking.length === 0) return null;
    const sorted = [...equityRanking].sort((a, b) => b.gap - a.gap);
    const worst = sorted[0];
    const best = sorted[sorted.length - 1];
    const underservedCount = equityRanking.filter((r) => r.gap > 0).length;
    const wellServedCount = equityRanking.filter((r) => r.gap < 0).length;
    return {
      worstAreaName: worst.cell.areaName,
      bestAreaName: best.cell.areaName,
      underservedCount,
      wellServedCount,
      totalAreas: equityRanking.length,
    };
  }, [equityRanking]);

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
    // Missing this guard (unlike the congestion/heatmap effects, which both
    // check their own showX) meant every SA1 in the ACT painted itself the
    // moment population data loaded - which now happens unconditionally at
    // startup to feed the permanent "Underserved areas" counter - regardless
    // of whether Availability was ever opened. Confirmed directly (2026-09-
    // 28, Ross): this is the "heat map" that confusingly renders on first
    // load with nothing selected.
    if (!showEquity || equityRanking.length === 0) return;

    equityEntitiesRef.current = equityRanking.map(({ cell, gap }) => {
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
  }, [showEquity, equityRanking]);

  // Yellow -> orange -> red, deliberately no green (2026-09-08, Ross:
  // "it needs to be all yellow/orange/red scale... showing a little too
  // much green"). Real data confirmed the reason: 719 of 725 links sit at
  // score 0 right now (free-flowing is the overwhelmingly common case,
  // congestion scores only kick in for genuinely bad conditions per
  // link_scores.json's thresholds), so a green-at-zero scale meant nearly
  // the entire network read as flat green - technically correct, but not
  // an interesting picture. Starting at yellow instead means score 0 is
  // still visually distinct from actual congestion (which pushes toward
  // orange/red), without a color that all but a handful of segments will
  // ever show.
  function congestionColor(score: number, referenceMax: number): Color {
    const t = Math.max(0, Math.min(1, score / referenceMax));
    if (t <= 0.5) {
      return Color.lerp(
        Color.fromCssColorString('#eab308'),
        Color.fromCssColorString('#f97316'),
        t * 2,
        new Color(),
      );
    }
    return Color.lerp(
      Color.fromCssColorString('#f97316'),
      Color.fromCssColorString('#dc2626'),
      (t - 0.5) * 2,
      new Color(),
    );
  }

  // Only links with a current live reading get drawn or ranked - a link
  // the loader hasn't reported on yet (or before ACTTrafficLoader has ever
  // run) is left out entirely rather than shown as a misleading "0
  // congestion" default, same "say nothing rather than guess" convention
  // as the heat map's blank-vs-blue distinction.
  const congestionRanking = useMemo(() => {
    if (trafficLinks.length === 0) return [];
    const withStats: { link: TrafficLink; stats: TrafficLinkLiveStats }[] = [];
    for (const link of trafficLinks) {
      const stats = linkStats.get(link.linkId);
      if (stats) withStats.push({ link, stats });
    }
    return withStats;
  }, [trafficLinks, linkStats]);

  // Scale color against what's actually happening right now, not the
  // theoretical 0-7 range (2026-09-08, Ross: "the worst parts are severe,
  // whereas free-flowing is probably... a zero or a one... adjust the
  // threshold"). Same lesson as the heat map's own percentile fix: real
  // traffic almost never uses the full range in either direction - free-
  // flowing conditions rarely score above 1, and even genuinely bad
  // congestion may not literally hit 7 very often. Scaling against a fixed
  // 7 meant a real "this road is a mess" reading of 3-4 only reached the
  // middle of the color range - not visually severe enough. Scaling
  // against the 90th percentile of currently non-zero scores (same
  // technique, not just the same idea, as the heat map's referenceMax)
  // means whatever the worst *currently observed* congestion actually is
  // reads as genuinely deep red, while the common near-zero majority stays
  // correctly muted near yellow.
  const congestionReferenceMax = useMemo(() => {
    const nonZero = congestionRanking
      .map((r) => r.stats.score)
      .filter((s) => s > 0)
      .sort((a, b) => a - b);
    if (nonZero.length === 0) return 1;
    return Math.max(1, nonZero[Math.floor(nonZero.length * 0.9)]);
  }, [congestionRanking]);

  const CONGESTION_LIST_SIZE = 8;
  const congestionLists = useMemo(() => {
    if (congestionRanking.length === 0) return { mostCongested: [], closed: [] };
    const sorted = [...congestionRanking].sort((a, b) => b.stats.score - a.stats.score);
    return {
      mostCongested: sorted.filter((r) => !r.stats.closed).slice(0, CONGESTION_LIST_SIZE),
      closed: sorted.filter((r) => r.stats.closed),
    };
  }, [congestionRanking]);

  // Headline figure (2026-09-08, Ross's ask - every panel leads with an
  // overall number). "Congested" here means score >= 2 (link_scores.json's
  // own lowest defined threshold), not just >0 - score 1 is still
  // essentially normal traffic noise.
  const congestionHeadline = useMemo(() => {
    if (congestionRanking.length === 0) return null;
    const avgScore = congestionRanking.reduce((sum, r) => sum + r.stats.score, 0) / congestionRanking.length;
    const congestedCount = congestionRanking.filter((r) => r.stats.score >= 2 && !r.stats.closed).length;
    return {
      avgScore,
      congestedCount,
      reporting: congestionRanking.length,
      closedCount: congestionLists.closed.length,
      worstLinkName: congestionLists.mostCongested[0]?.link.name ?? null,
    };
  }, [congestionRanking, congestionLists.closed.length, congestionLists.mostCongested]);

  // "Use the congestion to measure latency of busses" (2026-09-08, Ross's
  // ask) - the actual correlation: for each currently-late/early/on-time
  // vehicle, find the nearest road segment with a live reading and show
  // its congestion score alongside the punctuality figure. Nearest-vertex
  // search (not full segment projection like snapToShape) - road segment
  // polylines are dense enough in practice that the difference is a few
  // metres, not worth the extra complexity for a categorical "is the
  // nearby road congested" signal rather than a precise measurement.
  // Ideas for taking this further, not yet built: (1) aggregate congestion
  // along a vehicle's *whole remaining route* rather than just its current
  // position, so "5 min late" can be explained by "the road ahead is
  // congested" specifically, not just "somewhere nearby is"; (2) a
  // network-wide congestion stat correlated against the on-time median
  // over time, to distinguish "the whole network is running behind today"
  // from "this one route has its own problem"; (3) flag routes whose
  // shapes cross the same congested links repeatedly as structurally
  // exposed to traffic, a genuine "should this route get bus priority
  // lanes" signal for the chief-minister framing.
  const CONGESTION_NEARBY_RADIUS_METERS = 250;
  function nearestCongestionLink(
    lat: number,
    lon: number,
  ): { link: TrafficLink; stats: TrafficLinkLiveStats; distanceMeters: number } | null {
    let best: { link: TrafficLink; stats: TrafficLinkLiveStats; distanceMeters: number } | null = null;
    for (const { link, stats } of congestionRanking) {
      for (const [plat, plon] of link.polyline) {
        const d = haversineMeters(lat, lon, plat, plon);
        if (!best || d < best.distanceMeters) best = { link, stats, distanceMeters: d };
      }
    }
    return best && best.distanceMeters <= CONGESTION_NEARBY_RADIUS_METERS ? best : null;
  }
  const onTimeWithCongestion = useMemo(
    () => onTimeEntries.map((entry) => ({ ...entry, nearby: nearestCongestionLink(entry.lat, entry.lon) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nearestCongestionLink closes over congestionRanking, which is already a dependency here.
    [onTimeEntries, congestionRanking],
  );

  // Draw each road segment as a colored polyline - a closed link is drawn
  // as a flat dark red regardless of its last score (a road that's
  // genuinely closed isn't "score 3 congested", it's a different kind of
  // fact entirely and shouldn't be color-scaled the same way).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const entity of congestionEntitiesRef.current) viewer.entities.remove(entity);
    congestionEntitiesRef.current = [];
    // congestionRanking is also populated for the on-time panel's nearby-
    // congestion correlation, independent of this map layer's own toggle -
    // only actually draw the roads when Congestion itself is switched on.
    if (!showCongestion || congestionRanking.length === 0) return;

    congestionEntitiesRef.current = congestionRanking.map(({ link, stats }) => {
      const color = stats.closed
        ? Color.fromCssColorString('#7f1d1d')
        : congestionColor(stats.score, congestionReferenceMax);
      const positions = link.polyline.flatMap(([lat, lon]) => [lon, lat]);
      return viewer.entities.add({
        polyline: {
          positions: Cartesian3.fromDegreesArray(positions),
          width: stats.closed ? 6 : 3 + stats.score,
          material: color.withAlpha(0.85),
          clampToGround: true,
        },
      });
    });
    return () => {
      for (const entity of congestionEntitiesRef.current) viewer.entities.remove(entity);
      congestionEntitiesRef.current = [];
    };
  }, [congestionRanking, showCongestion, congestionReferenceMax]);

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

  // Ranked heat map list (2026-09-08, Ross's ask: "a list of most
  // underutilised or utilised areas") - top/bottom cells by ping count.
  // "Underutilised" only means something for a cell that actually has a
  // stop nearby (see the heat map's own legend: blank ≠ blue) - the union
  // with stop coordinates upstream is exactly what puts those zero-count
  // cells in this array in the first place, so sorting ascending naturally
  // surfaces them, not arbitrary empty ground.
  const HEAT_LIST_SIZE = 8;
  const heatRanking = useMemo(() => {
    if (heatmapCells.length === 0) return { top: [], bottom: [] };
    const sorted = [...heatmapCells].sort((a, b) => b.count - a.count);
    return {
      top: sorted.slice(0, HEAT_LIST_SIZE),
      bottom: sorted.slice(-HEAT_LIST_SIZE).reverse(),
    };
  }, [heatmapCells]);

  // Headline figure for the ranked list panel (2026-09-08, Ross's ask:
  // every panel should lead with an overall number, matching the on-time
  // panel's own network-median header, before the granular list below).
  const heatHeadline = useMemo(() => {
    if (heatmapCells.length === 0) return null;
    const active = heatmapCells.filter((c) => c.count > 0);
    const busiest = active.length > 0 ? Math.max(...active.map((c) => c.count)) : 0;
    const totalPings = heatmapCells.reduce((sum, c) => sum + c.count, 0);
    const coveragePct = Math.round((active.length / heatmapCells.length) * 100);
    return { activeCells: active.length, totalCells: heatmapCells.length, busiest, totalPings, coveragePct };
  }, [heatmapCells]);

  // Heat cells have no name of their own - label each with its nearest bus
  // stop (already-loaded stop data, cheap) so "most utilised" reads as a
  // real place ("near Dickson Interchange") rather than a lat/lon pair.
  // Only resolved for the handful of cells actually shown in the list, not
  // every cell in the grid.
  const [heatListNames, setHeatListNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const cells = [...heatRanking.top, ...heatRanking.bottom];
    if (cells.length === 0) {
      setHeatListNames(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      cells.map(async (c) => {
        const centerLat = c.latBin + HEATMAP_GRID_DEGREES / 2;
        const centerLon = c.lonBin + HEATMAP_GRID_DEGREES / 2;
        const name = await getNearestStopName(centerLat, centerLon);
        return [`${c.latBin}|${c.lonBin}`, name ?? 'Unnamed area'] as const;
      }),
    ).then((pairs) => {
      if (!cancelled) setHeatListNames(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [heatRanking]);

  // #2 on-time performance: recomputed every poll (2026-09-09: was gated on
  // showOnTime, widened so the permanent on-time headline counter stays
  // live regardless of which tab is open). Deliberately scans every
  // currently-active vehicle each time rather than caching between polls -
  // the set of STOPPED_AT vehicles changes constantly, and schedule lookups
  // are cheap in-memory object gets once the snapshot is loaded (no network
  // cost after the first call).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries: OnTimeEntry[] = [];
      for (const bus of busDataRef.current.values()) {
        if (bus.status !== 'STOPPED_AT' || !bus.stopId) continue;
        const scheduled = await getScheduledArrival(bus.tripId, bus.stopId);
        if (scheduled == null) continue;
        const punctuality = computePunctuality(scheduled, secondsSinceMidnightOf(new Date(bus.ts)));
        entries.push({
          vehicleId: bus.id,
          routeId: bus.routeId,
          stopId: bus.stopId,
          punctuality,
          lat: bus.lat,
          lon: bus.lon,
        });
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
  }, [pollTick]);

  // Draw the actual route line(s) as a visible overlay (2026-09-05, Ross's
  // ask) - a direct visual answer to "are vehicles actually locked to their
  // route", using the exact same shape data already used for map-matching,
  // not a separate/approximate line. Three triggers: selecting a single
  // vehicle draws just that vehicle's own shape; picking a specific route
  // from the Routes navigator draws every distinct shape currently in use
  // by that route's active vehicles (a route_id can have more than one -
  // different directions are different shapes); opening the Routes
  // navigator *without* picking one yet (2026-09-08, Ross's ask: "show all
  // routes overlaid on the map so... you can select it there also, rather
  // than just the drop-down list") draws every distinct shape any active
  // vehicle is currently on, each one clickable - see the `routeline:`-
  // prefixed id below and the selectedEntityChanged listener that reacts
  // to it by setting routeFilter, same as picking from the list would.
  useEffect(() => {
    if (!viewerRef.current) return;
    let cancelled = false;

    async function draw() {
      const viewer = viewerRef.current;
      if (!viewer) return;
      // shapeId -> routeId, so a clicked line knows which route to select.
      const shapeToRoute = new Map<string, string>();
      if (routeFilter) {
        for (const p of vehicleProgressRef.current.values()) {
          if (p.routeId === routeFilter) shapeToRoute.set(p.shapeId, p.routeId);
        }
      } else if (showRoutesList) {
        for (const p of vehicleProgressRef.current.values()) {
          if (!shapeToRoute.has(p.shapeId)) shapeToRoute.set(p.shapeId, p.routeId);
        }
      } else if (selectedBus) {
        const shapeId = await getShapeIdForTrip(selectedBus.tripId);
        if (shapeId) shapeToRoute.set(shapeId, selectedBus.routeId);
      }

      const shapes = await Promise.all(
        Array.from(shapeToRoute.entries()).map(async ([shapeId, routeId]) => ({
          shapeId,
          routeId,
          points: await getShapeById(shapeId),
        })),
      );
      if (cancelled) return;

      for (const entity of routeLineEntitiesRef.current) viewer.entities.remove(entity);
      routeLineEntitiesRef.current = shapes
        .filter((s): s is typeof s & { points: NonNullable<typeof s.points> } => !!s.points)
        .map((s) =>
          viewer.entities.add({
            // shapeId suffix keeps this unique even when a route has more
            // than one shape (multiple directions/patterns) drawn at once
            // in the "show all routes" case - Cesium requires unique
            // entity ids, and a route_id alone isn't one here.
            id: `routeline:${s.routeId}:${s.shapeId}`,
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
    // dep); pollTick keeps the drawn shape set current as vehicles come
    // and go.
  }, [routeFilter, showRoutesList, selectedBus, pollTick]);

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

  // Route-first grouping for the Bus/Rail tab (2026-09-09, Ross's ask:
  // "make the route the first col, and have the bus ID's captured nested
  // under the route") - was a flat list sorted by vehicle ID with route as
  // a secondary, right-aligned detail. Route order is by count (busiest
  // route first) since that's usually more useful to scan than alphabetical;
  // vehicle IDs within a route stay alphabetical.
  // Direction per trip (2026-09-09, Ross's ask: nest by direction too, not
  // just route) - shapeId is the reliable "same route, same direction"
  // signal already trusted for bunching (a route_id can have more than one
  // physical pattern per direction, but two trips sharing a shape_id are
  // always the same one), so it's the grouping key; headsign is just the
  // friendly label for whichever shapeId a vehicle resolves to. Both are
  // already-loaded static lookups (route-shapes.json, preloaded at
  // startup) - resolving them is an in-memory map read behind a
  // resolved promise, not a network call, so doing it for every visible
  // vehicle each poll is cheap.
  const [tripDirections, setTripDirections] = useState<Map<string, { shapeId: string | null; headsign: string | null }>>(
    new Map(),
  );
  useEffect(() => {
    const tripIds = Array.from(new Set(filteredList.map((b) => b.tripId)));
    const missing = tripIds.filter((id) => !tripDirections.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (tripId) => {
        const [shapeId, headsign] = await Promise.all([getShapeIdForTrip(tripId), getHeadsignForTrip(tripId)]);
        return [tripId, { shapeId, headsign }] as const;
      }),
    ).then((resolved) => {
      if (cancelled) return;
      setTripDirections((prev) => {
        const next = new Map(prev);
        for (const [tripId, info] of resolved) next.set(tripId, info);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [filteredList, tripDirections]);

  // Foldout state (2026-09-09, Ross's ask: "a foldout rather than auto
  // displayed... showing Route 5 (6 busses)") - collapsed by default,
  // toggled per route.
  const [expandedRoutes, setExpandedRoutes] = useState<Set<string>>(new Set());
  // Collapse everything again on switching between Bus/Rail/away - avoids a
  // stale "Route 5 expanded" carrying over if the other tab also happens to
  // have a route with the same id.
  useEffect(() => setExpandedRoutes(new Set()), [filterType]);
  function toggleRouteExpanded(routeId: string) {
    setExpandedRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      return next;
    });
  }

  const filteredByRoute = useMemo(() => {
    const byRoute = new Map<string, BusPosition[]>();
    for (const b of filteredList) {
      const group = byRoute.get(b.routeId);
      if (group) group.push(b);
      else byRoute.set(b.routeId, [b]);
    }
    return Array.from(byRoute.entries())
      .map(([routeId, vehicles]) => {
        // Group by shapeId (falls back to the vehicle's own id when nothing
        // has resolved yet, so it still renders as its own singleton group
        // rather than vanishing until the lookup above finishes).
        const byDirection = new Map<string, { label: string; vehicles: BusPosition[] }>();
        for (const b of vehicles) {
          const info = tripDirections.get(b.tripId);
          const key = info?.shapeId ?? `unresolved:${b.id}`;
          const existing = byDirection.get(key);
          if (existing) existing.vehicles.push(b);
          else byDirection.set(key, { label: info?.headsign ?? '', vehicles: [b] });
        }
        const directions = Array.from(byDirection.values()).sort((a, b) => b.vehicles.length - a.vehicles.length);
        // Only bother numbering fallback labels ("Direction 1"/"Direction
        // 2") when there's actually more than one direction to distinguish -
        // a route with a single group just doesn't need a direction label
        // at all.
        directions.forEach((d, i) => {
          if (!d.label) d.label = directions.length > 1 ? `Direction ${i + 1}` : '';
        });
        return { routeId, vehicles, directions };
      })
      .sort((a, b) => b.vehicles.length - a.vehicles.length);
  }, [filteredList, tripDirections]);

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
          // on a trip change, so the new trip starts clean with nothing to
          // extrapolate from until its own second sample.
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

          // Orientation from the shape's own tangent direction at the
          // vehicle's current (possibly coasting) position, not the feed's
          // raw bearing held statically. Ross (2026-09-28): "should snap to
          // the route" - once COAST_MAX_SECONDS let a vehicle coast for
          // minutes at a time (long enough to visibly round a real bend),
          // holding the last reported bearing meant the model kept facing
          // wherever it was heading minutes ago, not the way the road it's
          // being drawn on actually goes right now. A CallbackProperty,
          // re-evaluated every frame like the position callback above (and
          // deliberately re-deriving the same projected distance rather
          // than sharing state with it - Cesium invokes each independently,
          // and the duplicated arithmetic is cheap), rather than a
          // SampledProperty snapped once per real fix. Falls back to the
          // feed's own raw bearing only when there's no shape to take a
          // tangent from at all.
          let orientationProperty = orientationsRef.current.get(bus.id);
          if (!orientationProperty) {
            const vehicleId = bus.id;
            orientationProperty = new CallbackProperty((time) => {
              const track = vehicleTrackRef.current.get(vehicleId);
              const nowMs = JulianDate.toDate(time ?? JulianDate.now()).getTime();
              let lat: number;
              let lon: number;
              let headingDeg: number;
              if (track?.shape) {
                const elapsedSec = Math.max(0, Math.min((nowMs - track.atTimeMs) / 1000, COAST_MAX_SECONDS));
                const projected = track.distanceAlong + track.speedMps * elapsedSec;
                const pt = pointAtDistance(track.shape, projected);
                lat = pt.lat;
                lon = pt.lon;
                headingDeg = bearingAtDistance(track.shape, projected);
              } else {
                const live = busDataRef.current.get(vehicleId);
                lat = track?.fallbackLat ?? live?.lat ?? 0;
                lon = track?.fallbackLon ?? live?.lon ?? 0;
                headingDeg = live?.bearing ?? 0;
              }
              const position = Cartesian3.fromDegrees(lon, lat);
              const heading = CesiumMath.toRadians(headingDeg + MODEL_HEADING_OFFSET_DEG);
              return Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(heading, 0, 0));
            }, false);
            orientationsRef.current.set(bus.id, orientationProperty);
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
              // No shape for this trip_id at all - don't trust the raw fix
              // outright (see nearestPointOnAnyShape's doc comment: this is
              // the "floating above the road" root cause). Snap onto
              // whichever known route happens to be nearest instead, so
              // CLAMP_TO_GROUND has a real road surface to clamp to. Falls
              // through to the untouched raw fix only if the shapes
              // snapshot itself never loaded.
              const nearestOnRoad = await nearestPointOnAnyShape(bus.lat, bus.lon);
              if (nearestOnRoad) {
                lat = nearestOnRoad.lat;
                lon = nearestOnRoad.lon;
              }
            }

            vehicleTrackRef.current.set(bus.id, {
              shape: trackShape,
              distanceAlong: trackDistanceAlong,
              atTimeMs: bus.ts,
              speedMps: trackSpeedMps,
              fallbackLat: lat,
              fallbackLon: lon,
            });

            lastSampleTsRef.current.set(bus.id, bus.ts);
          }

          if (!entitiesRef.current.has(bus.id)) {
            const entity = viewer.entities.add({
              id: bus.id,
              position: positionProperty,
              orientation: orientationProperty,
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

  // "Load live data" button (2026-09-08, Ross's ask) - one button, dual
  // function (also Ross's explicit ask): starts ACTBusEventLoader
  // (positions/routes/heat map/near-me) and ACTStopIdLoader (stop_id +
  // delay_minutes - on-time performance, the gauge/histogram panel, "at
  // stop" info) together, directly from the app. See fabricJobsService.ts
  // for why both are safely job-triggerable now (a custom Environment
  // removed the runtime pip install that used to break ACTStopIdLoader's
  // job-triggered runs).
  const [loaderStatus, setLoaderStatus] = useState<{ text: string; isError: boolean } | null>(null);
  const [loaderBusy, setLoaderBusy] = useState(false);
  // Resumes a trigger interrupted by the one-time consent redirect (see
  // fabricJobsService.ts) - a no-op on every normal page load, since
  // there's nothing pending unless the button's own redirect just returned.
  useEffect(() => {
    void resumePendingTriggerIfAny()
      .then((result) => {
        if (result) setLoaderStatus({ text: result.message, isError: result.isError });
      })
      .catch((err: Error) => setLoaderStatus({ text: err.message, isError: true }));
  }, []);

  // On-screen tilt control (2026-09-09) - a guaranteed-to-work alternative
  // to Ctrl+drag, which Ross reported had stopped responding. Steps the
  // camera's pitch in place (same position, same heading, just a shallower
  // or steeper look angle) rather than re-flying anywhere.
  function adjustTilt(deltaDeg: number) {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const camera = viewer.camera;
    const nextPitch = CesiumMath.clamp(
      camera.pitch + CesiumMath.toRadians(deltaDeg),
      CesiumMath.toRadians(-85),
      CesiumMath.toRadians(-10),
    );
    camera.setView({
      destination: camera.positionWC,
      orientation: { heading: camera.heading, pitch: nextPitch, roll: 0 },
    });
  }
  async function handleTriggerLoader() {
    setLoaderBusy(true);
    setLoaderStatus(null);
    try {
      const result = await triggerDataLoaders();
      setLoaderStatus({ text: result.message, isError: result.isError });
    } catch (err) {
      setLoaderStatus({ text: (err as Error).message, isError: true });
    } finally {
      setLoaderBusy(false);
      setTimeout(() => setLoaderStatus(null), 10000);
    }
  }

  // Single source of truth for "which tab is selected" (2026-09-09) -
  // replaces nine near-identical inline handlers (each resetting every
  // *other* state before setting its own) with one function, consolidating
  // logic that used to be copy-pasted per button. Deliberately reads the
  // underlying showX/filterType/nearMeActive state rather than introducing
  // a new parallel "activeTab" state variable - those flags already fully
  // determine which tab is showing (that's exactly how every button already
  // decided its own active/inactive styling), so a second source of truth
  // would only risk drifting out of sync with them.
  type TabId = 'bus' | 'rail' | 'nearme' | 'routes' | 'bunching' | 'heatmap' | 'ontime' | 'equity' | 'congestion';
  function activeTab(): TabId | null {
    if (filterType === 'bus') return 'bus';
    if (filterType === 'rail') return 'rail';
    if (nearMeActive) return 'nearme';
    if (showRoutesList) return 'routes';
    if (showBunching) return 'bunching';
    if (showHeatmap) return 'heatmap';
    if (showOnTime) return 'ontime';
    if (showEquity) return 'equity';
    if (showCongestion) return 'congestion';
    return null;
  }
  // tab === null clears every filter/tab, matching the top counter's
  // "Vehicles" card - a deliberate "show everything, nothing selected"
  // reset rather than a tenth tab of its own.
  function selectTab(tab: TabId | null) {
    if (tab !== null && activeTab() === tab) {
      // Re-clicking the active tab turns it off - same toggle-off behaviour
      // every button already had individually.
      switch (tab) {
        case 'bus':
        case 'rail':
          setFilterType('all');
          return;
        case 'nearme':
          toggleNearMe();
          return;
        case 'routes':
          setShowRoutesList(false);
          setRouteFilter(null);
          return;
        case 'bunching':
          setShowBunching(false);
          return;
        case 'heatmap':
          setShowHeatmap(false);
          return;
        case 'ontime':
          setShowOnTime(false);
          return;
        case 'equity':
          setShowEquity(false);
          return;
        case 'congestion':
          setShowCongestion(false);
          return;
      }
    }
    // Reset every other tab, then activate the requested one (or nothing,
    // for tab === null).
    setFilterType('all');
    if (nearMeActive && tab !== 'nearme') toggleNearMe();
    setShowRoutesList(false);
    setRouteFilter(null);
    setShowBunching(false);
    setShowHeatmap(false);
    setShowOnTime(false);
    setShowEquity(false);
    setShowCongestion(false);
    switch (tab) {
      case 'bus':
        setFilterType('bus');
        break;
      case 'rail':
        setFilterType('rail');
        break;
      case 'nearme':
        toggleNearMe();
        break;
      case 'routes':
        setShowRoutesList(true);
        break;
      case 'bunching':
        setShowBunching(true);
        break;
      case 'heatmap':
        setShowHeatmap(true);
        break;
      case 'ontime':
        setShowOnTime(true);
        break;
      case 'equity':
        setShowEquity(true);
        break;
      case 'congestion':
        setShowCongestion(true);
        break;
    }
  }

  return (
    <div className="relative h-screen w-full flex flex-col bg-slate-950 text-white font-sans overflow-hidden">
      {/* Header (2026-09-09, Ross's ask: "build the entire permanent panel
          as in the Helsinki style... make the map a pane within the dash").
          Fixed chrome, never scrolls away. */}
      <header className="flex items-center justify-between gap-3 px-4 py-2 border-b border-white/10 shrink-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <div className="font-display text-base font-semibold tracking-tight shrink-0">Canberra Pulse</div>
          <div className="text-xs text-white/40 truncate">Live transit digital twin for the ACT</div>
        </div>
        <div className="flex items-center gap-2">
          {loaderStatus && (
            <span
              className={`text-xs px-2 py-1 rounded max-w-64 truncate ${
                loaderStatus.isError ? 'bg-red-50 text-red-700' : 'text-white/50'
              }`}
            >
              {loaderStatus.text}
            </span>
          )}
          <button
            onClick={() => void handleTriggerLoader()}
            disabled={loaderBusy}
            className="bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5 text-sm text-white/80 disabled:opacity-50 flex items-center gap-1.5 transition-colors shrink-0"
          >
            <span aria-hidden>▶️</span>
            {loaderBusy ? 'Starting…' : 'Load live data'}
          </button>
        </div>
      </header>

      {/* Permanent headline counter strip (2026-09-09, Ross's ask: "make the
          headline figures permanent counters") - always visible regardless
          of which tab is open, unlike the old per-tab-only headline cards
          still further down. Backing data (population/traffic/on-time) now
          fetches unconditionally at startup instead of lazily on tab-open -
          see the widened useEffects above - so these numbers are live from
          the first poll, not just placeholders until a tab is opened once.
          Separate rounded tiles with gaps between them (2026-09-09, Ross's
          ask: "make the blocks separate and not joined") - was one
          continuous divide-x strip. */}
      <div className="flex items-stretch gap-2 px-3 py-2 border-b border-white/10 shrink-0 overflow-x-auto">
        {/* Split into Bus/Light rail (2026-09-09, Ross's ask: "a tile for
            Bus and Light rail... not both") - was one combined "Vehicles"
            card. No "available" (total fleet size) figure exists to pair
            with "active" here - GTFS doesn't model physical vehicles at
            all, only trips/routes/schedules, so there's no static fleet
            count anywhere in this app's data to compare the live count
            against (unlike Routes, where the static schedule genuinely
            does enumerate every route_id). Each card's number is the live
            count only - honestly labelled as that, not paired with a
            fabricated "available" figure. */}
        {/* Ordered to exactly match the left nav rail below (2026-09-28,
            Ross's ask: "each of the selectors should be in sequence L-R and
            up to down") - same activeTab()/selectTab() single source of
            truth already meant a click on one side always highlighted the
            other, but the two lists showing different orders made that
            correspondence hard to see at a glance. */}
        <CounterCard
          icon="🚌"
          label="Bus"
          value={String(busCount)}
          sub="active now"
          active={activeTab() === 'bus'}
          onClick={() => selectTab('bus')}
        />
        <CounterCard
          icon="🚈"
          label="Light rail"
          value={String(railCount)}
          sub="active now"
          active={activeTab() === 'rail'}
          onClick={() => selectTab('rail')}
        />
        <CounterCard
          icon="📍"
          label="Near me"
          value={nearMeActive ? String(nearestStops.length) : '—'}
          sub={nearMeActive ? 'nearby stops' : 'tap to activate'}
          active={activeTab() === 'nearme'}
          onClick={() => selectTab('nearme')}
        />
        <CounterCard
          icon="🛣️"
          label="Active routes"
          value={String(routeCounts.length)}
          sub={`${routeCounts.reduce((sum, r) => sum + r.count, 0)} vehicles`}
          active={activeTab() === 'routes'}
          onClick={() => selectTab('routes')}
        />
        <CounterCard
          icon="⚠️"
          label="Bunching"
          value={String(bunchingAlerts.length)}
          sub={bunchingHeadline ? `${bunchingHeadline.affectedRouteCount} routes` : 'none right now'}
          active={activeTab() === 'bunching'}
          onClick={() => selectTab('bunching')}
        />
        <CounterCard
          icon="🔥"
          label="Heat coverage"
          value={heatHeadline ? `${heatHeadline.coveragePct}%` : '—'}
          sub={heatHeadline ? `${heatHeadline.activeCells}/${heatHeadline.totalCells} zones` : 'no data yet'}
          active={activeTab() === 'heatmap'}
          onClick={() => selectTab('heatmap')}
        />
        <CounterCard
          icon="⏱"
          label="On-time median"
          value={onTimeSummary ? `${onTimeSummary.median > 0 ? '+' : ''}${onTimeSummary.median}m` : '—'}
          sub={onTimeSummary ? `n=${onTimeSummary.n}` : 'no data yet'}
          active={activeTab() === 'ontime'}
          onClick={() => selectTab('ontime')}
        />
        <CounterCard
          icon="🏘️"
          label="Underserved areas"
          value={equityHeadline ? String(equityHeadline.underservedCount) : '—'}
          sub={equityHeadline ? `of ${equityHeadline.totalAreas} SA1 areas` : 'no data yet'}
          active={activeTab() === 'equity'}
          onClick={() => selectTab('equity')}
        />
        <CounterCard
          icon="🚦"
          label="Congestion"
          value={congestionHeadline ? congestionHeadline.avgScore.toFixed(1) : '—'}
          sub={congestionHeadline ? `${congestionHeadline.congestedCount} congested` : 'no data yet'}
          active={activeTab() === 'congestion'}
          onClick={() => selectTab('congestion')}
        />
      </div>

      {/* Body: nav rail + map pane + detail pane. */}
      <div className="flex-1 flex min-h-0">
        <nav className="w-44 shrink-0 border-r border-white/10 flex flex-col overflow-y-auto py-2 gap-0.5">
          <button
            onClick={() => selectTab('bus')}
            className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors ${
              activeTab() === 'bus' ? 'bg-sky-500 text-white' : 'hover:bg-white/10'
            }`}
          >
            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: TYPE_COLOR.bus }} />
            {busCount} Bus
          </button>
          <button
            onClick={() => selectTab('rail')}
            className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors ${
              activeTab() === 'rail' ? 'bg-sky-500 text-white' : 'hover:bg-white/10'
            }`}
          >
            <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: TYPE_COLOR.rail }} />
            {railCount} Light rail
          </button>
          <button
            onClick={() => selectTab('nearme')}
            className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors ${
              activeTab() === 'nearme' ? 'bg-sky-500 text-white' : 'hover:bg-white/10'
            }`}
          >
            <span aria-hidden>📍</span>
            Near me
          </button>
          <button
            onClick={() => selectTab('routes')}
            className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors ${
              activeTab() === 'routes' ? 'bg-sky-500 text-white' : 'hover:bg-white/10'
            }`}
          >
            <span aria-hidden>🛣️</span>
            Routes
          </button>
          <button
            onClick={() => selectTab('bunching')}
            className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors ${
              activeTab() === 'bunching' ? 'bg-sky-500 text-white' : 'hover:bg-white/10'
            } ${bunchingAlerts.length > 0 && activeTab() !== 'bunching' ? 'text-amber-500' : ''}`}
          >
            <span aria-hidden>⚠️</span>
            {bunchingAlerts.length > 0 ? `${bunchingAlerts.length} Bunched` : 'Bunching'}
          </button>
          <button
            onClick={() => selectTab('heatmap')}
            className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors ${
              activeTab() === 'heatmap' ? 'bg-sky-500 text-white' : 'hover:bg-white/10'
            }`}
          >
            <span aria-hidden>🔥</span>
            {heatmapLoading ? 'Loading…' : 'Heat map'}
          </button>
          <button
            onClick={() => selectTab('ontime')}
            className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors ${
              activeTab() === 'ontime' ? 'bg-sky-500 text-white' : 'hover:bg-white/10'
            }`}
          >
            <span aria-hidden>⏱</span>
            On-time
          </button>
          <button
            onClick={() => selectTab('equity')}
            className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors ${
              activeTab() === 'equity' ? 'bg-sky-500 text-white' : 'hover:bg-white/10'
            }`}
          >
            <span aria-hidden>🏘️</span>
            {equityLoading ? 'Loading…' : 'Availability'}
          </button>
          <button
            onClick={() => selectTab('congestion')}
            className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors ${
              activeTab() === 'congestion' ? 'bg-sky-500 text-white' : 'hover:bg-white/10'
            }`}
          >
            <span aria-hidden>🚦</span>
            {congestionLoading ? 'Loading…' : 'Congestion'}
          </button>
          <Link
            to="/trends"
            className="flex items-center gap-2 px-3 py-2 mx-2 rounded-md text-sm transition-colors hover:bg-white/10"
          >
            <span aria-hidden>📈</span>
            Trends
          </Link>
        </nav>

        {/* Map pane (2026-09-09, Ross's ask: "make the map a pane within the
            dash") - bounded card, not full-bleed. Cesium's Viewer resizes to
            fill whatever container it's given, so this needed no change to
            the Cesium setup itself, only to the CSS around it. */}
        <div className="flex-1 relative min-w-0 m-3 rounded-2xl overflow-hidden border border-white/10 bg-black">
          <div ref={containerRef} className="absolute inset-0" />
      <div className="absolute bottom-4 right-4 z-30 flex flex-col items-center rounded-xl border border-white/10 bg-slate-950/85 text-white shadow-2xl backdrop-blur-xl overflow-hidden">
        <button
          onClick={() => adjustTilt(-8)}
          title="Tilt up (shallower / more flyover)"
          aria-label="Tilt up"
          className="w-9 h-9 flex items-center justify-center text-lg hover:bg-white/10 transition-colors border-b border-white/10"
        >
          ⤢
        </button>
        <button
          onClick={() => adjustTilt(8)}
          title="Tilt down (steeper / more top-down)"
          aria-label="Tilt down"
          className="w-9 h-9 flex items-center justify-center text-lg hover:bg-white/10 transition-colors"
        >
          ⤡
        </button>
      </div>
      {/* On-time gauge/histogram/trend bubble (2026-09-28, Ross's ask: "put
          the gauges for the on time selection in a floating bubble like the
          live data stream, but only when that tab is selected") - moved out
          of the docked aside (which still shows the per-vehicle on-time
          list) into its own floating card over the map, matching the live
          data stream bubble's styling. Trend is *this session only* (see
          medianHistory's own doc comment) - durable multi-day history needs
          the delay-at-ingestion pipeline still in progress. */}
      {showOnTime && onTimeSummary && (
        <div className="absolute top-4 right-4 z-30 w-64 rounded-xl border border-white/10 bg-slate-950/85 text-white shadow-2xl backdrop-blur-xl overflow-hidden">
          <div className="px-3 py-1.5 border-b border-white/10 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
            <span className="font-display text-[10px] uppercase tracking-wide text-white/50">
              On-time performance
            </span>
          </div>
          <div className="max-h-[70vh] overflow-y-auto text-xs px-3 py-3 flex flex-col gap-4">
            <div>
              <div className="font-display text-white/50 font-medium mb-1">Network median, live</div>
              <svg viewBox="0 0 200 115" className="w-full">
                <path d={gaugeArcPath(100, 100, 80, -GAUGE_RANGE_MINUTES, -2)} stroke="#2979FF" strokeWidth={14} fill="none" />
                <path d={gaugeArcPath(100, 100, 80, -2, 2)} stroke="#22c55e" strokeWidth={14} fill="none" />
                <path d={gaugeArcPath(100, 100, 80, 2, GAUGE_RANGE_MINUTES)} stroke="#dc2626" strokeWidth={14} fill="none" />
                {(() => {
                  const tip = polarPoint(100, 100, 68, gaugeAngleDeg(onTimeSummary.median));
                  return (
                    <line x1={100} y1={100} x2={tip.x} y2={tip.y} stroke="#f1f5f9" strokeWidth={3} strokeLinecap="round" />
                  );
                })()}
                <circle cx={100} cy={100} r={5} fill="#f1f5f9" />
                <text x={20} y={112} fontSize={9} fill="#cbd5e1">
                  early
                </text>
                <text x={165} y={112} fontSize={9} fill="#cbd5e1">
                  late
                </text>
              </svg>
            </div>
            <div>
              <div className="font-display text-white/50 font-medium mb-1">
                Median trend, this session ({medianHistory.length} polls)
              </div>
              {medianHistory.length < 2 ? (
                <div className="text-white/40">Collecting more polls…</div>
              ) : (
                <svg viewBox="0 0 260 60" className="w-full">
                  <line x1={0} y1={30} x2={260} y2={30} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
                  <polyline
                    fill="none"
                    stroke="#f1f5f9"
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
              <div className="font-display text-white/50 font-medium mb-1">
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
                        <text x={i * barWidth + barWidth / 2} y={67} fontSize={7} fill="#cbd5e1" textAnchor="middle">
                          {bin.label}
                        </text>
                      </g>
                    );
                  });
                })()}
              </svg>
            </div>
          </div>
        </div>
      )}
      {/* Live data stream bubble (2026-09-28, Ross's ask) - always visible,
          not gated behind any tab, since the point is reassurance that data
          is genuinely arriving regardless of what else is on screen.
          Positioned above the tilt control rather than sharing its corner. */}
      <div className="absolute bottom-24 right-4 z-30 w-60 rounded-xl border border-white/10 bg-slate-950/85 text-white shadow-2xl backdrop-blur-xl overflow-hidden">
        <div className="px-3 py-1.5 border-b border-white/10 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="font-display text-[10px] uppercase tracking-wide text-white/50">Live data stream</span>
        </div>
        <div className="max-h-48 overflow-y-auto">
          {liveFeed.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-white/40">Waiting for data…</div>
          ) : (
            liveFeed.map((b) => {
              // Temporary diagnostic row (2026-09-28) - reads the exact
              // internal state the coast callback uses, so "is it actually
              // moving" is answerable by looking at the screen instead of
              // guessing from outside the browser. Remove once the motion
              // question is settled either way.
              const track = vehicleTrackRef.current.get(b.id);
              const diag = !track
                ? 'no track yet'
                : !track.shape
                  ? 'no shape match'
                  : `${track.speedMps.toFixed(1)} m/s`;
              return (
                <div key={b.id} className="px-3 py-1 border-b border-white/5 last:border-0 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: isLightRail(b.id) ? TYPE_COLOR.rail : TYPE_COLOR.bus }}
                      />
                      <span className="truncate">
                        {isLightRail(b.id) ? 'Rail' : 'Bus'} {b.id} · R{b.routeId}
                      </span>
                    </span>
                    <span className="text-white/40 shrink-0">{formatFeedAge(Date.now() - b.ts)}</span>
                  </div>
                  <div className="text-white/30 pl-3">
                    {b.status} · {diag}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      {selectedBus && (
        <VehiclePanel
          bus={selectedBus}
          onClose={() => {
            setSelectedId(null);
            if (viewerRef.current) viewerRef.current.selectedEntity = undefined;
          }}
        />
      )}
      <div className="absolute bottom-2 right-3 text-[11px] text-white/50">
        3D model: "Bus low poly simple GLB" by Chelebonchik Games (CC-BY 4.0)
      </div>
        </div>

        {/* Detail pane - docked, not floating over the map (2026-09-09).
            Every section below keeps its own original show/active condition
            unchanged; only the outer floating-panel chrome (position,
            background, border, its own scroll container) was stripped,
            since this shared aside now provides all of that once for
            whichever tab is actually active. Only one tab's condition is
            ever true at a time (near me's own sub-states aside). */}
        {activeTab() !== null && (
          <aside className="w-80 shrink-0 border-l border-white/10 bg-slate-950/85 backdrop-blur-xl overflow-y-auto">
      {showHeatmap && (
        <div className="text-xs px-3 py-2 flex flex-col gap-2 border-b border-white/10">
          <div className="flex items-center gap-2">
            <span className="text-white/50 shrink-0">Vehicle activity, last 24h:</span>
            <span
              className="inline-block flex-1 h-3 rounded"
              style={{ background: 'linear-gradient(to right, #2979FF, #FFF59D, #D32F2F)' }}
            />
          </div>
          <div className="flex justify-between text-white/40">
            <span>no stop nearby / underutilised</span>
            <span>ultra-high</span>
          </div>
          <div className="flex items-center gap-2 pt-1 border-t border-white/10">
            <span className="text-white/50 shrink-0">Sensitivity</span>
            <input
              type="range"
              min={1}
              max={50}
              step={1}
              value={heatmapSensitivity}
              onChange={(e) => setHeatmapSensitivity(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-white/40 w-8 text-right">{heatmapSensitivity}</span>
          </div>
        </div>
      )}
      {/* Ranked heat map list (2026-09-08, Ross's ask) - right side so it
          doesn't collide with the legend on the left. */}
      {showHeatmap && (heatRanking.top.length > 0 || heatRanking.bottom.length > 0) && (
        <div className="text-xs">
          {heatHeadline && (
            <div className="px-3 py-2 border-b border-white/10 sticky top-0 bg-slate-950/85">
              <div className="font-display text-[11px] uppercase tracking-wide text-white/40">Network activity</div>
              <div className="flex items-baseline justify-between">
                <span className="font-display text-lg font-semibold text-white">
                  {heatHeadline.activeCells}
                  <span className="text-xs text-white/40 font-normal"> / {heatHeadline.totalCells} zones active</span>
                </span>
                <span className="text-xs text-white/40">{heatHeadline.coveragePct}% coverage</span>
              </div>
              <div className="flex items-baseline justify-between mt-1">
                <span className="text-xs text-white/40">peak zone: {heatHeadline.busiest} updates</span>
                <span className="text-xs text-white/40">{heatHeadline.totalPings.toLocaleString()} updates (24h)</span>
              </div>
            </div>
          )}
          {(
            [
              ['Most utilised', heatRanking.top, 'text-red-600'],
              ['Most underutilised (has a stop nearby)', heatRanking.bottom, 'text-blue-600'],
            ] as const
          ).map(([title, cells, colorClass]) => (
            <div key={title}>
              <div className="px-3 py-1.5 border-b border-white/10 font-display font-medium text-white/60 sticky top-0 bg-slate-950/85">
                {title}
              </div>
              {cells.map((cell) => {
                const key = `${cell.latBin}|${cell.lonBin}`;
                const name = heatListNames.get(key) ?? '…';
                return (
                  <button
                    key={key}
                    onClick={() => {
                      const viewer = viewerRef.current;
                      if (viewer) {
                        void viewer.camera.flyTo({
                          destination: Cartesian3.fromDegrees(
                            cell.lonBin + HEATMAP_GRID_DEGREES / 2,
                            cell.latBin + HEATMAP_GRID_DEGREES / 2,
                            600,
                          ),
                          duration: 1.2,
                        });
                      }
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-white/10 border-b border-white/10 last:border-0"
                  >
                    <span className="truncate">{name}</span>
                    <span className={`shrink-0 font-medium ${colorClass}`}>
                      {cell.count} vehicle {cell.count === 1 ? 'update' : 'updates'} (24h)
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {showEquity && (
        <div className="text-xs px-3 py-2 flex flex-col gap-2 border-b border-white/10">
          <div className="text-white/60 font-medium">
            Service availability vs. 2021 Census population (last 24h)
          </div>
          <div className="flex items-center gap-2">
            <span className="text-white/50 shrink-0">Per SA1 area, relative to the rest of the ACT:</span>
          </div>
          <div
            className="inline-block h-3 rounded"
            style={{ background: 'linear-gradient(to right, #2979FF, #FFF59D, #8B0000)' }}
          />
          <div className="flex justify-between text-white/40">
            <span>well served for its population</span>
            <span>densely populated, underserved</span>
          </div>
          <div className="text-white/40 pt-1 border-t border-white/10">
            {populationCells.length > 0
              ? `${populationCells.length} SA1 areas · ${populationCells.reduce((n, c) => n + c.population, 0).toLocaleString()} people`
              : 'Loading population data…'}
          </div>
        </div>
      )}
      {/* Ranked equity list (2026-09-08, Ross's ask: "a list of the areas...
          densely populated, underserved, and vice versa"). Right side, same
          reasoning as the heat map list above. */}
      {showEquity && (equityLists.underserved.length > 0 || equityLists.wellServed.length > 0) && (
        <div className="text-xs">
          {equityHeadline && (
            <div className="px-3 py-2 border-b border-white/10 sticky top-0 bg-slate-950/85">
              <div className="font-display text-[11px] uppercase tracking-wide text-white/40">Service availability</div>
              <div className="flex items-baseline justify-between">
                <span className="font-display text-lg font-semibold text-red-600">{equityHeadline.underservedCount}</span>
                <span className="text-xs text-white/40">of {equityHeadline.totalAreas} SA1 areas underserved</span>
              </div>
              <div className="flex items-baseline justify-between mt-1">
                <span className="font-display text-sm font-semibold text-blue-600">{equityHeadline.wellServedCount}</span>
                <span className="text-xs text-white/40">well served</span>
              </div>
              <div className="text-white/40 truncate mt-1">Worst: {equityHeadline.worstAreaName}</div>
              <div className="text-white/40 truncate">Best: {equityHeadline.bestAreaName}</div>
            </div>
          )}
          {(
            [
              ['Densely populated, underserved', equityLists.underserved, 'text-red-600'],
              ['Well served for their population', equityLists.wellServed, 'text-blue-600'],
            ] as const
          ).map(([title, entries, colorClass]) => (
            <div key={title}>
              <div className="px-3 py-1.5 border-b border-white/10 font-display font-medium text-white/60 sticky top-0 bg-slate-950/85">
                {title}
              </div>
              {entries.map(({ cell, densityPerSqKm }) => (
                <button
                  key={cell.sa1Code}
                  onClick={() => {
                    const viewer = viewerRef.current;
                    if (viewer) {
                      void viewer.camera.flyTo({
                        destination: Cartesian3.fromDegrees(cell.centroidLon, cell.centroidLat, 800),
                        duration: 1.2,
                      });
                    }
                  }}
                  className="w-full flex flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-white/10 border-b border-white/10 last:border-0"
                >
                  <span className="truncate font-medium text-white/80">{cell.areaName}</span>
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="text-white/40 shrink-0">{cell.population.toLocaleString()} people live here</span>
                    <span className={`shrink-0 font-medium ${colorClass}`}>
                      {Math.round(densityPerSqKm).toLocaleString()} people/km²
                      <span className="text-white/40 font-normal">
                        {' '}
                        ({Math.round(densityPerSqKm / 100).toLocaleString()}/ha)
                      </span>
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {showCongestion && (
        <div className="text-xs px-3 py-2 flex flex-col gap-2 border-b border-white/10">
          <div className="text-white/60 font-medium">Live road congestion (Bluetooth detectors)</div>
          <div
            className="inline-block h-3 rounded"
            style={{ background: 'linear-gradient(to right, #eab308, #f97316, #dc2626)' }}
          />
          <div className="flex justify-between text-white/40">
            <span>free-flowing</span>
            <span>severe (score 7)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-1.5 rounded" style={{ background: '#7f1d1d' }} />
            <span className="text-white/50">Closed</span>
          </div>
          <div className="text-white/40 pt-1 border-t border-white/10">
            {congestionRanking.length > 0
              ? `${congestionRanking.length} of ${trafficLinks.length} road segments reporting`
              : trafficLinks.length > 0
                ? 'No live stats yet - has ACTTrafficLoader been run recently?'
                : 'Loading road network…'}
          </div>
        </div>
      )}
      {/* Ranked congestion list (2026-09-08, Ross's find: ACT's public
          Bluetooth-detector traffic API) - same right-side list pattern as
          heat map/equity. Named segments read far better than link IDs. */}
      {showCongestion && (congestionLists.mostCongested.length > 0 || congestionLists.closed.length > 0) && (
        <div className="text-xs">
          {congestionHeadline && (
            <div className="px-3 py-2 border-b border-white/10 sticky top-0 bg-slate-950/85">
              <div className="font-display text-[11px] uppercase tracking-wide text-white/40">Network congestion</div>
              <div className="flex items-baseline justify-between">
                <span
                  className={`font-display text-lg font-semibold ${congestionHeadline.avgScore >= 1 ? 'text-orange-600' : 'text-white'}`}
                >
                  {congestionHeadline.avgScore.toFixed(1)}
                  <span className="text-xs text-white/40 font-normal"> avg score</span>
                </span>
                <span className="text-xs text-white/40">{congestionHeadline.reporting} segments reporting</span>
              </div>
              <div className="text-white/40">
                {congestionHeadline.congestedCount} congested · {congestionHeadline.closedCount} closed
              </div>
              {congestionHeadline.worstLinkName && (
                <div className="text-white/40 truncate mt-1">Worst: {congestionHeadline.worstLinkName}</div>
              )}
            </div>
          )}
          {congestionLists.closed.length > 0 && (
            <div>
              <div className="px-3 py-1.5 border-b border-white/10 font-display font-medium text-white/60 sticky top-0 bg-slate-950/85">
                Closed right now
              </div>
              {congestionLists.closed.map(({ link }) => (
                <button
                  key={link.linkId}
                  onClick={() => {
                    const viewer = viewerRef.current;
                    if (viewer && link.polyline.length > 0) {
                      const [midLat, midLon] = link.polyline[Math.floor(link.polyline.length / 2)];
                      void viewer.camera.flyTo({
                        destination: Cartesian3.fromDegrees(midLon, midLat, 800),
                        duration: 1.2,
                      });
                    }
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-white/10 border-b border-white/10 last:border-0 text-red-400 font-medium truncate"
                >
                  {link.name}
                </button>
              ))}
            </div>
          )}
          <div>
            <div className="px-3 py-1.5 border-b border-white/10 font-display font-medium text-white/60 sticky top-0 bg-slate-950/85">
              Most congested
            </div>
            {congestionLists.mostCongested.map(({ link, stats }) => (
              <button
                key={link.linkId}
                onClick={() => {
                  const viewer = viewerRef.current;
                  if (viewer && link.polyline.length > 0) {
                    const [midLat, midLon] = link.polyline[Math.floor(link.polyline.length / 2)];
                    void viewer.camera.flyTo({
                      destination: Cartesian3.fromDegrees(midLon, midLat, 800),
                      duration: 1.2,
                    });
                  }
                }}
                className="w-full flex flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-white/10 border-b border-white/10 last:border-0"
              >
                <span className="truncate font-medium text-white/80">{link.name}</span>
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-white/40 shrink-0">
                    {stats.speed} km/h · {stats.tt}s (free-flow {link.minTT}s)
                  </span>
                  <span className="shrink-0 font-medium" style={{ color: '#dc2626' }}>
                    score {stats.score}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      {/* "Near me for this bus" (2026-09-08): selecting a vehicle while Near
          Me is active re-anchors this same panel to that bus's own upcoming
          stops - see the vehicleUpcomingStops effect above for why. The
          vehicle info bar at the bottom is untouched either way. */}
      {nearMeActive && selectedBus && (
        <div className="text-sm">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 sticky top-0 bg-slate-950/85">
            <span className="font-medium truncate">
              Route {selectedBus.routeId} · Vehicle {selectedBus.id}
            </span>
            <button
              onClick={() => {
                setSelectedId(null);
                if (viewerRef.current) viewerRef.current.selectedEntity = undefined;
              }}
              className="text-white/40 hover:text-white/80 text-xs shrink-0 ml-2 underline decoration-dotted"
            >
              Back to near me
            </button>
          </div>
          {vehicleUpcomingStops.length > 0 && (
            <div className="px-3 py-1.5 border-b border-white/10 text-[11px] text-white/40">
              Now: {formatArrivalClock(secondsSinceMidnightNow())} — arrival times below are offsets
              from this
            </div>
          )}
          {vehicleUpcomingStops.length === 0 ? (
            <div className="px-3 py-2 text-white/40">
              No upcoming stops found for this trip (may not be in today's schedule)
            </div>
          ) : (
            vehicleUpcomingStops.map((stop) => {
              const nowSecs = secondsSinceMidnightNow();
              return (
                <div
                  key={stop.stopId}
                  className="px-3 py-2 border-b border-white/10 last:border-0 cursor-pointer hover:bg-white/10"
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
                    <span className="text-white/50 text-xs shrink-0">
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
        <div className="text-sm">
          {userLocation && nearestStops.length > 0 && (
            <div className="px-3 py-1.5 border-b border-white/10 text-[11px] text-white/40 sticky top-0 bg-slate-950/85">
              Now: {formatArrivalClock(secondsSinceMidnightNow())} — arrival times below are offsets
              from this
            </div>
          )}
          {!userLocation ? (
            <div className="px-3 py-2 text-white/40">
              {locationError ?? 'Finding your location…'}
            </div>
          ) : nearestStops.length === 0 ? (
            <div className="px-3 py-2 text-white/40">Loading nearby stops…</div>
          ) : (
            nearestStops.map((stop) => {
              const nowSecs = secondsSinceMidnightNow();
              return (
                <div
                  key={stop.stopId}
                  className={`px-3 py-2 border-b border-white/10 last:border-0 cursor-pointer hover:bg-white/10 ${
                    nextBusStopId === stop.stopId ? 'bg-sky-400/20' : ''
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
                    <span className="text-white/40 text-xs shrink-0">
                      {formatDistance(stop.distanceMeters)}
                    </span>
                  </div>
                  {stop.routes.length === 0 ? (
                    <div className="text-white/40 text-xs mt-1">No scheduled services today</div>
                  ) : (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {stop.routes.map((route) => {
                        const live = liveRouteProximity.get(`${stop.stopId}|${route.routeId}`);
                        return (
                          <div
                            key={route.routeId}
                            className="flex items-center justify-between text-xs gap-2"
                          >
                            <span className="font-medium text-white/80 shrink-0">
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
                                className="text-green-600 hover:text-green-400 font-medium truncate underline decoration-dotted"
                              >
                                🔴 Live · ~{formatDistance(live.distanceMeters)} away
                              </button>
                            ) : (
                              <span className="text-white/50 truncate">
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
        <div className="text-sm border-t border-white/10">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
            <span className="font-medium">Next bus</span>
            <button
              onClick={() => setNextBusStopId(null)}
              aria-label="Close"
              className="text-white/40 hover:text-white/80 text-lg leading-none"
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
              className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-white/10 border-b border-white/10 last:border-0"
            >
              <span className="font-medium text-white/80">
                {row.directionLabel ?? `Route ${row.routeId}`}
              </span>
              <span className="text-xs text-white/50">
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
        <div className="text-sm">
          {filteredByRoute.length === 0 ? (
            <div className="px-3 py-2 text-white/40">No vehicles right now</div>
          ) : (
            filteredByRoute.map(({ routeId, vehicles, directions }) => {
              const expanded = expandedRoutes.has(routeId);
              return (
                <div key={routeId}>
                  {/* Foldout header (2026-09-09, Ross's ask: "a foldout
                      rather than auto displayed... showing Route 5 (6
                      busses)") - collapsed by default, click to expand. */}
                  <button
                    onClick={() => toggleRouteExpanded(routeId)}
                    className="w-full px-3 py-1.5 border-b border-white/10 font-display font-medium text-white/60 sticky top-0 bg-slate-950/85 flex items-center justify-between text-left hover:bg-white/10"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
                      Route {routeId} ({vehicles.length})
                    </span>
                  </button>
                  {expanded &&
                    directions.map((dir, i) => (
                      <div key={i}>
                        {dir.label && (
                          <div className="px-3 py-1 pl-6 text-[11px] uppercase tracking-wide text-white/40">
                            {dir.label}
                          </div>
                        )}
                        {dir.vehicles.map((b) => (
                          <button
                            key={b.id}
                            onClick={() => {
                              setSelectedId(b.id);
                              const entity = entitiesRef.current.get(b.id);
                              const viewer = viewerRef.current;
                              if (entity && viewer) void viewer.flyTo(entity);
                            }}
                            className="w-full flex items-center justify-between px-3 py-1.5 pl-8 text-left hover:bg-white/10 border-b border-white/10 last:border-0"
                          >
                            <span className="font-medium">{b.id}</span>
                            {/* Live GTFS-RT status, not a scheduled
                                departure time - no per-trip schedule lookup
                                exists for this list yet (would need one
                                getStopsForTrip() call per vehicle per poll -
                                a real cost worth avoiding unless this turns
                                out to actually be wanted). */}
                            <span className="text-white/40 text-xs">
                              {b.status === 'STOPPED_AT' ? 'At stop' : b.status === 'IN_TRANSIT_TO' ? 'In transit' : b.status}
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                </div>
              );
            })
          )}
        </div>
      )}
      {/* #12 route navigator (2026-09-05): every route currently in the live
          feed, clickable to isolate just that route's vehicles on the map.
          Kept as a plain scrollable list rather than inline buttons like
          Bus/Rail - there can be dozens of routes, unlike two vehicle types,
          so this needed a different visual treatment. */}
      {showRoutesList && (
        <div className="text-sm border-b border-white/10">
          {routeFilter && (
            <button
              onClick={() => setRouteFilter(null)}
              className="w-full px-3 py-2 text-left text-white/50 hover:bg-white/10 border-b border-white/10"
            >
              &larr; Show all routes
            </button>
          )}
          {allRoutes.length === 0 ? (
            <div className="px-3 py-2 text-white/40">No routes active right now</div>
          ) : (
            allRoutes.map((routeId) => (
              <button
                key={routeId}
                onClick={() => setRouteFilter(routeId)}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-white/10 border-b border-white/10 last:border-0 ${
                  routeFilter === routeId ? 'bg-sky-500 text-white hover:bg-sky-500' : ''
                }`}
              >
                <span className="font-medium">Route {routeId}</span>
              </button>
            ))
          )}
        </div>
      )}
      {/* Right-side headline + ranked breakdown for Routes (2026-09-08,
          Ross's ask) - the left panel above is the functional route picker,
          untouched; this is the informational "what's busiest" view every
          other layer now has. */}
      {showRoutesList && routeCounts.length > 0 && (
        <div className="text-xs">
          <div className="px-3 py-2 border-b border-white/10 sticky top-0 bg-slate-950/85">
            <div className="font-display text-[11px] uppercase tracking-wide text-white/40">Active routes</div>
            <div className="flex items-baseline justify-between">
              <span className="font-display text-lg font-semibold text-white">{routeCounts.length}</span>
              <span className="text-xs text-white/40">
                {routeCounts.reduce((sum, r) => sum + r.count, 0)} vehicles total
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-xs text-white/40">
                busiest: Route {routeCounts[0]?.routeId} ({routeCounts[0]?.count})
              </span>
              <span className="text-xs text-white/40">
                {(routeCounts.reduce((sum, r) => sum + r.count, 0) / routeCounts.length).toFixed(1)} avg/route
              </span>
            </div>
          </div>
          {/* All routes, busiest first, inactive ones greyed out rather than
              hidden (2026-09-09, Ross's ask: "routes split to active and non
              active, still shown but greyed out") - allRouteRows merges the
              full static schedule's route list with live counts (0 for a
              route with nothing running right now). Still clickable even
              at 0 - the map will just show nothing for it currently. */}
          <div className="px-3 py-1.5 border-b border-white/10 font-medium text-white/60">
            All routes ({allRouteRows.filter((r) => r.count > 0).length} active of {allRouteRows.length})
          </div>
          {allRouteRows.map((r) => (
            <button
              key={r.routeId}
              onClick={() => setRouteFilter(r.routeId)}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-white/10 border-b border-white/10 last:border-0 ${
                routeFilter === r.routeId ? 'bg-white/10' : ''
              } ${r.count === 0 ? 'opacity-40' : ''}`}
            >
              <span className="font-medium text-white/80">Route {r.routeId}</span>
              <span className="text-white/40 shrink-0">
                {r.count > 0 ? `${r.count} vehicles` : 'inactive'}
              </span>
            </button>
          ))}
        </div>
      )}
      {/* #3 bus bunching (2026-09-05): vehicles on the exact same shape
          (route + direction) closer together than BUNCHING_THRESHOLD_METERS.
          Real headway only for now - no comparison against scheduled
          headway yet, see the comment on bunchingAlerts above. */}
      {showBunching && (
        <div className="text-sm">
          {/* Headline (2026-09-08, Ross's ask - every panel leads with an
              overall figure before the granular list). */}
          <div className="px-3 py-2 border-b border-white/10 sticky top-0 bg-slate-950/85">
            <div className="font-display text-[11px] uppercase tracking-wide text-white/40">Bunching alerts</div>
            <span
              className={`font-display text-lg font-semibold ${bunchingAlerts.length > 0 ? 'text-amber-600' : 'text-white'}`}
            >
              {bunchingAlerts.length}
            </span>
            {bunchingHeadline && (
              <>
                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-xs text-white/40">{bunchingHeadline.affectedRouteCount} routes affected</span>
                  <span className="text-xs text-white/40">worst: Route {bunchingHeadline.worstRouteId}</span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-white/40">
                    tightest {formatDistance(bunchingHeadline.worstGapMeters)}
                  </span>
                  <span className="text-xs text-white/40">
                    avg {formatDistance(bunchingHeadline.avgGapMeters)}
                  </span>
                </div>
              </>
            )}
          </div>
          {bunchingAlerts.length === 0 ? (
            <div className="px-3 py-2 text-white/40">No bunching detected right now</div>
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
                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-white/10 border-b border-white/10 last:border-0"
              >
                <span className="font-medium text-white/80">
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
        <div className="text-sm border-b border-white/10">
          {onTimeSummary && (
            <div className="px-3 py-2 border-b border-white/10 sticky top-0 bg-slate-950/85">
              <div className="font-display text-[11px] uppercase tracking-wide text-white/40">
                Network median (n={onTimeSummary.n})
              </div>
              <div className="flex items-baseline justify-between">
                <span
                  className={`font-display text-lg font-semibold ${
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
                <span className="text-xs text-white/40">
                  range {onTimeSummary.min > 0 ? '+' : ''}
                  {onTimeSummary.min}m to {onTimeSummary.max > 0 ? '+' : ''}
                  {onTimeSummary.max}m
                </span>
              </div>
              <div className="flex items-baseline gap-2 mt-1 text-xs">
                <span className="text-green-600 font-medium">{onTimeSummary.onTimeCount} on time</span>
                <span className="text-red-600 font-medium">{onTimeSummary.lateCount} late</span>
                <span className="text-blue-600 font-medium">{onTimeSummary.earlyCount} early</span>
              </div>
            </div>
          )}
          {onTimeWithCongestion.length === 0 ? (
            <div className="px-3 py-2 text-white/40">
              No stopped vehicles with a schedule match right now
            </div>
          ) : (
            onTimeWithCongestion.map((entry) => (
              <button
                key={entry.vehicleId}
                onClick={() => {
                  setSelectedId(entry.vehicleId);
                  const entity = entitiesRef.current.get(entry.vehicleId);
                  const viewer = viewerRef.current;
                  if (entity && viewer) void viewer.flyTo(entity);
                }}
                className="w-full flex flex-col gap-0.5 px-3 py-2 text-left hover:bg-white/10 border-b border-white/10 last:border-0"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-white/80">
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
                </div>
                {/* Nearby road congestion (2026-09-08, Ross's ask: "use the
                    congestion to measure latency of busses") - only shown
                    when a road segment with a live reading is actually
                    close by (see CONGESTION_NEARBY_RADIUS_METERS), so a
                    vehicle with nothing nearby just shows nothing extra
                    rather than a misleading "no congestion" default. */}
                {entry.nearby && (
                  <div className="text-[11px] text-white/40 truncate">
                    Nearby: {entry.nearby.link.name} · congestion score {entry.nearby.stats.score}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      )}
          </aside>
        )}
      </div>
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
    </div>
  );
}
