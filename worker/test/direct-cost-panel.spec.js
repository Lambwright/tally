import { describe, it, expect, afterEach } from "vitest";
import { _test } from "../src/index.js";

const { canAttachToDirectCost, compareAttachments, directCostSummary, cleanFilename, handleDirectCostPanelAttach } = _test;

describe("canAttachToDirectCost", () => {
  it("lets a TALLY admin in", () => expect(canAttachToDirectCost({}, "admin")).toBe(true));
  it("keeps a plain submitter out", () => expect(canAttachToDirectCost({ appExtras: {} }, "submitter")).toBe(false));
  it("lets a submitter with the tool permission in", () =>
    expect(canAttachToDirectCost({ appExtras: { TALLY: ["dc_attach"] } }, "submitter")).toBe(true));
  it("ignores the permission on another app", () =>
    expect(canAttachToDirectCost({ appExtras: { HELM: ["dc_attach"] } }, "submitter")).toBe(false));
  it("fails closed on an unknown level or a malformed appExtras", () => {
    expect(canAttachToDirectCost({ appExtras: { TALLY: ["dc_attach"] } }, "viewer")).toBe(false);
    expect(canAttachToDirectCost({ appExtras: { TALLY: "dc_attach" } }, "submitter")).toBe(false);
    expect(canAttachToDirectCost(null, "submitter")).toBe(false);
  });
});

describe("compareAttachments", () => {
  const dc = (...ids) => ({ attachments: ids.map((id) => ({ id })) });
  it("passes when the new file shows and nothing went missing", () =>
    expect(compareAttachments(dc(1, 2), dc(3, 1, 2), 1)).toEqual({ added: 1, lost: 0, ok: true }));
  it("fails when Procore linked nothing", () => expect(compareAttachments(dc(1), dc(1), 1).ok).toBe(false));
  it("fails when only some files linked", () => expect(compareAttachments(dc(), dc(1), 2).ok).toBe(false));
  it("fails when an existing file disappeared, even if the new one landed", () =>
    expect(compareAttachments(dc(1, 2), dc(2, 3), 1)).toEqual({ added: 1, lost: 1, ok: false }));
});

describe("directCostSummary", () => {
  it("flags the ERP link and keeps the id exact", () => {
    const s = directCostSummary({ id: 562950048877091, invoice_number: "X-1", vendor_name: "V", grand_total: "28.0", origin_id: "108222_2908", attachments: [{ id: 5, filename: "a.pdf" }] });
    expect(s).toMatchObject({ id: "562950048877091", number: "X-1", vendor: "V", total: "28.0", erpLinked: true, attachments: [{ id: "5", name: "a.pdf" }] });
  });
  it("treats a blank origin_id as not linked", () => expect(directCostSummary({ id: 1, origin_id: "" }).erpLinked).toBe(false));
});

describe("cleanFilename", () => {
  it("drops any path and control characters", () => expect(cleanFilename("C:\\temp\\a\u0007.pdf")).toBe("a.pdf"));
  it("falls back when nothing is left", () => expect(cleanFilename("")).toBe("file"));
});

describe("handleDirectCostPanelAttach", () => {
  const real = globalThis.fetch;
  afterEach(() => { globalThis.fetch = real; });

  const env = { PROCORE_API_BASE: "https://procore.test", PROCORE_COMPANY_ID: "1", PROCORE_CLIENT_ID: "a", PROCORE_CLIENT_SECRET: "b", ATTACH_SETTLE_MS: 0 };
  const user = { username: "pat", displayName: "Pat" };
  const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const dcBefore = { id: 9, invoice_number: "N-1", origin_id: "108222_2908", grand_total: "28.0", attachments: [{ id: 1, name: "old.pdf" }] };
  const dcAfter = { ...dcBefore, attachments: [{ id: 2, name: "new.png" }, { id: 1, name: "old.pdf" }] };

  // reads: what each GET of the Direct Cost returns, in order (the last one repeats).
  function procore({ reads, patch = () => jsonRes({}) }) {
    const calls = { patches: [], gets: 0 };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (!u.includes("/rest/")) return jsonRes({ access_token: "tok", expires_in: 3600 });
      if ((init.method || "GET") === "PATCH") { calls.patches.push(init); return patch(); }
      const r = reads[Math.min(calls.gets, reads.length - 1)];
      calls.gets += 1;
      return r instanceof Response ? r.clone() : jsonRes(r);
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

  function request({ files = [new File(["x"], "new.png", { type: "image/png" })], projectId = "7", id = "9" } = {}) {
    const form = new FormData();
    if (projectId) form.append("project_id", projectId);
    if (id) form.append("id", id);
    for (const f of files) form.append("files", f);
    return new Request("https://tally.test/direct-cost-panel/attach", { method: "POST", body: form });
  }
  const status = (sql) => sql.log.filter((q) => q.text.includes("update dc_attachment_log")).map((q) => q.values[0]);

  it("attaches, confirms by read-back and logs who did it", async () => {
    const calls = procore({ reads: [dcBefore, dcAfter] });
    const sql = fakeSql();
    const res = await handleDirectCostPanelAttach(request(), env, sql, user);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.directCost.attachments).toHaveLength(2);
    expect(status(sql)).toEqual(["attached"]);
    const insert = sql.log.find((q) => q.text.includes("insert into"));
    expect(insert.values).toEqual(expect.arrayContaining(["pat", "Pat", "7", "9", "N-1", "108222_2908", "new.png"]));
    expect(calls.patches).toHaveLength(1);
  });

  it("sends the file as attachments[] and nothing that could touch the ERP link", async () => {
    const calls = procore({ reads: [dcBefore, dcAfter] });
    await handleDirectCostPanelAttach(request(), env, fakeSql(), user);
    const sent = calls.patches[0].body;
    expect(sent).toBeInstanceOf(FormData);
    expect([...sent.keys()]).toEqual(["attachments[]"]);
  });

  it("does not upload if the log can't be written", async () => {
    const calls = procore({ reads: [dcBefore] });
    const res = await handleDirectCostPanelAttach(request(), env, fakeSql({ failInsert: true }), user);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("log_failed");
    expect(calls.patches).toHaveLength(0);
  });

  it("reports a 200 that linked nothing as a failure", async () => {
    procore({ reads: [dcBefore] });
    const sql = fakeSql();
    const res = await handleDirectCostPanelAttach(request(), env, sql, user);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("not_confirmed");
    expect(status(sql)).toEqual(["failed"]);
  });

  it("waits for a file that links a moment late", async () => {
    procore({ reads: [dcBefore, dcBefore, dcAfter] });
    const res = await handleDirectCostPanelAttach(request(), env, fakeSql(), user);
    expect(res.status).toBe(200);
  });

  it("reports an existing file going missing", async () => {
    procore({ reads: [dcBefore, { ...dcBefore, attachments: [{ id: 2, name: "new.png" }] }] });
    const res = await handleDirectCostPanelAttach(request(), env, fakeSql(), user);
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.detail).toContain("no longer show");
  });

  it("says when Procore refuses, and logs it", async () => {
    procore({ reads: [dcBefore], patch: () => jsonRes({ errors: "locked" }, 403) });
    const sql = fakeSql();
    const res = await handleDirectCostPanelAttach(request(), env, sql, user);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("attach_failed");
    expect(status(sql)).toEqual(["failed"]);
  });

  it("flags an upload it can't confirm, rather than calling it failed", async () => {
    procore({ reads: [dcBefore, jsonRes({ error: "boom" }, 500)] });
    const sql = fakeSql();
    const res = await handleDirectCostPanelAttach(request(), env, sql, user);
    expect((await res.json()).error).toBe("unverified");
    expect(status(sql)).toEqual(["unverified"]);
  });

  it("refuses a Direct Cost Procore can't find, before logging anything", async () => {
    procore({ reads: [jsonRes({}, 404)] });
    const sql = fakeSql();
    const res = await handleDirectCostPanelAttach(request(), env, sql, user);
    expect(res.status).toBe(404);
    expect(sql.log).toHaveLength(0);
  });

  it("rejects bad input before calling Procore", async () => {
    const calls = procore({ reads: [dcBefore] });
    const bad = [
      request({ id: "1; drop table" }),
      request({ projectId: "" }),
      request({ files: [] }),
      request({ files: [new File([""], "empty.png")] }),
      request({ files: Array.from({ length: 11 }, (_, i) => new File(["x"], `${i}.png`)) }),
    ];
    for (const r of bad) expect((await handleDirectCostPanelAttach(r, env, fakeSql(), user)).status).toBe(400);
    expect(calls.gets).toBe(0);
  });

  it("rejects an upload over 20 MB", async () => {
    procore({ reads: [dcBefore] });
    const big = new File([new Uint8Array(21 * 1024 * 1024)], "big.pdf");
    expect((await handleDirectCostPanelAttach(request({ files: [big] }), env, fakeSql(), user)).status).toBe(413);
  });
});
