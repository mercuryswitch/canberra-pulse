# Security

This is a demonstration project, built for Canberra Data Week. It is not a
supported product and carries no service-level or patching commitment.

## Reporting a vulnerability

Please open a [security advisory](https://github.com/mercuryswitch/canberra-pulse/security/advisories/new)
rather than a public issue. Include what you found, how to reproduce it, and
what an attacker could do with it.

## What this app trusts

- **Identity comes from Microsoft Entra.** There is no local account store,
  no password handling and no session of our own. The Fabric portal session
  or an MSAL token is the only credential in play.
- **Eventhouse queries run as the signed-in user.** The browser holds a
  delegated token and Kusto enforces that user's permissions. The app cannot
  read anything the user could not read directly, and there is no service
  account to steal.

## Secrets

No credential is committed to this repository — `.env`, `.env.local` and
`rayfin/.env` are all git-ignored, and this history has been checked to
confirm none was ever committed.

- **`TC_GTFS_CLIENT_ID` / `TC_GTFS_CLIENT_SECRET`** are the one real secret
  pair in this app. They authenticate to Transport Canberra's GTFS API and
  are used **only at build time**, inside `vite/gtfsShapes.ts` and
  `vite/gtfsStopArrivals.ts`, to bake static schedule/shape data into the
  production bundle. They deliberately carry no `VITE_` prefix — giving them
  one would bake them into the browser bundle, which must never happen.
- **The live bus/rail positions and traffic feeds are pulled inside Fabric
  notebooks** (`ACTBusEventLoader`, `ACTStopIdLoader`, `ACTTrafficLoader`),
  which run in your own Fabric workspace. Their source is included under
  [`fabric/`](fabric/README.md) for transparency, but every credential they
  need (`TC_GTFS_CLIENT_ID`, `TC_GTFS_CLIENT_SECRET`,
  `EVENTSTREAM_CONNECTION_STRING`) is read from an environment variable at
  runtime, never embedded in the committed notebook source - see
  `fabric/README.md` for the exact variables each notebook needs.
- **`VITE_ENTRA_CLIENT_ID`, `VITE_ENTRA_TENANT_ID`, `VITE_KUSTO_CLUSTER`,
  `VITE_KUSTO_DATABASE`, and the `VITE_FABRIC_*` / `VITE_RAYFIN_*`
  identifiers are not secrets.** They identify the author's Fabric
  environment, are already served in the app's public JavaScript bundle by
  necessity, and grant nothing without an authenticated, authorised Entra
  identity behind them — exactly the reasoning Harbour Pulse documents for
  the same class of values.
- **`VITE_CESIUM_ION_TOKEN` is the one `VITE_`-prefixed value worth active
  care**, since a Cesium ion token has to ship client-side to work at all. If
  you deploy this publicly, scope your token to your app's specific
  origin(s) in the [Cesium ion dashboard](https://ion.cesium.com/tokens)
  first, so a copied token can't be reused elsewhere against your account's
  quota.
