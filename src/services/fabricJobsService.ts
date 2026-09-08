/**
 * Trigger Fabric notebook runs directly from the app (2026-09-08, Ross's
 * ask) - so restarting the live feed after an idle stretch doesn't need a
 * separate Fabric portal visit or a Claude Code session.
 *
 * One button, dual function (Ross's explicit ask, same day): starts both
 * ACTBusEventLoader (positions/routes/heat map/near-me) and ACTStopIdLoader
 * (stop_id + delay_minutes - on-time performance, the gauge/histogram
 * panel, "at stop" on the vehicle panel) together. This only became safe
 * once ACTStopIdLoader was pointed at a custom Fabric Environment with
 * azure-kusto-data pre-baked in - the real root cause of every earlier
 * job-triggered failure was a %pip-install-triggered kernel restart
 * (azure-kusto-data needs a newer PyJWT than the base runtime ships with),
 * which a job-triggered run can't survive. See PROJECT_STATUS.md for the
 * full diagnosis.
 *
 * Reuses the exact same signed-in MSAL session as kustoClient.ts (see that
 * file's export of ensureMsalInitialized) rather than a second sign-in -
 * just a different scope, for the Fabric REST API instead of the
 * Eventhouse. One token covers both notebooks (same workspace, same scope).
 *
 * 2026-09-08: the first version used acquireTokenPopup as the one-time-
 * consent fallback and hit MSAL's no_token_request_cache_error in
 * practice - a documented MSAL limitation, not a one-off glitch: this app
 * polls Kusto silently every 8s in the background (busService.ts), and a
 * popup-based request from the *same* MSAL instance can lose its own
 * cached request state if one of those concurrent silent requests resolves
 * while the popup is still open. Switched to acquireTokenRedirect instead -
 * the exact same mechanism kustoClient.ts's own standalone sign-in already
 * uses successfully, so this isn't a new, untested code path. Moot in
 * practice now that admin consent is granted (silent always succeeds), but
 * kept as the safety net for any account/tenant where it isn't.
 */
import { ensureMsalInitialized } from './kustoClient';

// This project's one Fabric workspace and the two notebooks this button
// controls - not meant to be reusable/configurable, hence hardcoded rather
// than threaded through env vars like the Kusto config is.
const WORKSPACE_ID = '0a5fda47-d117-4567-bfc0-62f5697d4146';
const ACT_BUS_EVENT_LOADER_ITEM_ID = '37a07431-bca6-4f2f-992a-850e3f07cfaa';
const ACT_STOP_ID_LOADER_ITEM_ID = 'd77bdddc-0360-4cd9-9af9-4da92e1aae99';
const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
// Delegated permission granted directly on the same Entra app kustoClient.ts
// already uses (Canberra Pulse Kusto Client) - added 2026-09-08 specifically
// for this button, admin-consented tenant-wide (confirmed via
// `az ad app permission list-grants`, consentType: AllPrincipals) - silent
// acquisition always succeeds now, the redirect fallback below is a safety
// net, not the normal path.
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/Notebook.Execute.All';
const PENDING_TRIGGER_KEY = 'canberrapulse.pendingDataLoaderTrigger';

export class FabricJobInteractionRequiredError extends Error {
  constructor(message = 'Sign-in required to start the data loaders.') {
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

type NotebookJobStatus = 'NotStarted' | 'InProgress' | 'Completed' | 'Failed' | 'Cancelled' | 'Deduped';
interface JobInstance {
  id: string;
  status: NotebookJobStatus;
}

/** The most recent job run for one notebook item, or null if it's never been run. */
async function getLatestJob(token: string, itemId: string): Promise<JobInstance | null> {
  const res = await fetch(`${FABRIC_API}/workspaces/${WORKSPACE_ID}/items/${itemId}/jobs/instances`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Checking job status failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { value?: JobInstance[] };
  return data.value?.[0] ?? null;
}

interface SingleTriggerOutcome {
  label: string;
  started: boolean;
  ok: boolean;
  detail: string;
}

/**
 * Starts one notebook's run, unless one is already in progress - Ross's own
 * session log records a real incident from two concurrent runs of
 * ACTBusEventLoader overlapping, so this checks first rather than risking
 * that again for the sake of one avoided click. Never throws - a failure
 * on one notebook shouldn't stop the other from being reported.
 */
async function triggerOne(token: string, itemId: string, label: string): Promise<SingleTriggerOutcome> {
  try {
    const latest = await getLatestJob(token, itemId);
    if (latest && (latest.status === 'NotStarted' || latest.status === 'InProgress')) {
      return { label, started: false, ok: true, detail: 'already running' };
    }
    const res = await fetch(
      `${FABRIC_API}/workspaces/${WORKSPACE_ID}/items/${itemId}/jobs/instances?jobType=RunNotebook`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      return { label, started: false, ok: false, detail: `failed to start (${res.status})` };
    }
    return { label, started: true, ok: true, detail: 'started' };
  } catch (err) {
    return { label, started: false, ok: false, detail: (err as Error).message };
  }
}

export interface TriggerResult {
  message: string;
  isError: boolean;
}

function summarize(outcomes: SingleTriggerOutcome[]): TriggerResult {
  const isError = outcomes.some((o) => !o.ok);
  const message = outcomes.map((o) => `${o.label}: ${o.detail}`).join(' · ');
  return {
    isError,
    message: outcomes.some((o) => o.started)
      ? `${message} - live data should appear within about 15-30 seconds.`
      : message,
  };
}

/**
 * Starts both ACTBusEventLoader (positions) and ACTStopIdLoader (on-time
 * data) together - one button, dual function. A problem starting one
 * doesn't stop the other from being attempted or reported.
 */
export async function triggerDataLoaders(): Promise<TriggerResult> {
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
    return { message: 'Redirecting to grant one-time permission…', isError: false };
  }

  const outcomes = await Promise.all([
    triggerOne(token, ACT_BUS_EVENT_LOADER_ITEM_ID, 'Positions'),
    triggerOne(token, ACT_STOP_ID_LOADER_ITEM_ID, 'On-time data'),
  ]);
  return summarize(outcomes);
}

/**
 * Call once at app startup. Resumes a trigger that was interrupted by the
 * one-time consent redirect above - returns null if there was nothing
 * pending (the overwhelmingly common case).
 */
export async function resumePendingTriggerIfAny(): Promise<TriggerResult | null> {
  if (!sessionStorage.getItem(PENDING_TRIGGER_KEY)) return null;
  sessionStorage.removeItem(PENDING_TRIGGER_KEY);
  return triggerDataLoaders();
}
