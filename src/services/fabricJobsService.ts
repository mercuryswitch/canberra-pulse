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
 * (parked, see PROJECT_STATUS.md) lands. That means the on-time panel,
 * gauge/histogram, and "at stop" info stay empty even after this button
 * successfully starts the position feed - a separate, already-diagnosed gap,
 * not something a retry here would fix.
 *
 * Reuses the exact same signed-in MSAL session as kustoClient.ts (see that
 * file's export of ensureMsalInitialized) rather than a second sign-in -
 * just a different scope, for the Fabric REST API instead of the
 * Eventhouse.
 *
 * 2026-09-08: the first version of this used acquireTokenPopup as the
 * one-time-consent fallback and hit MSAL's no_token_request_cache_error in
 * practice - a documented MSAL limitation, not a one-off glitch: this app
 * polls Kusto silently every 8s in the background (busService.ts), and a
 * popup-based request from the *same* MSAL instance can lose its own cached
 * request state if one of those concurrent silent requests resolves while
 * the popup is still open. Switched to acquireTokenRedirect instead - the
 * exact same mechanism kustoClient.ts's own standalone sign-in already uses
 * successfully, so this isn't a new, untested code path - a full-page
 * navigation has nothing else running concurrently to collide with. The
 * trade-off is a page reload, only on the very first use before this scope
 * is consented; every use after that is silent. sessionStorage carries the
 * pending intent across that reload so the button's own action completes
 * automatically afterward instead of making Ross click twice.
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
// for this button, admin-consented separately (see PROJECT_STATUS.md) -
// until that's done, every browser hits the one-time redirect-consent path
// below rather than going silent immediately.
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/Notebook.Execute.All';
const PENDING_TRIGGER_KEY = 'canberrapulse.pendingBusLoaderTrigger';

export class FabricJobInteractionRequiredError extends Error {
  constructor(message = 'Sign-in required to start the data loader.') {
    super(message);
    this.name = 'FabricJobInteractionRequiredError';
  }
}

/** Silent-only - throws FabricJobInteractionRequiredError if that's not enough (first use, before consent). */
async function getFabricTokenSilent(): Promise<string> {
  const msal = await ensureMsalInitialized();
  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? undefined;
  if (account) {
    try {
      const res = await msal.acquireTokenSilent({ scopes: [FABRIC_SCOPE], account });
      if (res.account) msal.setActiveAccount(res.account);
      return res.accessToken;
    } catch {
      // Falls through - most likely cause is this specific scope not being
      // consented yet on this account, which silent can never resolve alone.
    }
  }
  throw new FabricJobInteractionRequiredError();
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
  /** True if a genuinely new run was started; false if one was already in progress, or a one-time consent redirect is in flight. */
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
  let token: string;
  try {
    token = await getFabricTokenSilent();
  } catch (err) {
    if (!(err instanceof FabricJobInteractionRequiredError)) throw err;
    // One-time consent needed for this scope. Mark the intent so
    // resumePendingTriggerIfAny() (called once at app startup) finishes the
    // job automatically once the page reloads back from Entra, rather than
    // making Ross click the button twice.
    sessionStorage.setItem(PENDING_TRIGGER_KEY, '1');
    const msal = await ensureMsalInitialized();
    await msal.acquireTokenRedirect({ scopes: [FABRIC_SCOPE] });
    // acquireTokenRedirect navigates the page away - this line normally
    // never runs, but is here in case the browser blocks the redirect.
    return { started: false, message: 'Redirecting to grant one-time permission…' };
  }

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

/**
 * Call once at app startup. Resumes a trigger that was interrupted by the
 * one-time consent redirect above - returns null if there was nothing
 * pending (the overwhelmingly common case).
 */
export async function resumePendingTriggerIfAny(): Promise<TriggerResult | null> {
  if (!sessionStorage.getItem(PENDING_TRIGGER_KEY)) return null;
  sessionStorage.removeItem(PENDING_TRIGGER_KEY);
  return triggerBusEventLoader();
}
