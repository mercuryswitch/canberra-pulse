# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ### ACTBusEventLoader
# - Fetches live bus positions from Transport Canberra's GTFS-Realtime feed
# - Sends each position as an event into the ACT_BUS Fabric Eventstream
# - Single poll-and-exit per run - a Fabric Schedule triggers it every 5 minutes
# - Re-raises on error so a failed run shows up as Failed in job history
#
# Repo copy (2026-09-29): credentials read from environment variables
# (TC_GTFS_CLIENT_ID, TC_GTFS_CLIENT_SECRET, EVENTSTREAM_CONNECTION_STRING)
# instead of the hardcoded values the deployed Fabric copy currently has -
# same pattern the original Harbour Pulse project this was adapted from
# already used. Set these in the notebook's own environment/Fabric variable
# library before running; nothing sensitive lives in this file.

# MARKDOWN ********************

# Install the packages this notebook needs.

# CELL ********************

%pip install requests protobuf gtfs-realtime-bindings azure-eventhub --q


# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "frozen": true,
# META   "editable": false
# META }

# MARKDOWN ********************

# Imports, plus the GTFS feed credentials/URL and Eventstream connection details.

# CELL ********************

import os
import json
import time
import uuid
import base64
from datetime import datetime, timezone

import requests
from azure.eventhub import EventData, EventHubProducerClient
from google.transit import gtfs_realtime_pb2

# Transport Canberra GTFS-R API
TC_GTFS_CLIENT_ID = os.getenv("TC_GTFS_CLIENT_ID")
TC_GTFS_CLIENT_SECRET = os.getenv("TC_GTFS_CLIENT_SECRET")
FEED_URL = "https://transport.api.act.gov.au/gtfs/data/gtfs/v2/vehicle-positions-mywayplus.pb"

# Fabric Eventstream - ACT_BUS custom endpoint
EVENTSTREAM_CONNECTION_STRING = os.getenv("EVENTSTREAM_CONNECTION_STRING")
CLOUDEVENT_TYPE = "EventSchemaBUS"
CLOUDEVENT_SOURCE = "workspace//eventstream/"
CLOUDEVENT_DATASCHEMA = "https://rthprodsy15227159.australiaeast.messagingcatalog.azure.net/schemagroups/279733da-e151-4f53-b577-aa5510e1645b/schemas/EventSchemaBUS/versions/v1"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# `fetch_bus_positions()` pulls and parses the live GTFS-R feed; `send_events()` batches and sends them to the Eventstream.

# CELL ********************

def fetch_bus_positions():
    token = base64.b64encode(f"{TC_GTFS_CLIENT_ID}:{TC_GTFS_CLIENT_SECRET}".encode()).decode()
    headers = {"Authorization": f"Basic {token}"}
    response = requests.get(FEED_URL, headers=headers, timeout=15)
    response.raise_for_status()

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(response.content)

    positions = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        v = entity.vehicle
        ts = v.timestamp if v.timestamp else int(time.time())
        positions.append({
            "vehicle_id": v.vehicle.label or v.vehicle.id,
            "route_id": v.trip.route_id,
            "trip_id": v.trip.trip_id,
            "latitude": v.position.latitude,
            "longitude": v.position.longitude,
            "bearing": v.position.bearing,
            "current_status": gtfs_realtime_pb2.VehiclePosition.VehicleStopStatus.Name(v.current_status),
            "stop_id": v.stop_id,
            "timestamp": datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
    return positions


def send_events(positions):
    producer = EventHubProducerClient.from_connection_string(EVENTSTREAM_CONNECTION_STRING)
    with producer:
        batch = producer.create_batch()
        for pos in positions:
            event = EventData(json.dumps(pos).encode("utf-8"))
            event.content_type = "application/json"
            event.properties = {
                "cloudEvents:id": str(uuid.uuid4()),
                "cloudEvents:source": CLOUDEVENT_SOURCE,
                "cloudEvents:specversion": "1.0",
                "cloudEvents:type": CLOUDEVENT_TYPE,
                "cloudEvents:datacontenttype": "application/json",
                "cloudEvents:dataschema": CLOUDEVENT_DATASCHEMA,
            }
            try:
                batch.add(event)
            except ValueError:
                producer.send_batch(batch)
                batch = producer.create_batch()
                batch.add(event)
        if len(batch) > 0:
            producer.send_batch(batch)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# Run once: fetch positions, send them, log the result.

# CELL ********************

try:
    positions = fetch_bus_positions()
    send_events(positions)
    print(f"{datetime.now()}: Successfully sent {len(positions)} bus positions")
except Exception as e:
    print(f"{datetime.now()}: Error - {e}")
    raise

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
