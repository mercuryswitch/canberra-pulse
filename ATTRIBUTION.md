# Attribution

## Architecture and patterns

This project's shape — a Fabric Real-Time Intelligence Eventhouse fed by a
polling notebook, a Rayfin app for identity and hosting, and a browser client
that authenticates to Kusto directly via MSAL — is adapted from
[**Harbour Pulse**](https://github.com/FranGenoa/fabric-harbour-pulse) by
**FranGenoa**, used under its MIT licence. Several implementation patterns
carry over closely, including the Entra/Kusto browser authentication flow
(`kustoClient.ts`) and the general Rayfin project structure. Harbour Pulse's
own `LICENSE` and copyright notice are preserved wherever its code was
adapted closely rather than rewritten from scratch.

## Data

- **Transport Canberra GTFS (static and real-time)** — bus and light rail
  schedules, shapes, and live vehicle positions. Released under
  [**CC BY**](https://www.transport.act.gov.au/contact-us/information-for-developers)
  by Transport Canberra. Requires a free developer access key; see the
  README.
- **ACT Government open data**, more broadly — published under the
  [ACT Government's Proactive Release of Data (Open Data) Policy](https://www.cmtedd.act.gov.au/__data/assets/pdf_file/0011/859430/2016-Proactive-Release-of-Data-Open-Data-Policy.pdf),
  generally **CC BY 4.0**.
- **ACT road congestion data** — per-segment speed, delay and congestion
  score, from the public Addinsight Bluetooth-detector API
  (`data.addinsight.com`). This is an unauthenticated third-party vendor
  endpoint, not an `act.gov.au` domain, and no published redistribution terms
  were found for it. Used here for research/demonstration purposes; if
  you're relying on it for anything beyond that, verify directly with
  Addinsight first.
- **Population by SA1** — [Australian Bureau of Statistics, 2021 Census
  (G01)](https://geo.abs.gov.au/arcgis/rest/services/Hosted/ABS_2021_Census_G01_SA1/FeatureServer/0),
  used under the ABS's **CC BY 4.0** licence for Census data products.

## Imagery, terrain and 3D tiles

- **Cesium ion** — terrain, imagery and Google Photorealistic 3D Tiles when a
  Cesium ion token is configured, under [Cesium's Terms of
  Service](https://cesium.com/legal/terms-of-service/).
- **OpenStreetMap** — fallback raster imagery and building footprints when no
  Cesium ion token is present, under the
  [Open Database Licence (ODbL)](https://www.openstreetmap.org/copyright).

## Fonts

- **Inter** and **Space Grotesk**, served via Google Fonts, under the [SIL
  Open Font License](https://scripts.sil.org/OFL).
