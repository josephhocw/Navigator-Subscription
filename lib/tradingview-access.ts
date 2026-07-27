// =============================================================================
// TRADINGVIEW ACCESS
// =============================================================================
// Grants and removes invite-only script access on TradingView — replacing the
// manual "invite the username" step that was, until now, the only human action
// left in the subscription pipeline.
//
// One invite-only script per plan (8 scripts). Every combo's script already
// plots the SG market, so a combo is still exactly one script — no separate SG
// grant is layered on top.
//
// There is no official TradingView API for this. These are the private
// "Manage Access" endpoints the website itself calls, authenticated by a
// logged-in session cookie (sessionid + sessionid_sign) — no password, no 2FA
// disable. The exact request shapes were captured from a live session on
// 2026-07-22 (see ../../Navigator Business Resources/Engineering/
// tradingview-access-automation-plan.md).
//
// Access model (matches the Telegram bot's "only CANCELLED loses access"):
// grants are made with NO expiration and stay until actively removed. Removal
// happens on ENDED (the subscription is fully cancelled) and on the old plan's
// script during a plan change. This fails safe for paying customers — if the
// tooling is down for a while, nobody loses access they paid for; only new
// sign-ups and cancellations queue until it recovers. The optional `expiration`
// argument is kept for the reconcile job and future timed comps (e.g. the TCM
// 2-month grant), but the subscription lifecycle passes none.
// =============================================================================

// Plan string → invite-only script pine_id. Keyed by PLAN, unlike the Telegram
// bot's market-keyed groups. Captured from Joseph's account 2026-07-22.
export const PLAN_TO_PINE_ID: Record<string, string> = {
  SG: "PUB;946019d26e7f4b7d9fe93da79612d2cd",
  FXMC: "PUB;b29993fb1d0040e5b8c03ba070c223ab",
  HK: "PUB;3cf4b68beac54cf3af63d8cfcc4393a5",
  US: "PUB;345cffda958a4facb182b3204fcd0166",
  US_HK: "PUB;f074f7d2b66c43c9ab19a58720050f7e",
  US_SG_FXMC: "PUB;0ef33555e7184590abc80c74335f66c3",
  HK_SG_FXMC: "PUB;1f87fa1f6ae14ef1aaf10167d74f120c",
  ALL_MARKETS: "PUB;44536b66c75047ea954cb5d4c88c701b",
};

/** Resolve a plan string to its script's pine_id. Throws on an unmapped plan. */
export function planToPineId(planType: string): string {
  const id = PLAN_TO_PINE_ID[planType];
  if (!id) throw new Error(`No TradingView script mapped for plan: ${planType}`);
  return id;
}

// -----------------------------------------------------------------------------
// The seam the lifecycle uses. It knows nothing about pine_ids, cookies, or
// HTTP — only "grant this username the script for this plan until this date"
// and "remove this username from this plan's script". In tests it's satisfied
// by a recording fake; in production by TradingViewAccessClient.
// -----------------------------------------------------------------------------
export interface TradingViewGranter {
  // True when this granter actually talks to TradingView. The Noop granter sets
  // it false so callers (the lifecycle's success ping) don't claim a grant that
  // never happened. Optional so in-memory test fakes read as configured.
  readonly configured?: boolean;
  // expiration omitted → a permanent grant (the subscription-lifecycle default).
  grantForPlan(username: string, planType: string, expiration?: Date): Promise<void>;
  removeForPlan(username: string, planType: string): Promise<void>;
}

type FetchLike = typeof fetch;

export interface TradingViewAccessOptions {
  sessionId: string;
  sessionIdSign: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Override for tests. Defaults to https://www.tradingview.com */
  baseUrl?: string;
}

const DEFAULT_BASE = "https://www.tradingview.com";

interface UsernameHint {
  username: string;
}

interface ListUsersResponse {
  results?: Array<{ username: string }>;
  // Cursor pagination: a relative path like "/pine_perm/list_users/?c=<token>",
  // or null/absent on the last page. `offset` is ignored by the API, so the
  // cursor is the only way to page.
  next?: string | null;
}

export class TradingViewAccessClient implements TradingViewGranter {
  readonly configured = true;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly cookie: string;

  constructor(opts: TradingViewAccessOptions) {
    if (!opts.sessionId || !opts.sessionIdSign) {
      throw new Error("TradingViewAccessClient needs sessionId and sessionIdSign");
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = opts.baseUrl ?? DEFAULT_BASE;
    this.cookie = `sessionid=${opts.sessionId}; sessionid_sign=${opts.sessionIdSign}`;
  }

  // The headers the Manage Access page sends on every call. `x-requested-with`
  // and `x-language` are required; the cookie is the whole auth.
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      cookie: this.cookie,
      origin: this.base,
      referer: `${this.base}/`,
      "x-requested-with": "XMLHttpRequest",
      "x-language": "en",
      ...extra,
    };
  }

  private static FORM = "application/x-www-form-urlencoded; charset=UTF-8";

  /**
   * Normalise a user-typed username to TradingView's canonical spelling/case.
   * Customers type "joebloggs"; TradingView stores "JoeBloggs" and the grant
   * call is case-sensitive. Returns null when no exact (case-insensitive) match
   * exists — the caller treats that as "username not found".
   */
  async validateUsername(username: string): Promise<string | null> {
    const q = username.trim();
    if (!q) return null;
    const res = await this.fetchImpl(
      `${this.base}/username_hint/?s=${encodeURIComponent(q)}`,
      { method: "GET", headers: this.headers() }
    );
    if (!res.ok) throw new Error(`username_hint returned ${res.status} for "${q}"`);
    const hits = (await res.json()) as UsernameHint[];
    const match = hits.find((h) => h.username.toLowerCase() === q.toLowerCase());
    return match ? match.username : null;
  }

  /**
   * Grant (or re-grant) `username` access to `planType`'s script. With no
   * `expiration` the grant is permanent (the lifecycle default); pass a date
   * for a timed grant (reconcile / comps). `add/` upserts, so re-granting an
   * existing user is safe and idempotent.
   */
  async grantForPlan(
    username: string,
    planType: string,
    expiration?: Date
  ): Promise<void> {
    const pineId = planToPineId(planType); // throws on an unknown plan → fail safe
    const canonical = await this.validateUsername(username);
    if (!canonical) {
      throw new Error(`TradingView username not found: "${username}" (${planType})`);
    }

    const body = new URLSearchParams({
      pine_id: pineId,
      username_recip: canonical,
    });
    // Omitting `expiration` entirely is how the capture produced a "No
    // expiration" grant. Only send it for a timed grant.
    if (expiration) {
      body.set("expiration", expiration.toISOString()); // ISO 8601 UTC
    }
    const res = await this.fetchImpl(`${this.base}/pine_perm/add/`, {
      method: "POST",
      headers: this.headers({ "content-type": TradingViewAccessClient.FORM }),
      body: body.toString(),
    });
    // Live capture returned 201 on a fresh grant; a re-grant returns 200. Both
    // carry {"status":"ok"}. Anything else is a real failure.
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(
        `pine_perm/add returned ${res.status} for ${canonical} on ${planType}`
      );
    }
  }

  /** Remove `username` from `planType`'s script. Idempotent server-side. */
  async removeForPlan(username: string, planType: string): Promise<void> {
    const pineId = planToPineId(planType);
    // Best-effort case correction; fall back to the raw username if the hint
    // lookup misses (the account may already be gone, which is fine).
    const canonical = (await this.validateUsername(username)) ?? username.trim();
    const body = new URLSearchParams({
      pine_id: pineId,
      username_recip: canonical,
    });
    const res = await this.fetchImpl(`${this.base}/pine_perm/remove/`, {
      method: "POST",
      headers: this.headers({ "content-type": TradingViewAccessClient.FORM }),
      body: body.toString(),
    });
    if (res.status !== 200) {
      throw new Error(
        `pine_perm/remove returned ${res.status} for ${canonical} on ${planType}`
      );
    }
  }

  /**
   * List every username currently granted on a script, for the reconcile job.
   * The API caps `limit` at 30 and ignores `offset`, so we follow the `next`
   * cursor page by page until it runs out. The iteration cap is a runaway
   * guard (30 * 200 = 6000 users, far above any real script).
   */
  async listUsers(pineId: string): Promise<string[]> {
    const users: string[] = [];
    const body = new URLSearchParams({ pine_id: pineId }).toString();
    let path: string | null = "/pine_perm/list_users/?limit=30&order_by=-created";
    for (let i = 0; i < 200 && path; i++) {
      const url = path.startsWith("http") ? path : `${this.base}${path}`;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers({ "content-type": TradingViewAccessClient.FORM }),
        body,
      });
      if (!res.ok) throw new Error(`pine_perm/list_users returned ${res.status}`);
      const data = (await res.json()) as ListUsersResponse;
      for (const r of data.results ?? []) users.push(r.username);
      path = data.next ?? null;
    }
    return users;
  }
}

/**
 * A do-nothing granter used when the TradingView cookies aren't configured. It
 * logs and returns, so the webhook keeps working and Joseph falls back to the
 * manual invite. Wired in by the edge function only when env vars are absent.
 */
export class NoopTradingViewGranter implements TradingViewGranter {
  readonly configured = false;
  async grantForPlan(username: string, planType: string): Promise<void> {
    console.warn(
      `TradingView not configured — skipping grant of ${planType} to "${username}" (do it manually)`
    );
  }
  async removeForPlan(username: string, planType: string): Promise<void> {
    console.warn(
      `TradingView not configured — skipping removal of ${planType} from "${username}"`
    );
  }
}
