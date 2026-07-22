// =============================================================================
// TRADINGVIEW ACCESS CLIENT TESTS
// =============================================================================
// Drives TradingViewAccessClient with a fake fetch that records requests and
// returns canned responses, so we can assert the exact request shapes captured
// from the live Manage Access page (2026-07-22) without hitting the network.
// =============================================================================

import { describe, test, expect } from "vitest";
import {
  TradingViewAccessClient,
  planToPineId,
  PLAN_TO_PINE_ID,
} from "./tradingview-access.js";

interface Recorded {
  url: string;
  init?: RequestInit;
}

interface Route {
  match: string;
  status?: number;
  body?: unknown;
}

// Build a fake fetch. Routes are matched by URL substring, first match wins.
function fakeFetch(routes: Route[]) {
  const calls: Recorded[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const route = routes.find((r) => u.includes(r.match));
    if (!route) throw new Error(`fakeFetch: no route for ${u}`);
    const status = route.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => route.body,
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

function bodyOf(call: Recorded): URLSearchParams {
  return new URLSearchParams(String(call.init?.body ?? ""));
}

const opts = (fetchImpl: typeof fetch) => ({
  sessionId: "sess123",
  sessionIdSign: "v3:sign456",
  fetchImpl,
});

describe("planToPineId", () => {
  test("maps every plan string to a pine_id", () => {
    expect(planToPineId("SG")).toBe(PLAN_TO_PINE_ID.SG);
    expect(planToPineId("ALL_MARKETS")).toBe("PUB;44536b66c75047ea954cb5d4c88c701b");
  });

  test("throws on an unmapped plan (fail safe)", () => {
    expect(() => planToPineId("BOGUS")).toThrow(/No TradingView script/);
  });
});

describe("validateUsername", () => {
  test("returns the canonical case for a case-insensitive match", async () => {
    const { impl } = fakeFetch([
      { match: "username_hint", body: [{ username: "JoeBloggs" }, { username: "joesmith" }] },
    ]);
    const client = new TradingViewAccessClient(opts(impl));
    expect(await client.validateUsername("joebloggs")).toBe("JoeBloggs");
  });

  test("returns null when no exact match exists", async () => {
    const { impl } = fakeFetch([
      { match: "username_hint", body: [{ username: "joebloggs2" }] },
    ]);
    const client = new TradingViewAccessClient(opts(impl));
    expect(await client.validateUsername("joebloggs")).toBeNull();
  });
});

describe("grantForPlan", () => {
  test("normalises the username then POSTs add/ with pine_id, canonical name, ISO expiry", async () => {
    const { impl, calls } = fakeFetch([
      { match: "username_hint", body: [{ username: "NewPerson" }] },
      { match: "pine_perm/add", status: 201, body: { status: "ok" } },
    ]);
    const client = new TradingViewAccessClient(opts(impl));
    const expiry = new Date("2026-10-29T12:00:00.000Z");
    await client.grantForPlan("newperson", "US", expiry);

    const add = calls.find((c) => c.url.includes("pine_perm/add"))!;
    const body = bodyOf(add);
    expect(body.get("pine_id")).toBe(PLAN_TO_PINE_ID.US);
    expect(body.get("username_recip")).toBe("NewPerson"); // canonical case
    expect(body.get("expiration")).toBe("2026-10-29T12:00:00.000Z");
    // Auth cookie carries both parts.
    expect((add.init?.headers as Record<string, string>).cookie).toContain("sessionid=sess123");
    expect((add.init?.headers as Record<string, string>).cookie).toContain("sessionid_sign=v3:sign456");
  });

  test("omits the expiration field entirely for a permanent grant", async () => {
    const { impl, calls } = fakeFetch([
      { match: "username_hint", body: [{ username: "NewPerson" }] },
      { match: "pine_perm/add", status: 201, body: { status: "ok" } },
    ]);
    const client = new TradingViewAccessClient(opts(impl));
    await client.grantForPlan("newperson", "US"); // no expiration

    const add = calls.find((c) => c.url.includes("pine_perm/add"))!;
    const body = bodyOf(add);
    expect(body.get("pine_id")).toBe(PLAN_TO_PINE_ID.US);
    expect(body.get("username_recip")).toBe("NewPerson");
    expect(body.has("expiration")).toBe(false);
  });

  test("treats a 200 re-grant as success (add/ upserts on renewal)", async () => {
    const { impl } = fakeFetch([
      { match: "username_hint", body: [{ username: "NewPerson" }] },
      { match: "pine_perm/add", status: 200, body: { status: "ok" } },
    ]);
    const client = new TradingViewAccessClient(opts(impl));
    await expect(
      client.grantForPlan("newperson", "US", new Date())
    ).resolves.toBeUndefined();
  });

  test("throws when the username does not exist (no add/ call made)", async () => {
    const { impl, calls } = fakeFetch([{ match: "username_hint", body: [] }]);
    const client = new TradingViewAccessClient(opts(impl));
    await expect(client.grantForPlan("ghost", "US", new Date())).rejects.toThrow(
      /username not found/
    );
    expect(calls.some((c) => c.url.includes("pine_perm/add"))).toBe(false);
  });

  test("throws on an unknown plan without touching the network", async () => {
    const { impl, calls } = fakeFetch([]);
    const client = new TradingViewAccessClient(opts(impl));
    await expect(client.grantForPlan("joe", "BOGUS", new Date())).rejects.toThrow(
      /No TradingView script/
    );
    expect(calls).toHaveLength(0);
  });
});

describe("removeForPlan", () => {
  test("POSTs remove/ with pine_id and canonical username", async () => {
    const { impl, calls } = fakeFetch([
      { match: "username_hint", body: [{ username: "TanAhKow" }] },
      { match: "pine_perm/remove", status: 200, body: { status: "ok" } },
    ]);
    const client = new TradingViewAccessClient(opts(impl));
    await client.removeForPlan("tanahkow", "ALL_MARKETS");

    const remove = calls.find((c) => c.url.includes("pine_perm/remove"))!;
    const body = bodyOf(remove);
    expect(body.get("pine_id")).toBe(PLAN_TO_PINE_ID.ALL_MARKETS);
    expect(body.get("username_recip")).toBe("TanAhKow");
  });
});

describe("listUsers", () => {
  test("returns the usernames from the results array", async () => {
    const { impl } = fakeFetch([
      {
        match: "pine_perm/list_users",
        body: { results: [{ username: "wk68" }, { username: "Joseph" }] },
      },
    ]);
    const client = new TradingViewAccessClient(opts(impl));
    expect(await client.listUsers(PLAN_TO_PINE_ID.FXMC)).toEqual(["wk68", "Joseph"]);
  });
});

describe("constructor", () => {
  test("rejects missing cookie parts", () => {
    expect(() => new TradingViewAccessClient({ sessionId: "", sessionIdSign: "x" })).toThrow();
  });
});
