# Fabric notebooks

The three Fabric notebooks Canberra Pulse's data pipeline runs on, exported
as git-tracked definitions.

| Folder | What it does |
| --- | --- |
| `ACTBusEventLoader.Notebook` | Polls Transport Canberra's GTFS-realtime feed and pushes bus/rail positions into the `ACT_BUS` Eventstream. |
| `ACTStopIdLoader.Notebook` | Finds currently-stopped vehicles from the same feed, computes on-time delay against the static schedule, and writes straight to the `BusStopObservations` Kusto table. |
| `ACTTrafficLoader.Notebook` | Polls ACT's public Addinsight road-sensor API and writes straight to the `TrafficLinkStats` Kusto table. |

Each runs standalone, on its own 5-minute Fabric Schedule - see the
`### `-prefixed markdown cell at the top of each `notebook-content.py` for
what it does and why.

## Credentials

`ACTBusEventLoader` and `ACTStopIdLoader` both read Transport Canberra's
GTFS-realtime API credentials from environment variables rather than
embedding them:

```
TC_GTFS_CLIENT_ID
TC_GTFS_CLIENT_SECRET
```

`ACTBusEventLoader` additionally reads:

```
EVENTSTREAM_CONNECTION_STRING
```

the connection string for the `ACT_BUS` Eventstream's custom endpoint (Fabric
portal - the Eventstream item - custom endpoint details). Set these in the
notebook's own environment or the workspace's variable library before
running; nothing sensitive lives in this folder.

`ACTTrafficLoader` needs no credentials - the Addinsight API is public, and
its Kusto write uses a token acquired at runtime via
`notebookutils.credentials.getToken()`, not a stored secret.

## Not covered here

Unlike the original Harbour Pulse project this was adapted from, this folder
does not (yet) include:

- **The Eventhouse, Eventstream, and KQL database item definitions** - just
  the notebooks. The Kusto schema (`EventSchemaBUS_v1`, `BusStopObservations`,
  `TrafficLinkStats`) isn't exported here.
- **A `deploy.py` / `parameter.yml` rebind pipeline** for pushing these into
  a fresh workspace. These notebooks currently reference one specific
  workspace's Kusto cluster URI directly (not a secret, but not portable
  either) - redeploying elsewhere means updating `KUSTO_CLUSTER` by hand.
- **A Fabric Schedule definition.** The 5-minute cadence each notebook runs
  on is configured in the Fabric portal, not exported as part of the item
  definition.

This folder exists for transparency and reference - to show exactly what the
data pipeline behind the live app does - not as a one-command redeploy.
