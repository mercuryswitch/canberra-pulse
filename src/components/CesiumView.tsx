import {
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
  LinearApproximation,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  Quaternion,
  SampledPositionProperty,
  SampledProperty,
  Terrain,
  Transforms,
  Viewer,
  type Entity,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useEffect, useMemo, useRef, useState } from 'react';

import { type BusPosition, fetchBuses } from '@/services/busService';
import { connectDataInteractive, KustoInteractionRequiredError } from '@/services/kustoClient';
import { getShapeForTrip, haversineMeters, preloadShapes, snapToShape } from '@/services/shapeService';

// Optional: a free Cesium Ion token (ion.cesium.com) unlocks world terrain and
// Google Photorealistic 3D Tiles. Without it we fall back to keyless
// OpenStreetMap imagery on a plain ellipsoid - fine for an MVP.
const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN;

const CANBERRA = { lon: 149.13, lat: -35.28, height: 15000 };
const POLL_MS = 8_000;

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
// Best guess at the correction below - flip the sign if it's backwards.
const MODEL_HEADING_OFFSET_DEG = 90;
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

function VehiclePanel({ bus, onClose }: { bus: BusPosition; onClose: () => void }) {
  const rows: [string, string][] = [
    ['Vehicle', bus.id],
    ['Type', isLightRail(bus.id) ? 'Light rail' : 'Bus'],
    ['Route', bus.routeId],
    ['Trip', bus.tripId],
    ['Status', STATUS_LABEL[bus.status] ?? bus.status],
    ['Position', `${bus.lat.toFixed(5)}, ${bus.lon.toFixed(5)}`],
    ['Last update', new Date(bus.ts).toLocaleTimeString()],
  ];
  return (
    <div className="absolute left-4 top-20 bottom-4 z-30 w-72 rounded-2xl border border-white/10 bg-slate-950/85 text-white shadow-2xl backdrop-blur-xl overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <span className="font-medium text-sm">Vehicle {bus.id}</span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-white/50 hover:text-white transition-colors text-lg leading-none"
        >
          &times;
        </button>
      </div>
      <div className="p-4 flex flex-col gap-3">
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
  const positionsRef = useRef<Map<string, SampledPositionProperty>>(new Map());
  const orientationsRef = useRef<Map<string, SampledProperty>>(new Map());
  const lastSampleTsRef = useRef<Map<string, number>>(new Map());
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
    if (ION_TOKEN) {
      void createGooglePhotorealistic3DTileset()
        .then((ts) => viewer.scene.primitives.add(ts))
        .catch(() => {
          void createOsmBuildingsAsync()
            .then((ts) => viewer.scene.primitives.add(ts))
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

  // The poll loop below has an empty dependency array (it's a long-lived
  // interval, not something to restart on every filter click), so it reads
  // the current filter through this ref rather than a stale closure value.
  const filterTypeRef = useRef(filterType);
  useEffect(() => {
    filterTypeRef.current = filterType;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const visible: Entity[] = [];
    for (const [id, entity] of entitiesRef.current) {
      const show = filterType === 'all' || (filterType === 'rail') === isLightRail(id);
      entity.show = show;
      if (show) visible.push(entity);
    }
    if (filterType !== 'all' && visible.length > 0) void viewer.flyTo(visible);
  }, [filterType]);

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

  // #11 "next vehicle near me": every currently-active vehicle, sorted by
  // straight-line distance from the browser's own geolocation. Reuses the
  // same busDataRef the type-filter list reads from - no new data pipeline,
  // just a different sort/slice over data we're already polling.
  const nearestList = useMemo(() => {
    if (!nearMeActive || !userLocation) return [];
    return Array.from(busDataRef.current.values())
      .map((b) => ({
        bus: b,
        distance: haversineMeters(userLocation.lat, userLocation.lon, b.lat, b.lon),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- busDataRef is a
    // ref; pollTick is the actual trigger for recomputing this each poll.
  }, [nearMeActive, userLocation, pollTick]);

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

          // A SampledPositionProperty holds real fixes over time and, with
          // extrapolation on, keeps moving the entity along the last known
          // velocity between polls instead of snapping every 8s. The moment
          // a genuinely new real fix arrives (addSample below), it's ground
          // truth again - no manual "fake vs real" reconciliation needed.
          let sampledPosition = positionsRef.current.get(bus.id);
          if (!sampledPosition) {
            sampledPosition = new SampledPositionProperty();
            // EXTRAPOLATE (not HOLD) so position keeps gliding smoothly
            // between real fixes - the browser's clock is always slightly
            // ahead of the latest real sample (feed/network latency), so
            // we're *always* in "past the last sample" territory, never
            // genuinely interpolating between two brackets. HOLD there
            // means literally freezing until the next real sample lands,
            // then snapping - which is what "movement lost, just snapping"
            // was. Duration matches busService.ts's own 5-minute active
            // window, so anything still considered active never goes
            // *undefined* (the original light-rail-invisible bug) either -
            // it just extrapolates further than usual on the rare vehicle
            // that reports sparsely, which still looks like motion rather
            // than nothing.
            sampledPosition.forwardExtrapolationType = ExtrapolationType.EXTRAPOLATE;
            sampledPosition.forwardExtrapolationDuration = 300;
            sampledPosition.setInterpolationOptions({
              interpolationDegree: 1,
              interpolationAlgorithm: LinearApproximation,
            });
            positionsRef.current.set(bus.id, sampledPosition);
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

          // Only add a sample when the feed's own reported timestamp has
          // actually advanced - a repeat poll of an unchanged fix shouldn't
          // reset the velocity estimate Cesium derives between samples.
          if (lastSampleTsRef.current.get(bus.id) !== bus.ts) {
            // Map-match onto the trip's actual route geometry when we have
            // it, so the vehicle sits on the road/track instead of
            // wherever raw GPS noise placed it. Falls back to the raw fix
            // for any trip_id not found in the static snapshot (e.g. a
            // trip pattern that changed since the snapshot was built).
            let lat = bus.lat;
            let lon = bus.lon;
            const shape = await getShapeForTrip(bus.tripId);
            if (shape) {
              const snapped = snapToShape(shape, bus.lat, bus.lon);
              lat = snapped.lat;
              lon = snapped.lon;
            }
            const position = Cartesian3.fromDegrees(lon, lat);

            sampledPosition.addSample(sampleTime, position);
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
              position: sampledPosition,
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
            entity.show =
              filterTypeRef.current === 'all' ||
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

  return (
    <div className="relative w-full h-screen">
      <div ref={containerRef} className="w-full h-full" />
      <div className="absolute top-4 left-4 bg-white/90 rounded-lg px-2 py-2 text-sm text-gray-700 shadow flex items-center gap-1">
        <button
          onClick={() => {
            if (nearMeActive) toggleNearMe();
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
          onClick={toggleNearMe}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${
            nearMeActive ? 'bg-gray-900 text-white' : 'hover:bg-gray-100'
          }`}
        >
          <span aria-hidden>📍</span>
          Near me
        </button>
      </div>
      {nearMeActive && (
        <div className="absolute top-16 left-4 z-20 w-64 max-h-[60vh] overflow-y-auto bg-white/95 rounded-lg shadow text-sm">
          {!userLocation ? (
            <div className="px-3 py-2 text-gray-400">
              {locationError ?? 'Finding your location…'}
            </div>
          ) : nearestList.length === 0 ? (
            <div className="px-3 py-2 text-gray-400">No vehicles right now</div>
          ) : (
            nearestList.map(({ bus, distance }) => (
              <button
                key={bus.id}
                onClick={() => {
                  setSelectedId(bus.id);
                  const entity = entitiesRef.current.get(bus.id);
                  const viewer = viewerRef.current;
                  if (entity && viewer) void viewer.flyTo(entity);
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-gray-100 border-b border-gray-100 last:border-0"
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{
                      backgroundColor: isLightRail(bus.id) ? TYPE_COLOR.rail : TYPE_COLOR.bus,
                    }}
                  />
                  <span className="font-medium">{bus.id}</span>
                  <span className="text-gray-400 text-xs">route {bus.routeId}</span>
                </span>
                <span className="text-gray-500 text-xs shrink-0">{formatDistance(distance)}</span>
              </button>
            ))
          )}
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
      {selectedBus && (
        <VehiclePanel
          bus={selectedBus}
          onClose={() => {
            setSelectedId(null);
            if (viewerRef.current) viewerRef.current.selectedEntity = undefined;
          }}
        />
      )}
      {needsConnect && (
        <button
          onClick={() => void connectDataInteractive()}
          className="absolute top-4 right-4 bg-gray-900 text-white rounded-lg px-4 py-2 text-sm"
        >
          Connect live data
        </button>
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
