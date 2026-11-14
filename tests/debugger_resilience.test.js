const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT_DIR = path.resolve(__dirname, "..");

function bootDbgHarness({ attachError = null, attachOnSecond = null } = {}) {
  const listeners = {};
  const L = (name) => ({
    addListener: (f) => {
      (listeners[name] = listeners[name] || []).push(f);
    },
    removeListener() {},
  });
  const calls = [];
  const timeouts = [];
  let attachCount = 0;
  let nextTimerId = 1;

  const tab = {
    id: 42,
    windowId: 10,
    url: "https://x.com/compose/post",
    title: "Post / X",
    status: "complete",
    active: true,
    discarded: false,
  };

  const fakeInp = {
    files: null,
    events: [],
    dispatchEvent(ev) {
      this.events.push(ev.type);
    },
  };

  const chrome = {
    tabs: {
      get: async (id) => {
        if (id !== tab.id) throw new Error("No tab with id: " + id);
        return Object.assign({}, tab);
      },
      query: async () => [Object.assign({}, tab)],
      onActivated: L("tabs.activated"),
      onUpdated: L("tabs.updated"),
      onRemoved: L("tabs.removed"),
    },
    permissions: { contains: async () => true },
    alarms: { create() {}, onAlarm: L("alarm") },
    runtime: { id: "ext-self", reload() {}, onStartup: L("startup"), onInstalled: L("installed") },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    webRequest: { onErrorOccurred: L("wr.err"), onCompleted: L("wr.done") },
    scripting: {
      executeScript: async ({ target, world, func, args }) => {
        calls.push(["exec", target.tabId, world || "ISOLATED", func && func.name]);
        if (func && func.name === "rkGuardInPage") {
          return [{ result: { title: tab.title, domSignals: [], alertTexts: [], bodyText: "", bodyLen: 2000 } }];
        }
        class FakeFile {
          constructor(parts, name, opts) {
            this.parts = parts;
            this.name = name;
            this.type = opts && opts.type;
          }
        }
        class FakeDataTransfer {
          constructor() {
            this._items = [];
            const self = this;
            this.items = { add: (f) => self._items.push(f) };
          }
          get files() {
            return this._items;
          }
        }
        const fakeCtx = vm.createContext({
          document: { querySelector: (sel) => (sel.includes("file") ? fakeInp : null) },
          DataTransfer: FakeDataTransfer,
          File: FakeFile,
          Event: class {
            constructor(type, opts) {
              this.type = type;
              this.opts = opts;
            }
          },
          Uint8Array,
          atob: (s) => Buffer.from(s, "base64").toString("binary"),
          Date,
        });
        const fn = vm.runInContext(`(${String(func)})`, fakeCtx);
        return [{ result: await fn(...(args || [])) }];
      },
    },
    debugger: {
      onEvent: L("dbg.event"),
      onDetach: L("dbg.detach"),
      attach: async (target) => {
        attachCount += 1;
        calls.push(["dbg.attach", target.tabId, attachCount]);
        if (attachOnSecond && attachCount >= 2 && attachOnSecond instanceof Error) throw attachOnSecond;
        const err = typeof attachError === "function" ? attachError(attachCount) : attachError;
        if (err) throw err;
      },
      detach: async (target) => {
        calls.push(["dbg.detach", target.tabId]);
      },
      sendCommand: async (target, cmd, params) => {
        calls.push(["dbg.cmd", target.tabId, cmd, params]);
        await new Promise((r) => globalThis.setTimeout(r, 10));
        return {};
      },
      getTargets: async () => [{ id: "t1", tabId: tab.id, attached: attachCount > 0, extensionId: "ext-self" }],
    },
  };

  const ctx = vm.createContext({
    chrome,
    console,
    URL,
    Date,
    JSON,
    Promise,
    Math,
    Map,
    Set,
    Error,
    String,
    Number,
    Array,
    Object,
    RegExp,
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timeouts.push({ id, ms, fn, cleared: false });
      return id;
    },
    clearTimeout: (id) => {
      const hit = timeouts.find((t) => t.id === id);
      if (hit) hit.cleared = true;
    },
    setInterval: () => 0,
    clearInterval() {},
    WebSocket: class {
      constructor() {
        this.readyState = 0;
      }
      send() {}
    },
  });
  ctx.WebSocket.OPEN = 1;
  ctx.WebSocket.CONNECTING = 0;
  ctx.importScripts = (...fs_) =>
    fs_.forEach((f) => vm.runInContext(fs.readFileSync(path.join(EXT_DIR, f), "utf8"), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, "background.js"), "utf8"), ctx, { filename: "background.js" });

  return {
    api: vm.runInContext("({ handleCommand, withDebugger, H })", ctx),
    calls,
    timeouts,
    fakeInp,
    fireDetach: (reason) => (listeners["dbg.detach"] || []).forEach((f) => f({ tabId: tab.id }, reason)),
  };
}

test("withDebugger serializa concurrencia por pestaña sin re-attach ni detach prematuro", async () => {
  const b = bootDbgHarness();
  b.timeouts.length = 0;
  const trace = [];
  const p1 = b.api.withDebugger(42, async () => {
    trace.push("start:1");
    await new Promise((r) => setTimeout(r, 25));
    trace.push("end:1");
    return "r1";
  });
  const p2 = b.api.withDebugger(42, async () => {
    trace.push("start:2");
    await new Promise((r) => setTimeout(r, 5));
    trace.push("end:2");
    return "r2";
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1, "r1");
  assert.strictEqual(r2, "r2");
  assert.deepStrictEqual(trace, ["start:1", "end:1", "start:2", "end:2"]);
  assert.strictEqual(b.calls.filter((c) => c[0] === "dbg.attach").length, 1);
  // Sólo se programó 1 timer activo (para el último release), sin detach entre A y B
  const activeDetachTimers = b.timeouts.filter((t) => !t.cleared && t.ms === 4000);
  assert.strictEqual(activeDetachTimers.length, 1);
  assert.strictEqual(b.calls.filter((c) => c[0] === "dbg.detach").length, 0);
});

test("onDetach canceled_by_user y error de attach quedan expuestos en health/debug_info y dbgReason", async () => {
  const b = bootDbgHarness({
    attachError: (n) => (n === 1 ? new Error("Cannot attach to this target: canceled_by_user") : null),
  });
  const rFail = await b.api.handleCommand({ action: "cdp_type", tabId: 42, text: "hola" });
  assert.strictEqual(rFail.ok, false);
  assert.strictEqual(rFail.status, "debugger_error");
  assert.strictEqual(rFail.dbgReason, "canceled_by_user");

  const h1 = await b.api.handleCommand({ action: "health" });
  assert.strictEqual(JSON.stringify(h1.debuggerCanceledTabs), "[42]");

  b.fireDetach("canceled_by_user");
  const di1 = await b.api.handleCommand({ action: "debug_info" });
  assert.strictEqual(di1.detachedTabs["42"].reason, "canceled_by_user");

  // Cuando luego reconecta OK, limpia el estado de cancelado
  const rOk = await b.api.handleCommand({ action: "cdp_type", tabId: 42, text: "ok" });
  assert.strictEqual(rOk.ok, true, "expected cdp_type ok, got: " + JSON.stringify(rOk));
  const h2 = await b.api.handleCommand({ action: "health" });
  assert.strictEqual(JSON.stringify(h2.debuggerCanceledTabs), "[]");
});

test("upload usa fallback DataTransfer en mundo MAIN cuando debugger falla con filePayloads", async () => {
  const b = bootDbgHarness({
    attachError: new Error("Cannot attach to this target: canceled_by_user"),
  });
  const r = await b.api.handleCommand({
    action: "upload",
    tabId: 42,
    selector: 'input[type="file"]',
    files: ["/tmp/demo.png"],
    filePayloads: [{ name: "demo.png", type: "image/png", dataBase64: Buffer.from("PNGDATA").toString("base64") }],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fallback, "data_transfer");
  assert.strictEqual(r.fallbackReason, "canceled_by_user");
  assert.deepStrictEqual(r.files, ["demo.png"]);
  assert.strictEqual(b.fakeInp.files.length, 1);
  assert.strictEqual(b.fakeInp.files[0].name, "demo.png");
  assert.deepStrictEqual(b.fakeInp.events, ["input", "change"]);
});
