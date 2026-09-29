# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ### ACTTrafficLoader
# - Fetches live road congestion stats from ACT's Addinsight Bluetooth-detector API
# - Writes straight to Kusto (`TrafficLinkStats`) via REST - no SDK, no pip install
# - Single poll-and-exit per run - a Fabric Schedule triggers it every 5 minutes
# - Re-raises on error so a failed run shows up as Failed in job history
#
# Repo copy (2026-09-29): unchanged from the deployed Fabric copy - this
# notebook never held a credential to begin with (the Addinsight API needs
# no auth, and the Kusto write uses a token acquired at runtime via
# notebookutils.credentials.getToken(), not a stored secret).

# MARKDOWN ********************

# Imports, plus the Addinsight API URL and the Kusto target table.

# CELL ********************

import time
import requests
from datetime import datetime

LINKS_STATS_URL = "http://data.addinsight.com/ACT/links_stats.json"

KUSTO_CLUSTER = "https://trd-g7u62jus0m1zuhuz74.z5.kusto.fabric.microsoft.com"
KUSTO_DATABASE = "ACTGovEventHouse"
KUSTO_TABLE = "TrafficLinkStats"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# MARKDOWN ********************

# `fetch_link_stats()` pulls the live stats; `send_to_kusto()` writes them via Kusto's REST endpoint.

# CELL ********************

def fetch_link_stats():
    response = requests.get(LINKS_STATS_URL, timeout=15)
    response.raise_for_status()
    return response.json()


def send_to_kusto(records):
    if not records:
        return
    token = notebookutils.credentials.getToken(KUSTO_CLUSTER)
    rows = []
    for r in records:
        # IntervalStart already carries its own +10:00/+11:00 offset (AEST/
        # AEDT) - Kusto's datetime parser handles an offset-qualified
        # ISO 8601 string directly, no manual timezone conversion needed
        # here (contrast with ACTStopIdLoader's delay_minutes, which had to
        # convert a bare UTC unix timestamp by hand for exactly this reason).
        rows.append(
            f'{r["LinkId"]},{r["IntervalStart"]},{r["TT"]},{r["Delay"]},{r["Speed"]},'
            f'{r["ExcessDelay"]},{r["Congestion"]},{r["Score"]},{str(bool(r["Closed"])).lower()}'
        )
    body = ".ingest inline into table " + KUSTO_TABLE + " <|\n" + "\n".join(rows)
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

# Run once: fetch stats, send them, log the result.

# CELL ********************

try:
    records = fetch_link_stats()
    send_to_kusto(records)
    print(f"{datetime.now()}: Sent {len(records)} link stats")
except Exception as e:
    print(f"{datetime.now()}: Error - {e}")
    raise

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
