/**
 * Trigger a Fabric notebook run directly from the app (2026-09-08, Ross's
 * ask) - so restarting the live position feed after an idle stretch doesn't
 * need a separate Fabric portal visit or a Claude Code session.
 *
 * ACTBusEventLoader only: this is the proven, reliable notebook that
 * genuinely works when job-triggered. ACTStopIdLoader (the isolated
 * stop_id/on-time notebook) currently fails every job-triggered run with a
 * generic Fabric error - a %pip-install-triggered kernel restart a
 * job-triggered run can't survive - so it's deliberately not wired up here
 * yet. It still only works run interactively, until the Environment fix
 * (parked, see PROJECT_STATUS.md) lands.
 *
 * Reuses the exact same signed-in MSAL session as kustoClient.ts (see that
 * file's export of ensureMsalInitialized) rather than a second sign-in -
 * just a different scope, for the Fabric REST API instead of the
 * Eventhouse. Unlike Kusto's constantly-polled feed, this is an occasional,
 * user-clicked action, so it only needs a plain silent-then-popup fallback,
 * not the full NAA/storage-access saga Kusto's embeddable, always-needed
 * access requires.
 */
import { ensureMsalInitialized } from './kustoClient';

// This project's one Fabric workspace and the one notebook this button
// controls - not meant to be reusable/configurable, hence hardcoded rather
// than threaded through env vars like the Kusto config is.
const WORKSPACE_ID = '0a5fda47-d117-4567-bfc0-62f5697d4146';
const ACT_BUS_EVENT_LOADER_ITEM_ID = '37a07431-bca6-4f2f-992a-850e3f07cfaa';
const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
// Delegated permission granted directly on the same Entra app kustoClient.ts
// already uses (Canberra Pulse Kusto Client) - added 2026-09-08 specifically
// for this button, admin-consented separately (see PROJECT_STATUS.md).
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/Notebook.Execute.All';

export class FabricJobInteractionRequiredError extends Error {
  constructor(message = 'Sign-in required to start the data loader.') {
    super(message);
    this.name = 'FabricJobInteractionRequiredError';
  }
}

async function getFabricToken(): Promise<string> {
  const msal = await ensureMsalInitialized();
  const scopes = [FABRIC_SCOPE];
  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? undefined;

  if (account) {
    try {
      const res = await msal.acquireTokenSilent({ scopes, account });
      if (res.account) msal.setActiveAccount(res.account);
      return res.accessToken;
    } catch {
      // Falls through to the interactive popup below - most likely cause is
      // this specific scope not being consented yet on this account, which
      // acquireTokenSilent can never resolve on its own.
    }
  }

  // Safe to prompt here - this function is only ever called from a button
  // click (a genuine user gesture), unlike Kusto's silent polling loop.
  try {
    const res = await msal.acquireTokenPopup({ scopes });
    if (res.account) msal.setActiveAccount(res.account);
    return res.accessToken;
  } catch (err) {
    throw new FabricJobInteractionRequiredError((err as Error).message);
  }
}

export type NotebookJobStatus = 'NotStarted' | 'InProgress' | 'Completed' | 'Failed' | 'Cancelled' | 'Deduped';

interface JobInstance {
  id: string;
  status: NotebookJobStatus;
}

/** The most recent job run for ACTBusEventLoader, or null if it's never been run. */
async function getLatestJob(token: string): Promise<JobInstance | null> {
  const res = await fetch(
    `${FABRIC_API}/workspaces/${WORKSPACE_ID}/items/${ACT_BUS_EVENT_LOADER_ITEM_ID}/jobs/instances`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Checking job status failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { value?: JobInstance[] };
  return data.value?.[0] ?? null;
}

export interface TriggerResult {
  /** True if a genuinely new run was started; false if one was already in progress and this call left it alone. */
  started: boolean;
  message: string;
}

/**
 * Starts ACTBusEventLoader's 20-minute live-feed run, unless one is already
 * in progress - Ross's own session log records a real incident from two
 * concurrent runs of this same notebook overlapping, so this checks first
 * rather than risking that again for the sake of one avoided click.
 */
export async function triggerBusEventLoader(): Promise<TriggerResult> {
  const token = await getFabricToken();

  const latest = await getLatestJob(token);
  if (latest && (latest.status === 'NotStarted' || latest.status === 'InProgress')) {
    return { started: false, message: 'Already running - live positions should already be flowing.' };
  }

  const res = await fetch(
    `${FABRIC_API}/workspaces/${WORKSPACE_ID}/items/${ACT_BUS_EVENT_LOADER_ITEM_ID}/jobs/instances?jobType=RunNotebook`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`Starting the data loader failed: ${res.status} ${res.statusText} - ${await res.text()}`);
  }
  return { started: true, message: 'Started - live positions should appear within about 15-30 seconds.' };
}
