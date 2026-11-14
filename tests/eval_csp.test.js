const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT_DIR = path.resolve(__dirname, "..");

function bootEvalHarness({ cspBlocked = false, returnRawNull = false } = {}) {
  const L = () => ({ addListener() {} });
  const tab = {
    id: 101,
    windowId: 10,
    url: "https://x.com/home",
    title: "Home / X",
    status: "complete",
    active: true,
    discarded: false,
  };
  const chrome = {
    tabs: {
      get: async (id) => (id === tab.id ? tab : null),
      query: async () => [tab],
      onActivated: L(),
      onUpdated: L(),
    },
    permissions: { contains: async () => true },
    debugger: {
      attach: async () => {
        throw new Error("Debugger is not attached to the tab with id: 101.");
      },
      sendCommand: async () => {
        throw new Error("Debugger is not attached");
      },
      detach: async () => {},
      getTargets: async () => [],
      onEvent: L(),
      onDetach: L(),
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        if (returnRawNull) return [{ result: null }];
        const src = String(func);
        // En entorno CSP bloqueado, eval y Function dentro del sandbox lanzan EvalError.
        if (cspBlocked) {
          const wrappedFn = new vm.Script(
            `(${src})`,
            { filename: "inpage_csp.js" }
          );
          const blockedCtx = vm.createContext({
            eval: () => {
              const err = new EvalError("Evaluating a string as JavaScript violates the following Content Security Policy directive");
              throw err;
            },
            Function: function () {
              throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive");
            },
          });
          const fn = wrappedFn.runInContext(blockedCtx);
          return [{ result: await fn(...(args || [])) }];
        }
        return [{ result: await func(...(args || [])) }];
      },
    },
    cookies: { getAll: async () => [] },
    alarms: { create() {}, onAlarm: L() },
    runtime: { id: "test-ext-id", onInstalled: L(), onStartup: L(), onMessage: L() },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    webRequest: { onCompleted: L(), onErrorOccurred: L() },
  };

  class FakeWS {
    constructor() {
      this.readyState = 3;
    }
    send() {}
  }
  FakeWS.OPEN = 1;
  FakeWS.CONNECTING = 0;

  const ctx = vm.createContext({
    chrome,
    WebSocket: FakeWS,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    URL,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    console,
    importScripts: (...files) => {
      for (const f of files) {
        vm.runInContext(fs.readFileSync(path.join(EXT_DIR, f), "utf8"), ctx, { filename: f });
      }
    },
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.EvalError = EvalError;
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, "background.js"), "utf8"), ctx, {
    filename: "background.js",
  });
  return vm.runInContext("({ handleCommand, H })", ctx);
}

test("cdpEval devuelve ok:false status:csp_blocked cuando CSP bloquea eval/Function", async () => {
  const ctx = bootEvalHarness({ cspBlocked: true });
  const res = await ctx.handleCommand({ action: "eval", tabId: 101, js: "1+1" });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, "csp_blocked");
  assert.match(res.error, /Content Security Policy|EvalError/i);
});

test("cdpEval preserva null legitimo cuando el sitio permite eval", async () => {
  const ctx = bootEvalHarness({ cspBlocked: false });
  const res = await ctx.handleCommand({ action: "eval", tabId: 101, js: "null" });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.result, null);
  const resNum = await ctx.handleCommand({ action: "eval", tabId: 101, js: "2+3" });
  assert.strictEqual(resNum.ok, true);
  assert.strictEqual(resNum.result, 5);
});

test("cdpEval falla cerrado como debugger_error si executeScript devuelve null crudo tras fallo CDP", async () => {
  const ctx = bootEvalHarness({ returnRawNull: true });
  const res = await ctx.handleCommand({ action: "eval", tabId: 101, js: "1+1" });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, "debugger_error");
});
