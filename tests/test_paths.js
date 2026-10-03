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
  const kids = [], on = {};
  return new Proxy({ value: "", textContent: "", className: "", dataset: {}, style: {}, selectedIndex: -1, checked: false,
    addEventListener(type, fn) { (on[type] = on[type] || []).push(fn); }, fire: (type) => Promise.all((on[type] || []).map((fn) => fn({}))),
    appendChild(c) { kids.push(c); return c; }, setAttribute() {}, getAttribute() { return null; },
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
  let fakeSel = { left: 10, top: 20, right: 50, bottom: 60 }; // the document's selection (null = none)
  let selFill = (n) => new Uint8Array(n); // its pixels: all 0 unless a test says otherwise
  const batchPlay = async (cmds) => sent.push(...cmds) && cmds.map((c) => (c._obj === "get" && c._target[0]._property === "selection"
    ? { selection: fakeSel ? { left: { _value: fakeSel.left }, top: { _value: fakeSel.top }, right: { _value: fakeSel.right }, bottom: { _value: fakeSel.bottom } } : {} }
    : layerGone && c._obj === "get" && c._target[0]._property === "layerID" ? { _obj: "error", message: "The object is not currently available.", result: -25920 }
    : anything()));
  const getSelection = async ({ sourceBounds: b }) => {
    const w = b.right - b.left, h = b.bottom - b.top;
    return { sourceBounds: b, imageData: { width: w, height: h, getData: async () => selFill(w * h), dispose() {} } };
  };
  const ps = { app, core: { executeAsModal: (fn) => fn(anything()) }, action: { batchPlay, addNotificationListener: (evs, fn) => { onEvent = fn; } }, constants: anything(),
    imaging: withImaging ? withOverrides(anything(), { encodeImageData: async () => "AAAA", getSelection }) : undefined };
  // plugin folder = the real one, so the real workflow templates are read
  const realFolder = (dir) => ({ getEntry: async (name) => {
    const p = path.join(dir, name);
    return require("fs").statSync(p).isDirectory() ? realFolder(p) : { read: async () => require("fs").readFileSync(p, "utf8") };
  } });
  const written = {}; // file name -> last text written to the plugin's data folder (settings.json)
  const data = { getEntry: async () => { throw new Error("no settings yet"); }, createFile: async (name) => ({ nativePath: name, write: async (txt) => { written[name] = txt; } }) };
  let noFolders = false; // the fake disk has every folder, forever: scanning a ComfyUI folder would never end
  const lfs = withOverrides(anything(), { getPluginFolder: async () => realFolder(path.dirname(PLUGIN)), getDataFolder: async () => data,
    getEntryWithUrl: async () => { if (noFolders) throw new Error("no such folder"); return anything(); } });
  const uxp = { storage: { localFileSystem: lfs, formats: anything() }, entrypoints: anything(), shell: withOverrides(anything(), { openPath: async () => "" }) };
  const load = Module._load;
  Module._load = function (req, ...a) { return { photoshop: ps, uxp }[req] || load.call(this, req, ...a); };
  const m = new Module(PLUGIN);
  m.filename = PLUGIN;
  m.paths = Module._nodeModulePaths(path.dirname(PLUGIN));
  m._compile(require("fs").readFileSync(PLUGIN, "utf8") + "\n;panelShown = true; module.exports = { clean, detectMode, refreshAuto, detected: () => detected, refreshLive, autoPreview, showPreview, cancelJob, applyPreview, discardPreview, scrollToArea, loadModels, jobs, legacy, timing, fadeEdges, shown: () => preview, needs: () => needs };", PLUGIN);
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

  // Settings save themselves: a change is written at once, Back saves too, models are listed again only when the
  // ComfyUI URL / folder changed, and an empty picker never blanks a saved value
  const saved = () => JSON.parse(written["settings.json"] || "{}");
  await sleep(0);
  els.pad.value = "50"; await els.pad.fire("change");
  assert.strictEqual(saved().pad, "50", "a changed field is saved by itself");
  assert.strictEqual(els.savedTag.className, "saved", "and says so in the footer, which is always in view");
  els.legacy.checked = true; await els.legacy.fire("change");
  assert.strictEqual(saved().legacy, true, "a checkbox too");
  await els.model.fire("change"); await els.clip.fire("change");
  assert.ok(!("model" in saved()) && !("clip" in saved()), "an empty picker is not written (it would blank the saved model)");
  let fetched = 0;
  noFolders = true;
  global.fetch = () => { fetched++; return Promise.reject(new Error("offline")); };
  els.fade.value = "9"; await els.fade.fire("change");
  assert.strictEqual(fetched, 0, "a plain setting doesn't list the models again");
  els.url.value = "http://127.0.0.1:9999"; await els.url.fire("change");
  assert.ok(fetched > 0 && saved().url === "http://127.0.0.1:9999", "a changed URL is saved and ComfyUI is asked again");
  fetched = 0; await els.url.fire("change");
  assert.strictEqual(fetched, 0, "the same URL again: models are not listed again");
  els.comfyDir.value = "M:\\Comfy"; els.steps.value = "7"; // only typed: Back saves both
  await els.back.fire("click");
  assert.deepStrictEqual([saved().comfyDir, saved().steps], ["M:\\Comfy", "7"], "Back saves what was typed");
  assert.ok(fetched > 0, "Back lists the models again after a changed folder");
  assert.strictEqual(els.settingsView.className, "hidden", "and returns to the main view");
  // put everything back: the rest of the run needs the defaults (no folder to start ComfyUI from, not legacy)
  els.legacy.checked = false; await els.legacy.fire("change");
  for (const f of ["pad", "fade", "url", "comfyDir", "steps"]) { els[f].value = ""; await els[f].fire("change"); }
  noFolders = false;
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

  // a live result's row: its icons are made once and moved into every rebuilt row (a fresh <img> blinks), and the state
  // icon follows the pill's colour (a retry turns it amber) without a rebuild
  const live = { ...job, id: job.id + "L", state: "running", outcome: undefined, pid: null };
  P.jobs.unshift(live);
  onEvent("select");
  const [blue, amber] = live.stIcons;
  assert.deepStrictEqual([blue.pk, blue.style.display, amber.pk, amber.style.display], ["blue", "block", "amber", "none"], "running = blue clock");
  onEvent("select");
  assert.ok(live.stIcons[0] === blue && live.stIcons[1] === amber, "the row's icons are reused, not rebuilt");
  live.state = "retrying"; P.refreshLive();
  assert.deepStrictEqual([blue.style.display, amber.style.display], ["none", "block"], "retrying = amber refresh");
  live.state = "error"; live.error = "x"; onEvent("select");
  assert.deepStrictEqual(live.stIcons.map((i) => i.pk), ["red"], "a finished row has just its own state icon");
  P.jobs.splice(P.jobs.indexOf(live), 1); onEvent("select");

  // Auto mode (doc is 100 wide): a box across the whole width is a Clean, a smaller or other-shaped selection an Edit
  const box = { left: 0, top: 20, right: 100, bottom: 60 }, filled = (n) => new Uint8Array(n).fill(255);
  const halfFilled = (n) => Uint8Array.from({ length: n }, (_, i) => (i < n / 2 ? 255 : 0));
  selFill = filled;
  assert.strictEqual(await P.detectMode(doc, box), "clean", "a full-width box is a Clean");
  assert.strictEqual(await P.detectMode(doc, { ...box, left: 1, right: 99 }), "clean", "a pixel or two short of the edges still is");
  assert.strictEqual(await P.detectMode(doc, { ...box, right: 60 }), "edit", "a selection that stops short of the page width is an Edit");
  selFill = halfFilled;
  assert.strictEqual(await P.detectMode(doc, box), withImaging ? "edit" : "clean", "full width but not a box: an Edit (2022 path can't read pixels: width decides)");
  selFill = filled;
  els.mode.value = "auto";
  fakeSel = box; await P.refreshAuto();
  assert.strictEqual(P.detected(), "clean", "the panel follows the selection");
  assert.deepStrictEqual([els.goText.textContent, els.autoText.textContent], ["Clean selection", "Auto: Clean"], "and says what it will do");
  fakeSel = { left: 10, top: 20, right: 50, bottom: 60 }; await P.refreshAuto();
  assert.strictEqual(P.detected(), "edit", "a new selection is looked at again");
  assert.deepStrictEqual([els.goText.textContent, els.autoText.textContent], ["Edit selection", "Auto: Edit"]);
  fakeSel = null; await P.refreshAuto();
  assert.deepStrictEqual([P.detected(), els.goText.textContent, els.autoText.textContent], [null, "Clean / Edit selection", "Auto"], "no selection: neutral");
  const jobsBefore = P.jobs.length;
  for (const [b, want] of [[box, false], [{ left: 10, top: 20, right: 50, bottom: 60 }, true]]) { // the click decides, whatever the panel shows
    fakeSel = b; await P.clean();
    assert.strictEqual(P.jobs[0].edit, want, "auto: " + (want ? "Edit" : "Clean") + " at the click");
  }
  els.mode.value = "clean"; fakeSel = { left: 10, top: 20, right: 50, bottom: 60 }; await P.clean();
  assert.strictEqual(P.jobs[0].edit, false, "a manual Clean stays Clean for a small selection");
  els.mode.value = "edit"; fakeSel = box; await P.clean();
  assert.strictEqual(P.jobs[0].edit, true, "a manual Edit stays Edit for a full-width box");
  P.jobs.splice(0, P.jobs.length - jobsBefore); // the jobs made here go
  els.mode.value = ""; selFill = (n) => new Uint8Array(n); fakeSel = { left: 10, top: 20, right: 50, bottom: 60 };
  onEvent("select");

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

// every icon file used in the markup must exist (a typo only shows as a missing picture in Photoshop), and so must the
// two the empty list builds in index.js
const iconFiles = [...html.matchAll(/src="(icons\/[\w@.-]+)"/g)].map((m) => m[1]).concat(["icons/picture.svg", "icons/picture-light.svg"]);
for (const f of iconFiles) assert.ok(fs.existsSync(path.join(__dirname, "../plugin", f)), `missing icon file ${f}`);
// ... and the ones index.js builds for the result rows: ico(job, "file"), icoPair(job, "name") (+ "-light") and PILL_ICON
const js = fs.readFileSync(PLUGIN, "utf8");
for (const [, f] of js.matchAll(/\bico\(job, "([\w-]+)"/g)) iconFiles.push(`icons/${f}.svg`);
for (const [, f] of js.matchAll(/icoPair\(job, "([\w-]+)"/g)) iconFiles.push(`icons/${f}.svg`, `icons/${f}-light.svg`);
for (const [, f] of js.matchAll(/: "([a-z]+-(?:blue|amber|ok|err|grey))"/g)) iconFiles.push(`icons/${f}.svg`);
for (const f of iconFiles) assert.ok(fs.existsSync(path.join(__dirname, "../plugin", f)), `missing icon file ${f}`);
assert.ok(iconFiles.length > 60, "icons found in index.html and index.js: " + iconFiles.length);
assert.ok(iconFiles.length > 20, "icons found in index.html: " + iconFiles.length);
// the base rule that hides the light-theme icons must come BEFORE the light-theme media block (same specificity, the later
// rule wins): the other way round the light icons never showed, and dark-theme screenshots can't tell
assert.ok(html.indexOf(".ic.lt, .ic.wh {") > 0 && html.indexOf(".ic.lt, .ic.wh {") < html.indexOf("@media (prefers-color-scheme: light)"), "icon base rules go before the light-theme block");
// textContent on an element deletes everything inside it: no icon may sit in one (the main button's text is its own span)
for (const [, id] of fs.readFileSync(PLUGIN, "utf8").matchAll(/\$\("([\w-]+)"\)\.textContent\s*=/g)) {
  const at = html.indexOf(`id="${id}"`), after = html.slice(html.indexOf(">", at) + 1);
  assert.ok(!/<img/.test(after.slice(0, after.indexOf("</"))), `#${id} gets textContent from index.js but holds an <img>: it would be deleted`);
}

(async () => {
  await run(true);
  await run(false);
  process.exit(0); // the plugin's ComfyUI online poll (setInterval) would keep node running
})().catch((e) => { console.error(e.message); process.exit(1); });
