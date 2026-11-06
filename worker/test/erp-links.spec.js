import { describe, it, expect, afterEach } from "vitest";
import { _test } from "../src/index.js";

const { canManageErpLinks, handleErpLinkChange, handleErpLinkList, ERP_TYPES } = _test;

const env = { PROCORE_API_BASE: "https://procore.test", PROCORE_COMPANY_ID: "1", PROCORE_CLIENT_ID: "a", PROCORE_CLIENT_SECRET: "b" };
const user = { username: "pat", displayName: "Pat" };
const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

describe("canManageErpLinks", () => {
  it("needs the dedicated permission", () => expect(canManageErpLinks({ appExtras: { TALLY: ["erp_link"] } })).toBe(true));
  it("isn't granted by a TALLY admin level or the attach permission", () => {
    expect(canManageErpLinks({ appRoles: { TALLY: "admin" }, appExtras: { TALLY: ["dc_attach"] } })).toBe(false);
  });
  it("fails closed", () => {
    expect(canManageErpLinks({ appExtras: { HELM: ["erp_link"] } })).toBe(false);
    expect(canManageErpLinks({ appExtras: { TALLY: "erp_link" } })).toBe(false);
    expect(canManageErpLinks(null)).toBe(false);
  });
});

describe("ERP_TYPES paths, as tested live on 2026-11-06", () => {
  it("uses the singular Prime Contract path", () => expect(ERP_TYPES.prime_contract.patch("7", "9")).toBe("/rest/v1.0/prime_contract/9?project_id=7"));
  it("nests owner invoices under the contract", () =>
    expect(ERP_TYPES.owner_invoice.patch("7", "9", "3")).toBe("/rest/v1.0/prime_contracts/3/payment_applications/9?project_id=7"));
  it("changes a Direct Cost through the sync endpoint, the only thing that moves `synced`", () => {
    expect(ERP_TYPES.direct_cost.patch("7", "9")).toBe("/rest/v1.0/projects/7/direct_costs/sync");
    expect(ERP_TYPES.direct_cost.body("7", "X", "9")).toEqual({ updates: [{ id: 9, origin_id: "X" }] });
  });
  it("reads a Direct Cost from v1.1, the only version that shows `synced`", () =>
    expect(ERP_TYPES.direct_cost.show("7", "9")).toBe("/rest/v1.1/projects/7/direct_costs/9"));
  it("wraps a CO in change_order with the project id", () =>
    expect(ERP_TYPES.change_order.body("7", "")).toEqual({ project_id: 7, change_order: { origin_id: "" } }));
});

describe("ERP link changes", () => {
  const real = globalThis.fetch;
  afterEach(() => { globalThis.fetch = real; });

  // store: id -> origin_id. A PATCH updates it unless patch() says otherwise.
  function procore(store, { patch, failShow } = {}) {
    const calls = { patches: [] };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (!u.includes("/rest/")) return jsonRes({ access_token: "tok" });
      const id = /(\d+)(\?|$)/.exec(u.split("?")[0])?.[1];
      if ((init.method || "GET") === "PATCH") {
        const sent = JSON.parse(init.body);
        calls.patches.push({ url: u, body: sent });
        const override = patch?.(id);
        if (override) return override;
        store[id] = Object.values(sent).find((v) => v && typeof v === "object").origin_id;
        return jsonRes({ id });
      }
      if (failShow?.(id, calls)) return jsonRes({}, 500);
      if (!(id in store)) return jsonRes({}, 404);
      return jsonRes({ id, number: `N-${id}`, origin_id: store[id] });
    };
    return calls;
  }

  function fakeSql({ failInsert = false } = {}) {
    const log = [];
    const sql = (strings, ...values) => {
      const text = strings.join("?");
      log.push({ text, values });
      if (failInsert && text.includes("insert into")) return Promise.reject(new Error("db down"));
      return Promise.resolve(text.includes("insert into") ? [{ id: log.length }] : []);
    };
    sql.log = log;
    return sql;
  }
  const statuses = (sql) => sql.log.filter((q) => q.text.includes("update erp_link_log")).map((q) => q.values[0]);
  const send = (body, sql = fakeSql()) =>
    handleErpLinkChange(new Request("https://t/erp-links", { method: "POST", body: JSON.stringify({ project_id: "7", type: "change_order", reason: "Sync fix", ...body }) }), env, sql, user);

  it("unlocks by blanking origin_id, and logs the old value and why", async () => {
    const store = { 9: "112240" };
    const calls = procore(store);
    const sql = fakeSql();
    const out = await (await send({ changes: [{ id: "9", action: "unlock" }] }, sql)).json();
    expect(out.results[0]).toEqual({ id: "9", ok: true, originId: "" });
    expect(store[9]).toBe("");
    expect(calls.patches[0].body).toEqual({ project_id: 7, change_order: { origin_id: "" } });
    const insert = sql.log.find((q) => q.text.includes("insert into erp_link_log"));
    expect(insert.values).toEqual(expect.arrayContaining(["pat", "7", "change_order", "9", "unlock", "112240", "", "Sync fix"]));
    expect(statuses(sql)).toEqual(["done"]);
  });

  it("locks with the ID given", async () => {
    const store = { 9: "" };
    procore(store);
    const out = await (await send({ changes: [{ id: "9", action: "lock", origin_id: " COSO+00295 " }] })).json();
    expect(out.results[0]).toEqual({ id: "9", ok: true, originId: "COSO+00295" });
    expect(store[9]).toBe("COSO+00295");
  });

  it("treats a null origin_id as unlocked", async () => {
    const store = { 9: null };
    procore(store);
    const out = await (await send({ changes: [{ id: "9", action: "unlock" }] })).json();
    expect(out.results[0]).toEqual({ id: "9", ok: false, error: "It's already unlocked." });
  });

  it("won't overwrite an existing link", async () => {
    const store = { 9: "112240" };
    const calls = procore(store);
    const out = await (await send({ changes: [{ id: "9", action: "lock", origin_id: "999" }] })).json();
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toContain("already linked to 112240");
    expect(calls.patches).toHaveLength(0);
    expect(store[9]).toBe("112240");
  });

  it("doesn't touch Procore if the change can't be logged", async () => {
    const store = { 9: "112240" };
    const calls = procore(store);
    const out = await (await send({ changes: [{ id: "9", action: "unlock" }] }, fakeSql({ failInsert: true }))).json();
    expect(out.results[0].ok).toBe(false);
    expect(calls.patches).toHaveLength(0);
  });

  it("fails if the read-back doesn't match, even after a 200", async () => {
    const store = { 9: "112240" };
    procore(store, { patch: () => jsonRes({}) });
    const sql = fakeSql();
    const out = await (await send({ changes: [{ id: "9", action: "unlock" }] }, sql)).json();
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toContain("112240");
    expect(statuses(sql)).toEqual(["failed"]);
  });

  it("flags a change it couldn't confirm", async () => {
    const store = { 9: "112240" };
    procore(store, { failShow: (id, calls) => calls.patches.length > 0 });
    const sql = fakeSql();
    const out = await (await send({ changes: [{ id: "9", action: "unlock" }] }, sql)).json();
    expect(out.results[0].error).toContain("couldn't be confirmed");
    expect(statuses(sql)).toEqual(["unverified"]);
  });

  it("carries on past one failure in a batch and reports each record", async () => {
    const store = { 1: "a", 3: "c" };
    procore(store);
    const out = await (await send({ changes: [{ id: "1", action: "unlock" }, { id: "2", action: "unlock" }, { id: "3", action: "unlock" }] })).json();
    expect(out.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out.results[1].error).toContain("can't find");
  });

  it("checks the whole batch before writing anything", async () => {
    const store = { 1: "a", 2: "" };
    const calls = procore(store);
    const res = await send({ changes: [{ id: "1", action: "unlock" }, { id: "2", action: "lock", origin_id: "<script>" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_id");
    expect(calls.patches).toHaveLength(0);
    expect(store[1]).toBe("a");
  });

  it("rejects bad requests", async () => {
    const calls = procore({ 1: "a" });
    const unlock = [{ id: "1", action: "unlock" }];
    for (const body of [
      { changes: unlock, reason: "" },
      { changes: [] },
      { changes: Array.from({ length: 6 }, () => unlock[0]) },
      { changes: [{ id: "1;drop", action: "unlock" }] },
      { changes: [{ id: "1", action: "delete" }] },
      { changes: unlock, type: "constructor" },
      { changes: unlock, project_id: "x" },
      { changes: unlock, type: "owner_invoice" },
    ]) expect((await send(body)).status).toBe(400);
    expect(calls.patches).toHaveLength(0);
  });

  describe("Direct Costs and the synced flag", () => {
    // dc: the record. onSync: what a sync call does to it.
    function dcProcore(dc, onSync) {
      const calls = { syncs: [] };
      globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (!u.includes("/rest/")) return jsonRes({ access_token: "tok" });
        if ((init.method || "GET") === "PATCH") {
          calls.syncs.push({ url: u, body: JSON.parse(init.body) });
          onSync(dc, JSON.parse(init.body).updates[0]);
          return jsonRes({ entities: [], errors: [] });
        }
        return jsonRes({ id: 9, ...dc });
      };
      return calls;
    }
    const real = (dc, u) => { dc.origin_id = u.origin_id; dc.synced = !!u.origin_id; };
    const dcSend = (changes, sql) => send({ type: "direct_cost", changes }, sql);

    it("unlocks through sync and checks `synced` really went off", async () => {
      const dc = { origin_id: "111101_2908", synced: true };
      const calls = dcProcore(dc, real);
      const sql = fakeSql();
      const out = await (await dcSend([{ id: "9", action: "unlock" }], sql)).json();
      expect(out.results[0]).toEqual({ id: "9", ok: true, originId: "" });
      expect(calls.syncs[0].url).toContain("/direct_costs/sync");
      expect(dc).toEqual({ origin_id: "", synced: false });
      expect(statuses(sql)).toEqual(["done"]);
    });

    it("can finish a half-unlocked record: blank ID, but still locked", async () => {
      const dc = { origin_id: "", synced: true };
      dcProcore(dc, real);
      const out = await (await dcSend([{ id: "9", action: "unlock" }])).json();
      expect(out.results[0].ok).toBe(true);
      expect(dc.synced).toBe(false);
    });

    it("locks through sync and checks `synced` came on", async () => {
      const dc = { origin_id: "", synced: false };
      dcProcore(dc, real);
      const out = await (await dcSend([{ id: "9", action: "lock", origin_id: "111101_2908" }])).json();
      expect(out.results[0].ok).toBe(true);
      expect(dc).toEqual({ origin_id: "111101_2908", synced: true });
    });

    it("fails if the ID changed but the lock didn't, which is the bug this replaced", async () => {
      const dc = { origin_id: "111101_2908", synced: true };
      dcProcore(dc, (d, u) => { d.origin_id = u.origin_id; });
      const sql = fakeSql();
      const out = await (await dcSend([{ id: "9", action: "unlock" }], sql)).json();
      expect(out.results[0].ok).toBe(false);
      expect(out.results[0].error).toContain("still shows this as locked");
      expect(statuses(sql)).toEqual(["failed"]);
    });

    it("still says already unlocked when it really is", async () => {
      const dc = { origin_id: "", synced: false };
      const calls = dcProcore(dc, real);
      const out = await (await dcSend([{ id: "9", action: "unlock" }])).json();
      expect(out.results[0].error).toBe("It's already unlocked.");
      expect(calls.syncs).toHaveLength(0);
    });
  });

  it("sends an owner invoice through its contract", async () => {
    const store = { 9: "x" };
    const calls = procore(store);
    await send({ type: "owner_invoice", changes: [{ id: "9", parent_id: "3", action: "unlock" }] });
    expect(calls.patches[0].url).toContain("/prime_contracts/3/payment_applications/9");
  });
});

describe("ERP link list", () => {
  const real = globalThis.fetch;
  afterEach(() => { globalThis.fetch = real; });
  const sql = (strings) => Promise.resolve(strings.join("").includes("distinct on") ? [{ record_id: "2", old_origin_id: "112240" }] : []);

  it("labels rows, normalises the link and offers the last known ID back", async () => {
    globalThis.fetch = async (url) => {
      if (!String(url).includes("/rest/")) return jsonRes({ access_token: "tok" });
      return jsonRes([
        { id: 1, invoice_number: "A", vendor_name: "V", grand_total: "5.0", status: "approved", origin_id: "108222_2908" },
        { id: 2, invoice_number: "B", description: " desc ", grand_total: "6.0", status: "draft", origin_id: "" },
      ]);
    };
    const out = await (await handleErpLinkList(new URL("https://t/erp-links?project_id=7&type=direct_cost"), env, sql)).json();
    expect(out.rows[0]).toMatchObject({ id: "1", number: "A", title: "V", amount: "5.0", originId: "108222_2908", lastOriginId: null });
    expect(out.rows[1]).toMatchObject({ id: "2", title: "desc", originId: "", lastOriginId: "112240" });
  });

  it("gathers owner invoices from every contract, keeping each one's contract", async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (!u.includes("/rest/")) return jsonRes({ access_token: "tok" });
      if (u.includes("payment_applications")) return jsonRes([{ id: u.includes("/30/") ? 300 : 400, number: 1, origin_id: null }]);
      return jsonRes([{ id: 30 }, { id: 40 }]);
    };
    const out = await (await handleErpLinkList(new URL("https://t/erp-links?project_id=7&type=owner_invoice"), env, sql)).json();
    expect(out.rows.map((r) => [r.id, r.parentId])).toEqual([["300", "30"], ["400", "40"]]);
  });

  it("still lists rows if the log can't be read", async () => {
    globalThis.fetch = async (url) => (String(url).includes("/rest/") ? jsonRes([{ id: 1, origin_id: null }]) : jsonRes({ access_token: "tok" }));
    const broken = () => Promise.reject(new Error("db down"));
    const res = await handleErpLinkList(new URL("https://t/erp-links?project_id=7&type=work_order"), env, broken);
    expect(res.status).toBe(200);
  });

  describe("one record", () => {
    const procore = (routes) => {
      const seen = [];
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (!u.includes("/rest/")) return jsonRes({ access_token: "tok" });
        seen.push(u);
        const hit = Object.entries(routes).find(([k]) => u.includes(k));
        return hit ? jsonRes(hit[1]) : jsonRes({}, 404);
      };
      return seen;
    };
    const read = (qs) => handleErpLinkList(new URL(`https://t/erp-links?project_id=7&${qs}`), env, sql);

    it("reads just that record, with one Procore call", async () => {
      const seen = procore({ "/direct_costs/2": { id: 2, vendor_name: "V", grand_total: "5.0", status: "approved", origin_id: "" } });
      const out = await (await read("type=direct_cost&id=2")).json();
      expect(out.row).toMatchObject({ id: "2", title: "V", originId: "", lastOriginId: "112240" });
      expect(seen).toHaveLength(1);
    });

    it("finds a CO's package when Procore gave the CO's own id", async () => {
      procore({ "/prime_change_orders/55": { id: 55, legacy_package_id: 2 }, "/change_order_packages/2?": { id: 2, number: "001", title: "T", origin_id: "94009" } });
      const out = await (await read("type=change_order&id=55")).json();
      expect(out.row).toMatchObject({ id: "2", number: "001", originId: "94009" });
    });

    it("keeps an owner invoice's contract, so it can be saved", async () => {
      procore({ "/payment_applications/9": { id: 9, number: 1, origin_id: null, contract: { id: 3 } } });
      const out = await (await read("type=owner_invoice&id=9")).json();
      expect(out.row).toMatchObject({ id: "9", parentId: "3" });
    });

    it("answers 404 when the id isn't that kind of record", async () => {
      procore({});
      expect((await read("type=work_order&id=9")).status).toBe(404);
      expect((await read("type=change_order&id=9")).status).toBe(404);
    });

    it("rejects a bad id", async () => {
      procore({});
      expect((await read("type=direct_cost&id=1;drop")).status).toBe(400);
    });
  });

  it("rejects an unknown type", async () => {
    expect((await handleErpLinkList(new URL("https://t/erp-links?project_id=7&type=__proto__"), env, sql)).status).toBe(400);
  });
});
