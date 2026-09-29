# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ### ACTStopIdLoader
# - Fetches vehicles currently STOPPED_AT a stop, from the same GTFS-Realtime feed as ACTBusEventLoader
# - Computes `delay_minutes` (scheduled vs actual) against the static GTFS schedule (`stop_times.txt`)
# - Writes straight to Kusto (`BusStopObservations`) via REST - no SDK, no Eventstream
# - Single poll-and-exit per run - a Fabric Schedule triggers it every 5 minutes
# - Re-raises on error so a failed run shows up as Failed in job history
#
# Repo copy (2026-09-29): credentials read from environment variables
# (TC_GTFS_CLIENT_ID, TC_GTFS_CLIENT_SECRET) instead of the hardcoded values
# the deployed Fabric copy currently has - same pattern the original Harbour
# Pulse project this was adapted from already used. Set these in the
# notebook's own environment/Fabric variable library before running;
# nothing sensitive lives in this file.

# MARKDOWN ********************

# Imports, plus the GTFS feed credentials/URL and the Kusto target table.

# CELL ********************

import os
import io
import time
import base64
import zipfile
from datetime import datetime, timezone

import requests
from google.transit import gtfs_realtime_pb2

# Transport Canberra GTFS-R API - same credentials as ACTBusEventLoader
TC_GTFS_CLIENT_ID = os.getenv("TC_GTFS_CLIENT_ID")
TC_GTFS_CLIENT_SECRET = os.getenv("TC_GTFS_CLIENT_SECRET")
FEED_URL = "https://transport.api.act.gov.au/gtfs/data/gtfs/v2/vehicle-positions-mywayplus.pb"
GTFS_STATIC_URL = "https://transport.api.act.gov.au/gtfs/data/gtfs/v2/gtfs.zip"

KUSTO_CLUSTER = "https://trd-g7u62jus0m1zuhuz74.z5.kusto.fabric.microsoft.com"
KUSTO_DATABASE = "ACTGovEventHouse"
KUSTO_STOP_TABLE = "BusStopObservations"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# Helpers: load the static schedule, convert timestamps, find stopped vehicles, and write to Kusto.

# CELL ********************

def basic_auth_headers():
    token = base64.b64encode(f"{TC_GTFS_CLIENT_ID}:{TC_GTFS_CLIENT_SECRET}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def parse_gtfs_time_to_seconds(t):
    # "HH:MM:SS" - hours can exceed 24 for an after-midnight trip on
    # yesterday's service day. Same convention already used by the web
    # app's own build-time GTFS parsing (vite/gtfsStopArrivals.ts).
    h, m, s = t.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def load_schedule():
    # (trip_id, stop_id) -> scheduled arrival, seconds since midnight local
    # time. Confirmed directly before writing this (2026-09-08): real ACT
    # stop_times.txt is UTF-8 with a BOM - naive utf-8 decoding leaves the
    # BOM stuck to the first header name ("trip_id" fails to match), so
    # this must be utf-8-sig, not utf-8.
    response = requests.get(GTFS_STATIC_URL, headers=basic_auth_headers(), timeout=60)
    response.raise_for_status()
    zf = zipfile.ZipFile(io.BytesIO(response.content))
    with zf.open("stop_times.txt") as f:
        lines = f.read().decode("utf-8-sig").splitlines()
    header = lines[0].split(",")
    idx_trip = header.index("trip_id")
    idx_arrival = header.index("arrival_time")
    idx_stop = header.index("stop_id")
    schedule = {}
    for line in lines[1:]:
        parts = line.split(",")
        if len(parts) <= max(idx_trip, idx_arrival, idx_stop):
            continue
        try:
            schedule[(parts[idx_trip], parts[idx_stop])] = parse_gtfs_time_to_seconds(parts[idx_arrival])
        except Exception:
            continue
    return schedule


def canberra_seconds_since_midnight(unix_ts):
    # GTFS schedule times are in the agency's local timezone, not UTC - the
    # feed's own timestamp is UTC, so this conversion is required, not
    # optional. Confirmed directly (2026-09-08) that relying on ambient
    # system-local time instead of an explicit timezone is a real trap:
    # a dev machine that happens to already be set to Australian time
    # would silently hide this, while a Fabric Spark cluster (almost
    # certainly UTC internally) would silently corrupt every delay value
    # by ~10-11 hours. ZoneInfo handles the AEST/AEDT daylight-saving
    # transition correctly, which a fixed UTC+10 offset would not.
    try:
        from zoneinfo import ZoneInfo
        local = datetime.fromtimestamp(unix_ts, tz=ZoneInfo("Australia/Canberra"))
        return local.hour * 3600 + local.minute * 60 + local.second
    except Exception as e:
        # Loud, not silent - if this ever fires, delay_minutes for this
        # batch is wrong and should be treated as such, not trusted quietly.
        print(f"{datetime.now()}: WARNING - Australia/Canberra tzdata unavailable ({e}), delay_minutes will be skipped this batch")
        return None


def fetch_stopped_observations(schedule):
    response = requests.get(FEED_URL, headers=basic_auth_headers(), timeout=15)
    response.raise_for_status()

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(response.content)

    # current_status == 1 is STOPPED_AT - confirmed directly against the real
    # feed earlier this session, used as the raw int here (not the enum name)
    # to avoid any risk of getting an enum reference wrong in a notebook that
    # only imports gtfs_realtime_pb2 for this one field.
    observations = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        v = entity.vehicle
        if v.current_status != 1 or not v.stop_id:
            continue
        ts = v.timestamp if v.timestamp else int(time.time())
        vehicle_id = v.vehicle.label or v.vehicle.id
        timestamp = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        delay_minutes = None
        scheduled_secs = schedule.get((v.trip.trip_id, v.stop_id))
        if scheduled_secs is not None:
            actual_secs = canberra_seconds_since_midnight(ts)
            if actual_secs is not None:
                delay_minutes = round((actual_secs - scheduled_secs) / 60)

        observations.append((vehicle_id, v.stop_id, timestamp, delay_minutes))
    return observations


def send_to_kusto(observations):
    if not observations:
        return
    # 2026-09-09: plain REST call, no SDK - see the notebook-level comment
    # above for why. Same pattern as ACTTrafficLoader's send_to_kusto().
    token = notebookutils.credentials.getToken(KUSTO_CLUSTER)
    # Empty field = null for a nullable int column - a trip/stop pair with
    # no schedule match (e.g. a trip pattern that changed since the static
    # file was fetched) still gets its position observation recorded, just
    # without a delay figure, rather than being dropped outright.
    rows = "\n".join(
        f"{vid},{stop},{ts},{'' if delay is None else delay}"
        for vid, stop, ts, delay in observations
    )
    body = f".ingest inline into table {KUSTO_STOP_TABLE} <|\n{rows}"
    resp = requests.post(
        f"{KUSTO_CLUSTER}/v1/rest/mgmt",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"db": KUSTO_DATABASE, "csl": body},
        timeout=30,
    )
    resp.raise_for_status()

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# Run once: load the schedule, fetch stopped vehicles, send them, log the result.

# CELL ********************

# Re-fetched every run now rather than once per long-lived session (was
# amortised over ~240 polls/hour; now it's one fetch per 5-minute
# scheduled run) - a real but minor cost of moving to poll-and-exit, not
# worth a caching layer for a reference file this small and infrequently
# updated. Loud on failure, same as everything else below now.
print("Loading static GTFS schedule (stop_times.txt) for delay computation...")
schedule = load_schedule()
print(f"Loaded {len(schedule)} scheduled (trip_id, stop_id) arrivals")

try:
    observations = fetch_stopped_observations(schedule)
    send_to_kusto(observations)
    matched = sum(1 for o in observations if o[3] is not None)
    print(f"{datetime.now()}: Sent {len(observations)} stop observations ({matched} with a delay figure)")
except Exception as e:
    print(f"{datetime.now()}: Error - {e}")
    raise

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
