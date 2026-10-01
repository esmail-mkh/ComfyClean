// node tests/test_paths.js -- runs clean() and the automatic preview of plugin/index.js against a fake Photoshop where every
// API call succeeds, once with the Imaging API (2023+) and once without (Photoshop 2022 path). Catches typos and
// undefined names (ReferenceError / TypeError) that only show up when a button is clicked in Photoshop.
const Module = require("module"), path = require("path"), assert = require("assert");
const PLUGIN = path.join(__dirname, "../plugin/index.js");

// any property / call / await works and gives "anything" again; numbers come out as 10
function anything() {
  const f = function () { return Promise.resolve(anything()); };
  return new Proxy(f, {
    get(t, k) {
      if (k === "then") return undefined; // not a promise itself, so `await anything()` resolves
      if (k === Symbol.iterator) return function* () { yield anything(); };
      if (k === Symbol.toPrimitive) return (hint) => (hint === "string" ? "x" : 10);
      if (k === "length") return 4;
      return anything();
    },
    set() { return true; },
  });
}

const withOverrides = (base, o) => new Proxy(base, { get: (t, k) => (k in o ? o[k] : t[k]) });

function fakeEl() {
  const kids = [];
  return new Proxy({ value: "", textContent: "", className: "", dataset: {}, style: {}, selectedIndex: -1, checked: false,
    addEventListener() {}, appendChild(c) { kids.push(c); return c; }, setAttribute() {}, getAttribute() { return null; },
    removeAttribute() {}, hasAttribute() { return false; }, contains() { return true; },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; } }, { set(t, k, v) { t[k] = v; return true; } });
}

async function run(withImaging) {
  const els = {};
  global.document = { getElementById: (id) => (els[id] = els[id] || fakeEl()), createElement: fakeEl, querySelectorAll: () => [], body: {} };
  global.fetch = () => Promise.reject(new Error("offline"));
  // a 100x200 document with a selection at 10,20 - 50,60
  const doc = withOverrides(anything(), { id: 1, width: 100, height: 200, title: "page.psd" });
  const app = withOverrides(anything(), { activeDocument: doc, documents: [doc] });
  const batchPlay = async (cmds) => cmds.map((c) => (c._obj === "get" && c._target[0]._property === "selection"
    ? { selection: { left: { _value: 10 }, top: { _value: 20 }, right: { _value: 50 }, bottom: { _value: 60 } } } : anything()));
  const getSelection = async ({ sourceBounds: b }) => {
    const w = b.right - b.left, h = b.bottom - b.top;
    return { sourceBounds: b, imageData: { width: w, height: h, getData: async () => new Uint8Array(w * h), dispose() {} } };
  };
  const ps = { app, core: { executeAsModal: (fn) => fn(anything()) }, action: { batchPlay }, constants: anything(),
    imaging: withImaging ? withOverrides(anything(), { encodeImageData: async () => "AAAA", getSelection }) : undefined };
  const uxp = { storage: { localFileSystem: anything(), formats: anything() }, entrypoints: anything(), shell: anything() };
  const load = Module._load;
  Module._load = function (req, ...a) { return { photoshop: ps, uxp }[req] || load.call(this, req, ...a); };
  const m = new Module(PLUGIN);
  m.filename = PLUGIN;
  m.paths = Module._nodeModulePaths(path.dirname(PLUGIN));
  m._compile(require("fs").readFileSync(PLUGIN, "utf8") + "\n;module.exports = { clean, autoPreview, applyPreview, discardPreview, jobs, legacy, shown: () => preview };", PLUGIN);
  Module._load = load;
  const P = m.exports;
  assert.strictEqual(P.legacy(), !withImaging, "legacy() picks the path from the Imaging API");

  await P.clean().catch((e) => { throw new Error("clean threw: " + e.stack); });
  const job = P.jobs[0];
  // offline ComfyUI ends the job with an error; anything else (ReferenceError, TypeError...) is a bug in the code
  assert.ok(/ComfyUI|not reachable|isn't running|No ComfyUI/i.test(job.error), `clean (${withImaging ? "imaging" : "2022"}): ${job.error}`);
  assert.strictEqual(!!job.chan, !withImaging, "2022 path keeps the selection in a channel");

  Object.assign(job, { state: "ready", thumb: "data:image/png;base64,iVBORw0KGgo=" });
  await P.autoPreview(job); // finished job in the active document: shown right away
  assert.strictEqual(P.shown() && P.shown().job, job, "new result is previewed automatically");
  const second = { ...job, id: job.id + "b" };
  P.jobs.unshift(second); // finished while the first is on screen
  await P.autoPreview(second); // another result already on screen: not replaced
  assert.strictEqual(P.shown().job, job, "auto preview doesn't replace the result on screen");
  await P.discardPreview(true); // Discard -> the waiting one comes up by itself
  assert.strictEqual(job.outcome, "discarded");
  assert.strictEqual(P.shown() && P.shown().job, second, "next waiting result is previewed after Discard");
  const third = { ...job, id: job.id + "c", outcome: undefined };
  P.jobs.unshift(third);
  await P.applyPreview(); // Apply -> nothing comes up, even with one waiting
  assert.strictEqual(second.outcome, "applied");
  assert.strictEqual(P.shown(), null, "Apply doesn't show the next result");
  console.log(`${withImaging ? "imaging" : "2022"} path ok`);
}

(async () => {
  await run(true);
  await run(false);
})().catch((e) => { console.error(e.message); process.exit(1); });
