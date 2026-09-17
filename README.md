# Canberra Pulse — live transit digital twin for the ACT

A real-time 3D map of Canberra's bus and light rail network, built on
Microsoft Fabric. Live vehicle positions render on a Cesium globe,
map-matched onto real road and rail geometry, alongside live on-time
performance, road congestion, and a historic trends view built from weeks of
continuous capture. Built for **Canberra Data Week 2026**.

> Adapted from [**Harbour Pulse**](https://github.com/FranGenoa/fabric-harbour-pulse)
> by FranGenoa (MIT licensed) — the same Fabric Eventstream → Eventhouse →
> Rayfin app shape, retargeted from Sydney ferries to ACT buses and light
> rail. Full credit in [ATTRIBUTION.md](ATTRIBUTION.md).

## What it does

- **Live tracking** — every bus and light rail vehicle, polled every few
  minutes from Transport Canberra's GTFS-realtime feed, map-matched onto its
  actual route geometry rather than raw GPS noise.
- **On-time performance** — a live punctuality gauge and delay histogram
  computed client-side against the real published schedule, plus a
  network-wide on-time trend over the whole capture window.
- **Road congestion** — a live overlay of ~725 road segments (speed, delay,
  congestion score) from ACT's public traffic-detector network, and a named
  leaderboard of the worst-performing segments over time.
- **Historic trends** — hourly aggregates over the full capture window: bus
  vs. light rail reliability, best/worst routes by on-time performance, and
  a weekday/weekend toggle across every chart.
- **Near me** — geolocation-based nearest-vehicle list with live distance and
  ETA.
- **Population overlay** — ABS 2021 Census population by SA1, for a rough
  service-availability lens over where people actually live.

## Why it matters

An agency running fixed-route transit usually already has this data
somewhere — a GPS feed, a timetable, a traffic API. What's missing is one
place to see it together, and a way to ask questions across it over time
rather than in the moment.

- **On-time running becomes measurable, not anecdotal.** Every position is
  retained alongside the published schedule, so "is Route 5 actually less
  reliable than Route 2" is a query, not an impression.
- **Congestion gets attributed to a place, not a vibe.** The worst segments
  in a capture window can be named and mapped to a real intersection, not
  just shown as a colour on a heatmap.
- **The pattern isn't transit-specific.** Anything emitting position or
  condition telemetry — council fleets, waste trucks, field crews — fits the
  same shape: a real-time store, a live operational view, and a historic
  trend layer that costs nothing extra to query.

## Architecture

```
Transport Canberra GTFS-realtime  ─┐
ACT Addinsight traffic API         ├─▶ Fabric notebooks (polling, on schedule)
Transport Canberra GTFS-static    ─┘         │
                                              ▼
                                   Eventstream → Eventhouse (KQL database)
                                              │
                                              ▼
                          Rayfin app (React 19 + Vite + Cesium)
                          Fabric SSO for identity, static hosting to serve it
                          Browser queries the Eventhouse directly via MSAL
```

Three notebooks (`ACTBusEventLoader`, `ACTStopIdLoader`, `ACTTrafficLoader`)
each poll their feed and land rows in Kusto on a 5-minute Fabric schedule.
The app never talks to the source feeds directly — it queries the Eventhouse
as the signed-in user, so there's no service account and no data the app can
see that the user couldn't already query themselves.

## Running it locally

There's no one-script provisioning path yet (unlike Harbour Pulse's own
`provision-environment.ps1`) — Fabric-side setup here has so far been done by
hand. Roughly, you'll need:

1. **A Fabric workspace and capacity** (an F-SKU or trial capacity), with an
   Eventhouse and KQL database created in it.
2. **A Transport Canberra GTFS developer key** — free, via the [developer
   portal](https://www.transport.act.gov.au/contact-us/information-for-developers).
3. **The three loader notebooks** deployed into the workspace and scheduled
   (5-minute cadence is what this project runs on), landing into an
   Eventstream → Eventhouse pipeline.
4. **A Rayfin app registration** in Microsoft Entra for the frontend's own
   sign-in, plus a separate Entra app (or scope) for direct browser-to-Kusto
   queries — see `kustoClient.ts` for why these are independent.
5. **(Optional) a Cesium ion token** for photorealistic terrain/imagery;
   the app falls back to keyless OpenStreetMap tiles without one.

Once those exist and `.env` is populated (see `.env.example`):

```bash
npm ci
npm run dev        # provisions Rayfin services, then starts the dev server
```

Or, to iterate against an already-provisioned environment without touching
Rayfin's own services each time:

```bash
npm run dev:local  # plain `vite`, using the existing .env / .env.local
```

## License

MIT — see [LICENSE](LICENSE). Third-party data, imagery and font licences
are listed separately in [ATTRIBUTION.md](ATTRIBUTION.md), since they don't
share the code's licence. See [SECURITY.md](SECURITY.md) for this app's
trust model and what is/isn't a secret.
