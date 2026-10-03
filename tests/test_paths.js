// node tests/test_paths.js -- runs clean() and the automatic preview of plugin/index.js against a fake Photoshop where every
// API call succeeds, once with the Imaging API (2023+) and once without (Photoshop 2022 path). Catches typos and
// undefined names (ReferenceError / TypeError) that only show up when a button is clicked in Photoshop.
const Module = require("module"), path = require("path"), assert = require("assert");
const PLUGIN = path.join(__dirname, "../plugin/index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  global.window = { addEventListener() {} };
  global.document = { getElementById: (id) => (els[id] = els[id] || fakeEl()), createElement: fakeEl, querySelectorAll: () => [], body: {} };
  global.fetch = () => Promise.reject(new Error("offline"));
  // a 100x200 document with a selection at 10,20 - 50,60
  const doc = withOverrides(anything(), { id: 1, width: 100, height: 200, title: "page.psd", zoom: 50 });
  const doc2 = withOverrides(anything(), { id: 2, width: 100, height: 200, title: "page2.psd" });
  const appState = { activeDocument: doc, documents: [doc, doc2] };
  const app = withOverrides(anything(), appState);
  let onEvent = null; // Photoshop's notification listener (document switched / closed)
  const sent = []; // every batchPlay command, newest last
  let layerGone = false; // the preview layer was undone / deleted in Photoshop
  const batchPlay = async (cmds) => sent.push(...cmds) && cmds.map((c) => (c._obj === "get" && c._target[0]._property === "selection"
    ? { selection: { left: { _value: 10 }, top: { _value: 20 }, right: { _value: 50 }, bottom: { _value: 60 } } }
    : layerGone && c._obj === "get" && c._target[0]._property === "layerID" ? { _obj: "error", message: "The object is not currently available.", result: -25920 }
    : anything()));
  const getSelection = async ({ sourceBounds: b }) => {
    const w = b.right - b.left, h = b.bottom - b.top;
    return { sourceBounds: b, imageData: { width: w, height: h, getData: async () => new Uint8Array(w * h), dispose() {} } };
  };
  const ps = { app, core: { executeAsModal: (fn) => fn(anything()) }, action: { batchPlay, addNotificationListener: (evs, fn) => { onEvent = fn; } }, constants: anything(),
    imaging: withImaging ? withOverrides(anything(), { encodeImageData: async () => "AAAA", getSelection }) : undefined };
  // plugin folder = the real one, so the real workflow templates are read
  const realFolder = (dir) => ({ getEntry: async (name) => {
    const p = path.join(dir, name);
    return require("fs").statSync(p).isDirectory() ? realFolder(p) : { read: async () => require("fs").readFileSync(p, "utf8") };
  } });
  const lfs = withOverrides(anything(), { getPluginFolder: async () => realFolder(path.dirname(PLUGIN)) });
  const uxp = { storage: { localFileSystem: lfs, formats: anything() }, entrypoints: anything(), shell: withOverrides(anything(), { openPath: async () => "" }) };
  const load = Module._load;
  Module._load = function (req, ...a) { return { photoshop: ps, uxp }[req] || load.call(this, req, ...a); };
  const m = new Module(PLUGIN);
  m.filename = PLUGIN;
  m.paths = Module._nodeModulePaths(path.dirname(PLUGIN));
  m._compile(require("fs").readFileSync(PLUGIN, "utf8") + "\n;panelShown = true; module.exports = { clean, autoPreview, showPreview, cancelJob, applyPreview, discardPreview, scrollToArea, loadModels, jobs, legacy, timing, fadeEdges, shown: () => preview, needs: () => needs };", PLUGIN);
  Module._load = load;
  const P = m.exports;
  assert.strictEqual(P.legacy(), !withImaging, "legacy() picks the path from the Imaging API");

  // an old ComfyUI without custom nodes: a Klein model loads, the user is told what to install
  const oldComfy = { UNETLoader: { input: { required: { unet_name: [["flux-2-klein-9b.safetensors"]] } } },
    CLIPLoader: { input: { required: { clip_name: [["qwen_3_8b.safetensors"]] } } }, VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors"]] } } } };
  global.fetch = async () => ({ ok: true, json: async () => oldComfy });
  assert.strictEqual(await P.loadModels(), true, "connected");
  assert.deepStrictEqual(P.needs().map((m) => m.name), ["Update ComfyUI", "comfyui-inpaint-nodes"]);
  assert.ok(/Install in ComfyUI: Update ComfyUI/.test(els.status.textContent), "main view says what to install: " + els.status.textContent);
  global.fetch = () => Promise.reject(new Error("offline"));

  // timing: elapsed since the click; time left from the sampler's pace (2 of 4 steps in 10s -> ~10s left)
  const now = Date.now();
  assert.strictEqual(P.timing({ time: new Date(now - 25000), state: "queued" }), " · 25s");
  assert.strictEqual(P.timing({ time: new Date(now - 75000), state: "running", progress: "2/4", sampleStart: now - 10000, tick: now }),
    " · 1m 15s · ~10s left");
  assert.ok(!/left/.test(P.timing({ time: new Date(now), state: "running", progress: "4/4", sampleStart: now - 9, tick: now })), "no estimate once sampling is done");

  // Edit: top and bottom rows fade in (h 100 -> 7px ramp), the middle and the original selection stay untouched
  const sel = new Uint8Array(2 * 100).fill(255), faded = P.fadeEdges(sel, 2, 100, 7);
  const col = (y) => faded[y * 2];
  assert.ok(col(0) > 0 && col(0) < col(1) && col(6) < 255 && col(7) === 255 && col(50) === 255, "ramp: " + [0, 1, 6, 7].map(col));
  assert.ok(col(99) === col(0) && col(93) === col(6) && col(92) === 255, "bottom mirrors top");
  assert.strictEqual(sel[0], 255, "job.sel itself is not changed");
  assert.deepStrictEqual(P.fadeEdges(sel, 2, 100, 0), sel, "0 = off");
  assert.ok(P.fadeEdges(sel, 2, 100, 15)[14 * 2] < 255 && P.fadeEdges(sel, 2, 100, 15)[15 * 2] === 255, "15% -> 15px ramp");

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

  // double click on a result: placed once, not twice (the second preview layer stayed in the document)
  const placed = () => sent.filter((c) => (c._obj === "make" && c.using && c.using.name === "Clean preview") || c._obj === "paste").length;
  const placedBefore = placed();
  await Promise.all([P.showPreview(third), P.showPreview(third)]);
  assert.strictEqual(placed() - placedBefore, 1, "double click places the result once");
  // undone with Ctrl+Z (a "select" event) or deleted by hand: the plugin forgets the preview, new results preview again
  onEvent("select"); await sleep(0);
  assert.strictEqual(P.shown() && P.shown().job, third, "preview kept while its layer is there");
  layerGone = true; onEvent("select"); await sleep(0); layerGone = false;
  assert.strictEqual(P.shown(), null, "preview forgotten once its layer is gone");

  // Variants: 3 results from one click, sharing one read of the page; own id / seed / channel each
  const before = P.jobs.length;
  els.variations.value = "3";
  await P.clean().catch((e) => { throw new Error("clean x3 threw: " + e.stack); });
  const vs = P.jobs.slice(0, 3);
  assert.strictEqual(P.jobs.length, before + 3, "3 results from one click");
  assert.deepStrictEqual(vs.map((j) => j.vn), ["1/3", "2/3", "3/3"], "variant order, first on top");
  assert.strictEqual(new Set(vs.map((j) => j.id)).size, 3, "unique ids (upload names)");
  assert.ok(vs.every((j) => j.sel === vs[0].sel && j.jpeg === vs[0].jpeg), "page read once and shared");
  assert.ok(vs.every((j) => /ComfyUI|not reachable|isn't running|No ComfyUI/i.test(j.error)), "each ran on its own: " + vs.map((j) => j.error));
  if (!withImaging) assert.strictEqual(new Set(vs.map((j) => j.chan)).size, 3, "2022 path: a channel per variant");
  els.variations.value = "1";
  for (const j of vs) P.jobs.splice(P.jobs.indexOf(j), 1);
  onEvent("select"); // redraw the list without them

  // clicking a result scrolls to its area (selection 10,20 - 50,60) at the current zoom (50%), zoom untouched
  await P.scrollToArea(job);
  const scroll = sent.filter((c) => c._obj === "set" && c._target[0]._property === "center").pop();
  assert.ok(scroll, "view scroll command sent");
  assert.deepStrictEqual([scroll.to.horizontal._value, scroll.to.vertical._value], [15, 20], "area center x zoom");
  assert.ok(!sent.some((c) => c._target && c._target[0] && c._target[0]._property === "zoom" && c._obj === "set"), "zoom never set");

  // the list follows the document tab; closing a document drops its finished results
  const count = () => els.count.textContent;
  assert.strictEqual(count(), "3", "page.psd has its 3 results");
  appState.activeDocument = doc2; onEvent("select");
  assert.strictEqual(count(), "0", "page2.psd shows only its own results");
  const running = { ...job, id: job.id + "r", state: "running", outcome: undefined, pid: null };
  P.jobs.unshift(running); // still being made when page.psd closes
  appState.documents = [doc2]; onEvent("close"); // page.psd closed
  assert.strictEqual(P.jobs.length, 0, "all of a closed document's results are dropped at once");
  assert.ok(running.cancelled, "its running job is cancelled in ComfyUI");

  // Cancel while the plugin is starting ComfyUI: the job goes at once, not once ComfyUI is up (up to 3 minutes).
  // Last: ComfyUI stays "starting" in this run from here on
  els.comfyDir.value = "M:\\ComfyUI_windows_portable"; // ComfyUI off + its folder set = the plugin starts it
  const cleaning = P.clean();
  await sleep(50);
  const waiting = P.jobs[0];
  assert.strictEqual(waiting.state, "starting", "job waits for ComfyUI to start");
  await P.cancelJob(waiting);
  await Promise.race([cleaning, sleep(3000).then(() => { throw new Error("Cancel waited for ComfyUI to start"); })]);
  assert.ok(!P.jobs.includes(waiting), "cancelled job is gone");
  console.log(`${withImaging ? "imaging" : "2022"} path ok`);
}

// every $("id") in index.js must exist in index.html: in Photoshop a missing one is null, and a top-level
// $("x").addEventListener would stop the whole file from loading (the fake DOM above can't notice)
const fs = require("fs");
const html = fs.readFileSync(path.join(__dirname, "../plugin/index.html"), "utf8");
for (const [, id] of fs.readFileSync(PLUGIN, "utf8").matchAll(/\$\("([\w-]+)"\)/g)) {
  assert.ok(html.includes(`id="${id}"`), `index.js uses #${id}, missing in index.html`);
}

(async () => {
  await run(true);
  await run(false);
  process.exit(0); // the plugin's ComfyUI online poll (setInterval) would keep node running
})().catch((e) => { console.error(e.message); process.exit(1); });
