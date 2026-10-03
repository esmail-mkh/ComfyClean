const { app, core, imaging, action, constants } = require("photoshop");
const uxp = require("uxp");
const { localFileSystem: fs, formats } = uxp.storage;
const models = require("./models.js");

const $ = (id) => document.getElementById(id);
const MAIN_FIELDS = ["mode", "prompt", "variations"]; // auto-saved as you use them
const SETTINGS = ["pad", "stuck", "url", "comfyDir", "model", "clip", "vae", "steps", "colorMatch", "fade"]; // saved with the Save button
const CLIENT = "ps_clean_" + Date.now();
const SRGB = "sRGB IEC61966-2.1";
// up here, not next to b64decode: if any top-level line below throws in Photoshop, consts after it stay
// uninitialized ("Cannot access 'B64' before initialization" when cleaning)
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// newest first; every result of this Photoshop session (memory only, gone when Photoshop closes).
// ponytail: each result keeps its PNG as a data URL (~1-3 MB); a very long session grows memory, Clear frees it
const jobs = [];
let filter = "all"; // results filter: all | new | applied
let preview = null; // { job, docId, layerId } -- the result currently shown in its document
let placing = false; // a preview is being placed right now
let scrolledFor = null; // the previewed result last scrolled into view in the list
let needs = []; // custom nodes / ComfyUI update to install (checkNodes)
let downloads = []; // text encoder / VAE files the selected model still needs (showAutoPicks)
let jobSeq = 0;
let ws = null;
let objectInfo = null; // ComfyUI /object_info, cached by loadModels
let listInfo = null; // what the model pickers show: objectInfo, or the ComfyUI folder scan while ComfyUI is off
let templates = null; // plugin/workflows/*.json
let starting = null; // shared promise while the plugin is starting ComfyUI

// first-run presets; after that the user's list lives in settings.json (cfg.presets)
const DEFAULT_PRESETS = [
  { name: "Text (auto)", prompt: "Remove all text, lettering and sound effects (like GRRR or BOOM) of any size or style, with their outlines and shadows. Fill where each letter was with exactly what is directly around it: if the area around the text is flat and plain, keep it flat and plain with the same color; if it is artwork, continue its lines, colors, texture and screentone. Do not add anything new. Do not change anything else; keep every other line, color and detail identical." },
  { name: "Text (auto), keep SFX", prompt: "Remove all text and lettering, but keep sound effects (like GRRR or BOOM) exactly as they are. Fill where each letter was with exactly what is directly around it: if the area around the text is flat and plain, keep it flat and plain with the same color; if it is artwork, continue its lines, colors, texture and screentone. Do not add anything new. Do not change anything else; keep every other line, color and detail identical." },
  { name: "Text, keep bubble", prompt: "Remove all text and lettering. Keep the speech bubble exactly as it is: same shape, outline, tail and white fill. Fill where the text was with the same clean background as the rest of the bubble. Do not change anything else; keep every line, color and detail identical." },
  { name: "Text", prompt: "Remove all text and lettering. Fill where the text was with the background around it, matching its color, texture and lines. Do not change anything else." },
  { name: "Text + bubble", prompt: "Remove the speech bubble and all text in it. Restore the artwork behind it so it continues naturally from the surroundings. Do not change anything else." },
  { name: "SFX", prompt: "Remove the sound effect lettering. Restore the artwork behind it so it continues naturally from the surroundings, with the same lines, colors and screentone. Do not change anything else." },
  { name: "Watermark", prompt: "Remove the entire watermark completely: every letter, logo, icon, outline, shadow and semi-transparent overlay, plus any box, frame or plate it sits on. Leave no faint trace, ghost, blur or smudge. Restore the artwork behind it exactly as if the watermark was never there, continuing every line, edge, color, gradient, texture and screentone from the surroundings. Do not change anything else." },
  { name: "Object", prompt: "Remove the selected object. Fill the area with what should be behind it, matching the surroundings. Do not change anything else." },
];
const presets = () => cfg.presets || DEFAULT_PRESETS;

// render() does nothing while the panel is closed: touching a hidden panel's DOM made its spot in the workspace
// flicker whenever a document was closed or switched (show() renders to catch up)
let panelShown = false;

// "Clean selection" is also a Plugins-menu command, so it can get a keyboard shortcut
uxp.entrypoints.setup({
  // from a shortcut the panel may be hidden, so problems also get an alert
  commands: { clean: () => clean().catch((e) => { fail(e); app.showAlert(e.message || String(e)); }) },
  panels: {
    main: {
      show(node) { if (node && node !== document.body && !node.contains($("app"))) node.appendChild($("app")); panelShown = true; rememberPanel(true); render(); }, // render: catch up on documents switched meanwhile
      hide() { panelShown = false; rememberPanel(false); },
    },
  },
});

// settings live in a JSON file in the plugin's data folder, so they survive Photoshop restarts
let cfg = {};
let cfgReady = false; // settings.json read; writing before that would wipe it

// Photoshop doesn't reopen this panel after a restart, so the plugin does (start()) unless the user closed it.
// ponytail: quitting Photoshop hides the panel too; the delay lets the quit win so that isn't saved as "closed".
// A quit that takes over 2 s after hiding counts as a close; persist on destroy() if that bites.
let panelTimer = null;
function rememberPanel(open) {
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => {
    if (!cfgReady || cfg.panelOpen === open) return;
    cfg.panelOpen = open;
    writeCfg().catch(() => {});
  }, open ? 0 : 2000);
}
// "" = never set (e.g. model before the first Save): Back must not blank the auto-picked model
const load = (f) => (cfg[f] === undefined || cfg[f] === "" ? null : cfg[f]);
async function writeCfg() {
  const f = await (await fs.getDataFolder()).createFile("settings.json", { overwrite: true });
  await f.write(JSON.stringify(cfg, null, 2));
}
// Settings use Photoshop's Spectrum controls (sp-textfield / sp-picker): plain <input>/<select> render badly
// in panels, and a <select> filled from JS often doesn't show its options. Every read/write goes through val/setVal.
const PICKERS = new Set(["model", "clip", "vae", "presetPick", "modelQuick"]);
const menuItems = (id) => [...$(id).querySelectorAll("sp-menu-item")];
function val(id) {
  if (!PICKERS.has(id)) return $(id).value || "";
  const items = menuItems(id), i = $(id).selectedIndex;
  if (i >= 0 && items[i]) return items[i].getAttribute("value");
  const sel = items.find((m) => m.hasAttribute("selected"));
  return sel ? sel.getAttribute("value") : "";
}
function setVal(id, v) {
  if (!PICKERS.has(id)) { $(id).value = v; return; }
  const items = menuItems(id), i = items.findIndex((m) => m.getAttribute("value") === v);
  items.forEach((m, k) => (k === i ? m.setAttribute("selected", "") : m.removeAttribute("selected")));
  try { $(id).selectedIndex = i; } catch (e) {} // -1 = nothing selected (shows the placeholder)
}
function fillPicker(id, items) {
  const menu = $(id).querySelector("sp-menu");
  menu.innerHTML = "";
  for (const it of items) {
    const m = document.createElement("sp-menu-item");
    m.setAttribute("value", it.value);
    m.textContent = it.label;
    menu.appendChild(m);
  }
}
const save = (f) => { cfg[f] = val(f); writeCfg().catch(fail); };
const fillFields = (names) => { for (const f of names) if (load(f) !== null) setVal(f, load(f)); };

// manifest.json "version", in the footer and on the Settings page (a hand-typed number there stayed at 1.1.0)
const VERSION = (uxp.versions && uxp.versions.plugin) || "";
$("version").textContent = "v" + VERSION;
$("aboutName").textContent = "Comfy Clean " + VERSION;

function showSavedPicks() {
  for (const id of ["model", "clip", "vae"]) {
    const v = load(id) || (id === "model" ? "" : models.AUTO);
    if (v && !menuItems(id).length) { fillPicker(id, [{ value: v, label: v === models.AUTO ? "Auto" : v }]); setVal(id, v); }
  }
  mirrorModels();
}
// the main view's model dropdown lists the same items as the Settings one (render keeps its pick in step)
const mirrorModels = () => fillPicker("modelQuick", menuItems("model").map((m) => ({ value: m.getAttribute("value"), label: m.textContent })));

async function start() {
  try { cfg = JSON.parse(await (await (await fs.getDataFolder()).getEntry("settings.json")).read()); } catch (e) { cfg = {}; }
  cfgReady = true;
  if (cfg.panelOpen !== false) showPanel();
  fillFields(MAIN_FIELDS.concat(SETTINGS));
  fillChecks();
  showSavedPicks();
  // a picked preset is remembered by name, so an improved preset text (plugin update) shows up by itself
  const picked = presets().find((x) => x.name === cfg.presetName);
  if (picked) $("prompt").value = picked.prompt;
  if (!$("prompt").value) $("prompt").value = presets()[0] ? presets()[0].prompt : "";
  renderPresets();
  render();
  await loadModels().catch(() => {});
}

$("presetSave").addEventListener("click", () => {
  const name = val("presetName").trim(), prompt = $("prompt").value.trim();
  if (!name || !prompt) return status("Type a prompt and a preset name first.", true);
  cfg.presets = presets().filter((x) => x.name !== name).concat([{ name, prompt }]); // same name = overwrite
  writeCfg().catch(fail);
  setVal("presetName", "");
  $("presetAdd").className = "preset-add hidden";
  renderPresets();
  status(`Preset "${name}" saved.`);
});
$("presetCancel").addEventListener("click", () => { $("presetAdd").className = "preset-add hidden"; });
$("presetPick").addEventListener("change", () => {
  const pr = presets().find((x) => x.name === val("presetPick"));
  if (pr) { $("prompt").value = pr.prompt; cfg.presetName = pr.name; save("prompt"); render(); }
});
$("presetNew").addEventListener("click", () => { $("presetAdd").className = "preset-add"; });
$("presetDel").addEventListener("click", () => {
  const name = val("presetPick");
  if (!presets().some((x) => x.name === name)) return status("Pick a preset to delete first.", true);
  cfg.presets = presets().filter((x) => x.name !== name);
  writeCfg().catch(fail);
  renderPresets();
  status(`Preset "${name}" deleted.`);
});
$("prompt").addEventListener("change", () => {
  const pr = presets().find((x) => x.prompt === $("prompt").value.trim());
  cfg.presetName = pr ? pr.name : undefined; // edited by hand: no longer follows a preset
  save("prompt");
});
$("prompt").addEventListener("input", () => render());
$("prompt").addEventListener("keyup", () => fitPrompt()); // Enter doesn't always fire "input" in UXP
// click the prompt to edit it; leaving the box shows the scrolling view again
$("promptView").addEventListener("click", () => {
  const w = $("promptView").offsetWidth; // the textarea is as wide, but reads 0 until UXP has laid it out
  $("promptView").className = "prompt-view hidden";
  $("prompt").className = "";
  fitPrompt(w);
  setTimeout(() => $("prompt").focus(), 0); // the textarea has to be laid out first
});
$("prompt").addEventListener("blur", () => {
  $("prompt").className = "hidden";
  $("promptView").className = "prompt-view";
  render();
});
for (const b of document.querySelectorAll("#modeSeg div")) {
  b.addEventListener("click", () => { $("mode").value = b.dataset.v; save("mode"); render(); });
}
for (const b of document.querySelectorAll("#varSeg div")) {
  b.addEventListener("click", () => { $("variations").value = b.dataset.v; save("variations"); render(); });
}
const variations = () => Math.min(4, Math.max(1, +val("variations") || 1)); // results made per click, default 1
$("go").addEventListener("click", () => clean().catch(fail));
// Apply / Discard live on the previewed result's row (render); a preview open in another document shows this line
$("otherPreview").addEventListener("click", () => {
  const d = preview && findDoc(preview.docId);
  if (d) modal(() => { app.activeDocument = d; }).catch(fail); // the document switch re-renders the list
});

// separate settings page: gear opens it, Save writes the file, Back throws edits away
const showSettings = (on) => {
  $("mainView").className = on ? "hidden" : "";
  $("settingsView").className = on ? "" : "hidden";
  $("saveMsg").textContent = "";
  render(); // model row follows the Settings pick
};
$("gear").addEventListener("click", () => showSettings(true));
// a pick on the main view is saved right away and becomes the Settings pick too
$("modelQuick").addEventListener("change", () => {
  const v = val("modelQuick");
  if (!v || v === val("model")) return;
  setVal("model", v);
  save("model");
  showAutoPicks();
  render();
  if ($("dot").className === "dot ok") conn(true, v.replace(/\.(gguf|safetensors)$/, ""));
});
const fillChecks = () => { $("legacy").checked = !!cfg.legacy; $("autoPreview").checked = cfg.autoPreview !== false; }; // auto preview: on unless turned off
$("back").addEventListener("click", () => { fillFields(SETTINGS); fillChecks(); showSettings(false); });
$("saveSettings").addEventListener("click", async () => {
  for (const f of SETTINGS) cfg[f] = val(f);
  cfg.legacy = !!$("legacy").checked;
  cfg.autoPreview = !!$("autoPreview").checked;
  try {
    await writeCfg();
    await loadModels();
    showSettings(false);
    status("Settings saved.");
  } catch (e) {
    $("saveMsg").textContent = e.message || String(e);
  }
});
$("browseComfy").addEventListener("click", async () => {
  const folder = await fs.getFolder();
  if (!folder) return;
  setVal("comfyDir", folder.nativePath);
  testConnection();
});
const testConnection = () => loadModels()
  .then((live) => { $("saveMsg").textContent = live ? "Connected." : "ComfyUI is off. Models listed from its folder."; })
  .catch((e) => { $("saveMsg").textContent = e.message || String(e); });
$("reload").addEventListener("click", testConnection);
for (const f of ["model", "clip", "vae"]) $(f).addEventListener("change", () => showAutoPicks());
start();
// leftovers from a crash mid-place
fs.getTemporaryFolder().then(async (t) => {
  for (const e of await t.getEntries()) if (e.name.startsWith("ps_clean_")) await e.delete();
}).catch(() => {});

function status(msg, err) { $("status").textContent = msg; $("status").className = "status" + (err ? " err" : ""); }
function fail(e) { status(e.message || String(e), true); }
function conn(ok, text) { $("dot").className = "dot " + (ok ? "ok" : "off"); $("connText").textContent = text; }
const baseUrl = () => val("url").replace(/\/+$/, "");
const modal = (fn, name = "Comfy Clean") => core.executeAsModal(fn, { commandName: name });
const play = (cmds) => action.batchPlay(cmds, {});
const deselect = () => play([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }]);
const layerRef = (p) => [{ _ref: "layer", _id: p.layerId }, { _ref: "document", _id: p.docId }];
const findDoc = (id) => app.documents.find((d) => d.id === id);
const activeDocId = () => { try { return app.activeDocument ? app.activeDocument.id : null; } catch (e) { return null; } }; // null: none open
const clampRect = (b, doc) => ({
  left: Math.max(0, Math.floor(b.left)), top: Math.max(0, Math.floor(b.top)),
  right: Math.min(doc.width, Math.ceil(b.right)), bottom: Math.min(doc.height, Math.ceil(b.bottom)),
});

// model list = every Klein / Kontext / Fill file ComfyUI can load (GGUF, safetensors, Nunchaku);
// text encoder and VAE default to "Auto" = picked per model family by models.js.
// ComfyUI offline -> the same lists read from the ComfyUI folder on disk. Returns true when ComfyUI is live.
async function loadModels() {
  try { listInfo = objectInfo = await json(fetch(baseUrl() + "/object_info")); } catch (e) {
    conn(false, "ComfyUI offline");
    listInfo = await scanModels(val("comfyDir").trim().replace(/[\\/]+$/, "")).catch(() => null);
    if (!listInfo) throw new Error("ComfyUI not reachable. Start it, or set the ComfyUI folder in Settings to list its models.");
  }
  const live = listInfo === objectInfo;
  await checkNodes(live);
  const install = needs.filter((m) => m.required).map((m) => m.name).join(", ");
  const fill = (id, items, auto) => {
    const prev = val(id); // keep an unsaved pick when testing the connection
    if (auto) items = [{ value: models.AUTO, label: "Auto" }].concat(items);
    fillPicker(id, items);
    const want = prev || load(id) || (auto ? models.AUTO : "flux-2-klein-9b-Q4_K_S.gguf");
    setVal(id, items.some((it) => it.value === want) ? want : items[0] && items[0].value);
  };
  const tag = { flux2: "Klein", kontext: "Kontext", fill: "Fill" };
  const list = models.listModels(listInfo);
  if (!list.length) {
    throw new Error(install ? `No usable model. Install in ComfyUI: ${install} (links in Settings).`
      : `No Flux.2 Klein, Kontext or Fill model found in ${live ? "ComfyUI" : "the ComfyUI models folder"}.`);
  }
  fill("model", list.map((m) => ({ value: m.name, label: `${m.name}  (${tag[m.family]}${m.nunchaku ? ", Nunchaku" : ""})` })));
  mirrorModels();
  fill("clip", models.encoderList(listInfo).map((n) => ({ value: n, label: n })), true);
  fill("vae", models.vaeList(listInfo).map((n) => ({ value: n, label: n })), true);
  showAutoPicks();
  render(); // main view shows the picked model
  if (live) conn(true, val("model").replace(/\.(gguf|safetensors)$/, ""));
  status(live ? "Make a selection, then click " + ($("mode").value === "edit" ? "Edit." : "Clean.")
    : "ComfyUI is off: models listed from its folder. It starts on the first Clean.");
  if (install) status(`Install in ComfyUI: ${install} (links in Settings).`, true);
  else if (downloads.length) status(`This model still needs: ${downloads.map((f) => f.name).join(", ")} (download links in Settings).`, true);
  return live;
}

// Custom nodes (or a ComfyUI update) the user has to install, shown in Settings with links (models.missingNodes).
// .gguf files are invisible to ComfyUI without ComfyUI-GGUF, so the models folder on disk is scanned too.
async function checkNodes(live) {
  const disk = live ? await scanModels(val("comfyDir").trim().replace(/[\\/]+$/, "")).catch(() => null) : listInfo;
  const list = (cls, input) => (disk && disk[cls] ? disk[cls].input.required[input][0] : []);
  const files = list("UNETLoader", "unet_name").concat(list("CLIPLoader", "clip_name"));
  // node types the templates need from ComfyUI itself (1-3 = loaders, picked per model); unknown while offline
  const core = live ? Object.values(await loadTemplates())
    .flatMap((g) => Object.entries(g).filter(([id]) => !["1", "2", "3"].includes(id)).map(([, n]) => n.class_type)) : [];
  needs = models.missingNodes(listInfo, files, core);
  const box = $("needs");
  box.innerHTML = "";
  for (const m of needs) box.appendChild(needLine(m.name, m.url, m.why, m.required));
  if (needs.length) box.appendChild(el("div", "need", "Install with ComfyUI Manager (search the name) or git clone into ComfyUI/custom_nodes, then restart ComfyUI."));
}

// ComfyUI's own folders for each list (folder_paths.py); sub folders show as "sub\name" like ComfyUI on Windows.
// ponytail: extra_model_paths.yaml folders aren't read; they show up once ComfyUI is running
async function scanModels(dir) {
  if (!dir) return null;
  const root = (await comfyCommand(dir)).main.replace(/[\\/]main\.py$/i, "");
  const entries = async (path) => {
    try { return await (await fs.getEntryWithUrl("file:/" + path.replace(/\\/g, "/"))).getEntries(); } catch (e) { return []; }
  };
  const walk = async (path, rel, out) => {
    for (const e of await entries(path)) {
      if (e.isFolder) await walk(`${path}\\${e.name}`, `${rel}${e.name}\\`, out);
      else if (/\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i.test(e.name)) out.push(rel + e.name);
    }
    return out;
  };
  const files = async (...subs) => {
    const out = [];
    for (const s of subs) await walk(`${root}\\models\\${s}`, "", out);
    return [...new Set(out)].sort();
  };
  const nodes = (await entries(`${root}\\custom_nodes`)).filter((e) => e.isFolder).map((e) => e.name);
  return models.diskInfo({ unet: await files("diffusion_models", "unet"), enc: await files("text_encoders", "clip"), vae: await files("vae") }, nodes);
}

function showAutoPicks() {
  if (!listInfo) return;
  try {
    const r = models.resolve(listInfo, { model: val("model"), clip: val("clip"), vae: val("vae") });
    $("autoHint").textContent = `Uses: ${r.enc.main}${r.enc.clipL ? " + " + r.enc.clipL : ""} \u00b7 ${r.vae}`;
    $("autoHint").className = "hint";
  } catch (e) {
    $("autoHint").textContent = e.message;
    $("autoHint").className = "hint err";
  }
  // text encoder / VAE the selected model still needs, with download links
  downloads = models.missingFiles(listInfo, { model: val("model"), clip: val("clip"), vae: val("vae") });
  const box = $("needFiles");
  box.innerHTML = "";
  for (const f of downloads) box.appendChild(needLine(f.name, f.url, `download into ComfyUI/models/${f.folder}`, true));
  if (downloads.length) box.appendChild(el("div", "need", "Then click Test connection (no ComfyUI restart needed)."));
}

// "name (link): why" line for Settings; the name opens the page in the browser
function needLine(name, url, why, required) {
  const line = el("div", "need" + (required ? " req" : ""));
  const link = el("span", "need-link", name);
  link.addEventListener("click", () => Promise.resolve().then(() => uxp.shell.openExternal(url, "Download / install page of " + name)).catch(() => {}));
  line.appendChild(link);
  line.appendChild(el("span", "", ": " + why));
  return line;
}

async function loadTemplates() {
  if (templates) return templates;
  const dir = await (await fs.getPluginFolder()).getEntry("workflows");
  const t = {};
  for (const name of models.TEMPLATES) t[name] = JSON.parse(await (await dir.getEntry(name + ".json")).read());
  return (templates = t);
}

// ---------- jobs ----------

async function clean() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("No document open.");
  const sel = await selectionBounds(doc);
  if (!sel) throw new Error("Make a selection first.");

  const edit = $("mode").value === "edit";
  const pad = +val("pad") || 0;
  showPanel();
  // Only this crop goes to ComfyUI, so page height doesn't matter.
  // clean: full page width, selection's height band + context above/below. edit: just the selection box.
  const rect = edit ? clampRect(sel, doc)
    : clampRect({ left: 0, right: doc.width, top: sel.top - pad, bottom: sel.bottom + pad }, doc);
  const n = variations();
  const job = {
    id: `ps_clean_${Date.now()}_${++jobSeq}`, docId: doc.id, docName: doc.title, base: baseUrl(), time: new Date(),
    prompt: $("prompt").value.trim(), edit, rect, w: rect.right - rect.left, h: rect.bottom - rect.top, state: "reading",
    area: sel, // the selection's box: clicking the result scrolls the view to it
    vn: n > 1 ? `1/${n}` : "", // variant number shown on the row
  };
  jobs.unshift(job);
  render();

  try {
    await modal(async (ctx) => {
      if (legacy()) return ({ jpeg: job.jpeg, mask: job.mask } = await legacyRead(ctx, doc, job));
      // everything here is rolled back at the end: no history entry, preview layer comes back
      const sid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Comfy Clean read" });
      try {
        if (preview && preview.docId === doc.id) await play([{ _obj: "hide", null: layerRef(preview) }]); // don't feed a preview back in
        // workflow rescales to ~1MP anyway; cap upload size for huge selections
        const { w, h } = job;
        const targetSize = Math.max(w, h) > 2048 ? (w > h ? { width: 2048 } : { height: 2048 }) : undefined;
        const pix = await imaging.getPixels({
          documentID: doc.id, sourceBounds: rect, targetSize, componentSize: 8, applyAlpha: true, colorSpace: "RGB", colorProfile: SRGB,
        });
        job.jpeg = b64decode(await imaging.encodeImageData({ imageData: pix.imageData, base64: true }));
        pix.imageData.dispose();
        // exact selection at full res: layer mask in Photoshop, and the repaint mask for Flux
        job.sel = await readSelection(doc.id, rect);
      } finally {
        await ctx.hostControl.resumeHistory(sid, false);
      }
    });
  } catch (e) {
    if (job.cancelled) return removeJob(job);
    job.state = "error";
    job.error = e.message || String(e);
    return render();
  }
  if (job.cancelled) return removeJob(job); // cancelled while reading: the variant copies would inherit it and still run
  // Variants: one read of the page, N results. Each is a copy of the job (own id, seed and ComfyUI run) that shares
  // the page bytes and selection; the first stays `job`, the others sit right below it in the list.
  const all = [job];
  if (n > 1) {
    try {
      if (!edit && !job.mask) job.mask = await maskJpeg(job); // encoded once, not per variant
      for (let k = 2; k <= n; k++) {
        const id = `ps_clean_${Date.now()}_${++jobSeq}`;
        all.push(Object.assign({}, job, { id, vn: `${k}/${n}`, pillEl: null, barEl: null, stIcons: null, chan: job.chan && "Comfy Clean " + id.slice(9) }));
      }
      // Photoshop 2022 path: every variant owns a copy of the selection channel (removeJob deletes it with the result)
      if (job.chan) {
        await modal(() => play(all.slice(1).map((v) => ({ _obj: "duplicate", _target: [{ _ref: "channel", _name: job.chan }, { _ref: "document", _id: doc.id }], name: v.chan }))));
      }
    } catch (e) {
      job.state = "error";
      job.error = e.message || String(e);
      return render();
    }
    jobs.splice(jobs.indexOf(job) + 1, 0, ...all.slice(1));
    render();
  }
  await Promise.all(all.map(makeResult)); // makeResult catches its own errors
}

// everything after reading the page: also what Retry runs again (job.jpeg / job.mask / job.sel are kept for it)
async function makeResult(job) {
  const edit = job.edit;
  try {
    // selection is captured; now make sure ComfyUI is up (may start it) and build the graph
    await ensureComfy(job);
    job.sent = true; // from here on, a dead ComfyUI means it was closed mid-job
    if (!objectInfo) await loadModels();
    const wf = models.buildGraph(objectInfo, await loadTemplates(), {
      model: val("model") || load("model"), clip: val("clip") || load("clip") || models.AUTO,
      vae: val("vae") || load("vae") || models.AUTO, steps: +val("steps") || 0,
      colorMatch: Math.min(1, Math.max(0, val("colorMatch") === "" ? 1 : +val("colorMatch") || 0)),
      edit, prompt: job.prompt, seed: Math.floor(Math.random() * 2 ** 31), image: "", mask: "",
    });

    job.state = "uploading"; render();
    // template node ids: 4 = image, 20 = mask (clean templates only)
    wf["4"].inputs.image = await upload(job.base, job.id + ".jpg", job.jpeg);
    if (wf["20"]) wf["20"].inputs.image = await upload(job.base, job.id + "_mask.jpg", job.mask || await maskJpeg(job));
    if (job.cancelled) throw new Error("Cancelled");

    connectWs(job.base);
    job.wf = wf;
    job.sampler = Object.keys(wf).find((id) => /^(KSampler|SamplerCustomAdvanced)$/.test(wf[id].class_type)); // for the stuck watchdog
    job.retries = 0;
    await submit(job, false);
    const img = await waitResult(job);
    const png = new Uint8Array(await (await fetch(`${job.base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`)).arrayBuffer());
    job.thumb = "data:image/png;base64," + b64encode(png); // the only copy; decoded again for previews
    job.state = "ready";
    job.took = Date.now() - job.time;
    job.jpeg = job.mask = null; // no Retry for a finished result
    status(`Result ready in ${dur(job.took)}. Click it to preview.`);
  } catch (e) {
    if (job.cancelled) return removeJob(job);
    job.state = "error";
    job.error = e.message || String(e);
    if (job.sent && !(await reachable(job.base))) { // the raw message would be a bare network error
      job.error = "ComfyUI was closed while making this result";
      objectInfo = null;
      conn(false, "ComfyUI offline");
    }
  } finally {
    render();
  }
  if (job.state === "ready") await autoPreview(job);
}

// a new result is shown in the document right away (Apply / Discard), unless another result is on screen
// or being placed, or the user moved to another document; then it waits in the list as "Ready"
async function autoPreview(job) {
  if (cfg.autoPreview === false || preview || placing || activeDocId() !== job.docId) return;
  await showPreview(job).catch(() => status("Result ready. Click it to preview.")); // e.g. Photoshop busy in a dialog
}

// ---------- starting ComfyUI ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showPanel() {
  try { uxp.entrypoints.getPanel("main").show(); } catch (e) {} // not in every Photoshop version
}

async function reachable(base) {
  try {
    const r = await Promise.race([fetch(base + "/system_stats"), sleep(3000).then(() => { throw new Error("timeout"); })]);
    return r.ok;
  } catch (e) { return false; }
}

// ComfyUI closed outside the plugin (its window shut) -> the dot goes offline; started outside -> models load, dot goes live.
// Acts only when ComfyUI's up/down state changes: loadModels walks the whole models folder on disk, and repeating it
// every 10 s (ComfyUI up but no usable model, so the dot never turned green) made Photoshop stutter.
let polling = false, wasUp = null;
setInterval(async () => {
  if (starting || polling || !cfgReady) return;
  polling = true;
  try {
    const up = await reachable(baseUrl()), shown = $("dot").className === "dot ok";
    const changed = up !== wasUp;
    wasUp = up;
    if (!changed || up === shown) return;
    if (!up) { objectInfo = null; conn(false, "ComfyUI offline"); }
    else await loadModels().catch(() => {});
  } finally { polling = false; }
}, 10000);

async function ensureComfy(job) {
  if (await reachable(job.base)) return;
  objectInfo = null;
  const dir = val("comfyDir").trim().replace(/[\\/]+$/, "");
  if (!dir) throw new Error("ComfyUI isn't running. Start it, or set the ComfyUI folder in Settings so the plugin can start it.");
  job.state = "starting"; render();
  if (!starting) starting = startComfy(dir, job.base).finally(() => { starting = null; });
  // a cancelled job goes at once, not after ComfyUI is up (up to 3 minutes); ComfyUI keeps starting for the others
  const run = starting;
  for (;;) {
    if (job.cancelled) throw new Error("Cancelled");
    if (await Promise.race([run.then(() => true), sleep(500).then(() => false)])) return;
  }
}

const fileExists = async (path) => {
  try { await fs.getEntryWithUrl("file:/" + path.replace(/\\/g, "/")); return true; } catch (e) { return false; }
};

// works with the portable build (folder with python_embeded, or its inner ComfyUI folder) and venv installs
async function comfyCommand(dir) {
  const parent = dir.replace(/[\\/][^\\/]+$/, "");
  if (await fileExists(`${dir}\\python_embeded\\python.exe`) && await fileExists(`${dir}\\ComfyUI\\main.py`)) {
    return { cwd: dir, python: `${dir}\\python_embeded\\python.exe`, main: `${dir}\\ComfyUI\\main.py`, flags: "-s" };
  }
  if (await fileExists(`${dir}\\main.py`)) {
    if (await fileExists(`${parent}\\python_embeded\\python.exe`)) return { cwd: parent, python: `${parent}\\python_embeded\\python.exe`, main: `${dir}\\main.py`, flags: "-s" };
    for (const venv of ["venv", ".venv"]) {
      if (await fileExists(`${dir}\\${venv}\\Scripts\\python.exe`)) return { cwd: dir, python: `${dir}\\${venv}\\Scripts\\python.exe`, main: `${dir}\\main.py`, flags: "" };
    }
    return { cwd: dir, python: "python", main: `${dir}\\main.py`, flags: "" };
  }
  throw new Error(`No ComfyUI found in "${dir}". Pick the ComfyUI_windows_portable folder (or the folder with main.py).`);
}

// No browser tab (--disable-auto-launch, no --windows-standalone-build). Runs in Windows Terminal when it's
// installed (minimized: Terminal ignores the start-minimized flag, so the script minimizes its window),
// otherwise in the classic console, minimized. VBS -> hidden PowerShell, so no extra window flashes.
async function startComfy(dir, base) {
  conn(false, "Starting ComfyUI...");
  const c = await comfyCommand(dir);
  const sq = (str) => str.replace(/'/g, "''");
  const pyArgs = `${c.flags} "${c.main}" --disable-auto-launch`.trim();
  const ps1 = `$dir = '${sq(c.cwd)}'
$py = '${sq(c.python)}'
$pyArgs = '${sq(pyArgs)}'
$title = 'ComfyUI (Comfy Clean)'
$wt = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\wt.exe'
if (Test-Path $wt) {
  Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class CCWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var t = new StringBuilder(256); var c = new StringBuilder(256);
      GetWindowText(h, t, 256); GetClassName(h, c, 256);
      if (IsWindowVisible(h) && c.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS" && t.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
  Start-Process $wt -ArgumentList "-w new --title \`"$title\`" --suppressApplicationTitle -d \`"$dir\`" \`"$py\`" $pyArgs"
  # Terminal re-shows its window while it finishes starting, so keep minimizing until it stays down
  $h = [IntPtr]::Zero; $down = 0
  for ($i = 0; $i -lt 80 -and $down -lt 8; $i++) {
    Start-Sleep -Milliseconds 250
    if ($h -eq [IntPtr]::Zero) { $h = [CCWin]::Find($title) }
    if ($h -ne [IntPtr]::Zero) { if ([CCWin]::IsIconic($h)) { $down++ } else { $down = 0; [void][CCWin]::ShowWindow($h, 6) } }
  }
} else {
  Start-Process $py -ArgumentList $pyArgs -WorkingDirectory $dir -WindowStyle Minimized
}
`;
  const data = await fs.getDataFolder();
  const ps1File = await data.createFile("start_comfyui.ps1", { overwrite: true });
  await ps1File.write(ps1.replace(/\n/g, "\r\n"));
  const vbs = await data.createFile("start_comfyui.vbs", { overwrite: true });
  const q = (str) => str.replace(/"/g, '""');
  await vbs.write(`Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${q(`powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1File.nativePath}"`)}", 0, False\r\n`);
  const err = await uxp.shell.openPath(vbs.nativePath, "Starts ComfyUI minimized so Comfy Clean can use it.");
  if (err) throw new Error("Couldn't start ComfyUI: " + err);
  for (let t = 0; t < 180; t += 2) {
    await sleep(2000);
    if (await reachable(base)) { await loadModels().catch(() => {}); return; }
  }
  conn(false, "ComfyUI offline");
  throw new Error("ComfyUI didn't come up within 3 minutes. Check its window (taskbar) for errors.");
}

// ---------- selection helpers, and the Photoshop 2022 path ----------
// The Imaging API (pixels and selections as data) arrived in Photoshop 24.2 (2023), document.selection in 25 (2024).
// Without it (or with "Photoshop 2022 mode" on in Settings), the same work goes through channels, a duplicate and files.

const legacy = () => !(imaging && imaging.getSelection && imaging.putPixels) || !!cfg.legacy;
const SEL = { _ref: "channel", _property: "selection" };
const SELECT_ALL = { _obj: "set", _target: [SEL], to: { _enum: "ordinal", _value: "allEnum" } };
const px = (v) => ({ _unit: "pixelsUnit", _value: v });
const loadChannel = (name) => ({ _obj: "set", _target: [SEL], to: { _ref: "channel", _name: name } });
const fillWith = (c) => ({ _obj: "fill", using: { _enum: "fillContents", _value: c }, opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } });

// bounds of the active selection in pixels, or null (works in every version, unlike doc.selection)
async function selectionBounds(doc) {
  try {
    const [r] = await play([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }] }]);
    const s = r && r.selection;
    if (!s || !s.right) return null;
    return { left: s.left._value, top: s.top._value, right: s.right._value, bottom: s.bottom._value };
  } catch (e) { return null; }
}

// remembers the current selection; the returned function puts it back (or deselects when there was none)
async function keepSelection(doc) {
  const r = await selectionBounds(doc);
  if (!r) return deselect;
  if (legacy()) {
    const name = "Comfy Clean tmp";
    await play([{ _obj: "duplicate", _target: [SEL], name }]);
    return () => play([loadChannel(name), { _obj: "delete", _target: [{ _ref: "channel", _name: name }] }]);
  }
  const c = clampRect(r, doc);
  const s = await imaging.getSelection({ documentID: doc.id, sourceBounds: c });
  const b = s.sourceBounds || c; // data may cover only part of c
  return async () => {
    await imaging.putSelection({ documentID: doc.id, imageData: s.imageData, replace: true, targetBounds: { left: b.left, top: b.top } });
    s.imageData.dispose();
  };
}

// Photoshop 2022: the selection is saved as a channel (kept until the result is removed, for its preview); the crop
// and the mask come from a merged duplicate saved as JPEG. Returns { jpeg, mask } bytes.
// ponytail: no conversion to sRGB here (the Imaging path converts); fine for the usual sRGB pages
async function legacyRead(ctx, doc, job) {
  job.chan = "Comfy Clean " + job.id.slice(9);
  await play([{ _obj: "duplicate", _target: [SEL], name: job.chan }]);
  const sid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Comfy Clean read" });
  let dup;
  try {
    if (preview && preview.docId === doc.id) await play([{ _obj: "hide", null: layerRef(preview) }]); // don't feed a preview back in
    dup = await doc.duplicate("Comfy Clean read", true); // merged, keeps the channels; becomes the active document
  } finally {
    await ctx.hostControl.resumeHistory(sid, false);
  }
  try {
    const r = job.rect;
    await play([{ _obj: "set", _target: [SEL], to: { _obj: "rectangle", top: px(r.top), left: px(r.left), bottom: px(r.bottom), right: px(r.right) } },
      { _obj: "crop", delete: true }]);
    for (const c of [{ _obj: "convertMode", to: { _class: "RGBColorMode" } }, { _obj: "convertMode", depth: 8 }]) {
      try { await play([c]); } catch (e) {} // already RGB / 8 bit
    }
    if (Math.max(job.w, job.h) > 2048) { // same upload cap as the Imaging path
      const k = 2048 / Math.max(job.w, job.h);
      await dup.resizeImage(Math.round(job.w * k), Math.round(job.h * k));
    }
    const jpeg = await saveJpeg(dup, job.id + ".jpg");
    await play([SELECT_ALL, fillWith("black"), loadChannel(job.chan)]);
    try { await play([fillWith("white")]); } catch (e) {} // selection outside the crop = empty mask
    return { jpeg, mask: await saveJpeg(dup, job.id + "_mask.jpg") };
  } finally {
    await dup.closeWithoutSaving();
  }
}

async function saveJpeg(d, name) {
  const f = await (await fs.getTemporaryFolder()).createFile(name, { overwrite: true });
  await d.saveAs.jpg(f, { quality: 12 }, true);
  const bytes = new Uint8Array(await f.read({ format: formats.binary }));
  await f.delete();
  return bytes;
}

// selection as one byte per pixel of rect. Photoshop may return only the selected part of rect
// (its sourceBounds say which part), so place it; reading it as if it were all of rect gives a striped mask.
async function readSelection(docId, rect) {
  const s = await imaging.getSelection({ documentID: docId, sourceBounds: rect });
  const b = s.sourceBounds || rect, pw = s.imageData.width, ph = s.imageData.height;
  const part = await s.imageData.getData({ chunky: true });
  s.imageData.dispose();
  const w = rect.right - rect.left, out = new Uint8Array(w * (rect.bottom - rect.top));
  for (let y = 0; y < ph; y++) out.set(part.subarray(y * pw, (y + 1) * pw), (b.top - rect.top + y) * w + (b.left - rect.left));
  return out;
}

// Edit: the result's top and bottom rows fade into the original, so a slight color shift doesn't show as a hard line.
// pct = Settings > Edit fade, % of the height at each edge (default 7, 0 = off). Read when the preview is placed, so
// clicking a result again shows it with a new value. ponytail: not on the Photoshop 2022 path (selection is a channel there)
function fadeEdges(sel, w, h, pct) {
  const f = Math.floor(h * Math.min(50, Math.max(0, pct)) / 100), out = sel.slice();
  for (let i = 0; i < f; i++) {
    const t = (i + 1) / (f + 1), k = t * t * (3 - 2 * t); // smoothstep
    for (const y of [i, h - 1 - i]) for (let x = 0; x < w; x++) out[y * w + x] = Math.round(out[y * w + x] * k);
  }
  return out;
}

async function maskJpeg(job) {
  const rgb = new Uint8Array(job.sel.length * 3);
  for (let i = 0; i < job.sel.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = job.sel[i];
  const data = await imaging.createImageDataFromBuffer(rgb, { width: job.w, height: job.h, components: 3, colorSpace: "RGB", colorProfile: SRGB });
  const out = b64decode(await imaging.encodeImageData({ imageData: data, base64: true }));
  data.dispose();
  return out;
}

async function submit(job, front) {
  job.state = "queued"; job.sampling = false; job.progress = null; render();
  job.pid = (await json(fetch(job.base + "/prompt", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: job.wf, client_id: CLIENT, front }),
  }))).prompt_id;
}

const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Sometimes, with VRAM nearly full, Flux crawls at ~40s/step instead of ~5s. Cancel + resubmit fixes it,
// so do that automatically: if no sampler step finishes within the limit, interrupt and requeue at the front.
// 2nd retry also asks ComfyUI to unload models and free VRAM first.
async function retryIfStuck(job) {
  const limit = +val("stuck") || 0;
  if (!limit || !job.sampling || Date.now() - job.tick < limit * 1000 || job.retries >= 2) return;
  job.retries++;
  job.state = "retrying"; render();
  await post(job.base, "/interrupt", { prompt_id: job.pid });
  if (job.retries >= 2) await post(job.base, "/free", { unload_models: true, free_memory: true });
  await submit(job, true);
}

async function waitResult(job) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    if (job.cancelled) throw new Error("Cancelled");
    await retryIfStuck(job);
    const h = (await json(fetch(`${job.base}/history/${job.pid}`)))[job.pid];
    if (h) {
      if (h.status && h.status.status_str === "error") {
        const err = (h.status.messages || []).find((m) => m[0] === "execution_error");
        throw new Error(err ? err[1].exception_message : "ComfyUI execution failed");
      }
      const out = Object.values(h.outputs || {}).find((o) => o.images && o.images.length);
      if (out) return out.images[0];
    } else if (job.state === "queued") {
      const q = await json(fetch(job.base + "/queue"));
      const pending = q.queue_pending.slice().sort((a, b) => a[0] - b[0]);
      const pos = pending.findIndex((p) => p[1] === job.pid);
      job.queuePos = pos + 1;
      if (pos < 0 && q.queue_running.some((p) => p[1] === job.pid)) job.state = "running";
      refreshLive();
    }
  }
}

// live step progress from ComfyUI; history polling stays the source of truth
function connectWs(base) {
  if (ws && ws.readyState <= 1) return;
  try { ws = new WebSocket(base.replace(/^http/, "ws") + "/ws?clientId=" + CLIENT); } catch (e) { return; }
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return; // binary = sampler preview images
    const m = JSON.parse(e.data), d = m.data || {};
    const job = jobs.find((j) => j.pid && j.pid === d.prompt_id);
    if (!job || job.state === "ready" || job.state === "error") return;
    if (m.type === "executing" || m.type === "execution_start") job.state = "running";
    // stuck-watchdog clock: starts when the sampler node starts, resets on every step
    if (m.type === "executing") { job.sampling = d.node === job.sampler; job.tick = Date.now(); if (job.sampling) job.sampleStart = job.tick; }
    if (m.type === "progress") { job.state = "running"; job.progress = `${d.value}/${d.max}`; job.tick = Date.now(); }
    refreshLive();
  };
}

async function cancelJob(job) {
  job.cancelled = true;
  render();
  if (!job.pid) return;
  await post(job.base, "/queue", { delete: [job.pid] });
  if (job.state === "running") await post(job.base, "/interrupt", { prompt_id: job.pid });
}

// Retry on a failed result: same page area and prompt sent again (ComfyUI is started first if it's off)
function retryJob(job) {
  Object.assign(job, { state: "uploading", error: null, sent: false, pid: null, progress: null, sampling: false, sampleStart: 0, queuePos: 0, time: new Date() });
  render();
  return makeResult(job);
}

function removeJob(job) {
  const i = jobs.indexOf(job);
  if (i >= 0) jobs.splice(i, 1);
  if (job.chan && findDoc(job.docId)) { // Photoshop 2022 path keeps the selection in a channel until the result is gone
    modal(() => play([{ _obj: "delete", _target: [{ _ref: "channel", _name: job.chan }, { _ref: "document", _id: job.docId }] }])).catch(() => {});
  }
  render();
}

// ---------- preview / apply ----------

// one placement at a time: two results finishing together, a double click on a result or a click while another is
// being placed ran two at once, and the extra preview layer stayed in the document
async function showPreview(job) {
  if (placing) return;
  placing = true;
  try { await placePreview(job); } finally { placing = false; }
}

async function placePreview(job) {
  if (preview && preview.job === job) return;
  const doc = findDoc(job.docId);
  if (!doc) throw new Error(`"${job.docName}" was closed.`);
  await discardPreview(false);
  status("Placing preview...");

  const tmp = await (await fs.getTemporaryFolder()).createFile(job.id + ".png", { overwrite: true });
  await tmp.write(b64decode(job.thumb).buffer, { format: formats.binary });
  try {
    await modal(async (ctx) => {
      // exact pixels: open the result as its own document, resize it there to exactly the crop size and copy the
      // pixels in at the crop's corner. Placing it (placeEvent) let Photoshop rescale the smart object, and scaling
      // and moving it back rounded the bounds -> the result landed a few pixels off.
      // Photoshop 2022 (no Imaging API): copy it instead, paste in place and move it by whole pixels (no resampling)
      const old = !!job.chan;
      const res = await app.open(tmp);
      await res.resizeImage(job.w, job.h);
      let pix = null;
      if (old) await play([SELECT_ALL, { _obj: "copyEvent" }]);
      else pix = await imaging.getPixels({ documentID: res.id, componentSize: 8 });
      await res.closeWithoutSaving();

      app.activeDocument = doc; // always the document the selection came from
      const sid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Comfy Clean" });
      const restoreSel = await keepSelection(doc); // whatever the user has selected now (maybe the next bubble)

      let layer;
      if (old) {
        await deselect(); // a selection would center the paste on it
        await play([{ _obj: "paste", inPlace: true, antiAlias: { _enum: "antiAliasType", _value: "antiAliasNone" }, as: { _class: "pixel" } }]);
        layer = doc.activeLayers[0];
        layer.name = "Clean preview";
        const b = layer.bounds;
        await layer.translate(job.rect.left - b.left, job.rect.top - b.top);
      } else {
        await play([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: "Clean preview" } }]);
        layer = doc.activeLayers[0];
        await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: pix.imageData, targetBounds: { left: job.rect.left, top: job.rect.top } });
        pix.imageData.dispose();
      }
      // the result was made from all visible layers, so it goes on top of the stack, not above whatever layer was active
      if (doc.layers[0].id !== layer.id) await layer.move(doc.layers[0], constants.ElementPlacement.PLACEBEFORE);

      // the exact original selection
      if (old) await play([loadChannel(job.chan)]);
      else {
        const m = await imaging.createImageDataFromBuffer(job.edit ? fadeEdges(job.sel, job.w, job.h, val("fade") === "" ? 7 : +val("fade") || 0) : job.sel, { width: job.w, height: job.h, components: 1, chunky: true, colorSpace: "Grayscale" });
        await imaging.putSelection({ documentID: doc.id, imageData: m, replace: true, targetBounds: { left: job.rect.left, top: job.rect.top } });
        m.dispose();
      }
      // keep only the selected pixels of the result: Clear everything outside the selection
      await play([{ _obj: "inverse" }]);
      try { await play([{ _obj: "delete" }]); } catch (e) {} // nothing outside = nothing to clear

      await restoreSel();
      preview = { job, docId: doc.id, layerId: layer.id };
      await ctx.hostControl.resumeHistory(sid, true);
    });
  } finally {
    await tmp.delete();
  }
  status("Preview shown. Apply to keep it, Discard to remove.");
  render();
}

// Scrolls the canvas so the result's area is in the middle of the view; the zoom stays as it is. Photoshop has no
// API for this: "set document.center" takes the view center in screen pixels from the canvas' top-left
// (= document pixels x zoom). Only on a click in the list, never on an automatic preview.
// ponytail: undocumented descriptor (Adobe forum, works since CC 2018); if it fails the view just stays put
async function scrollToArea(job) {
  const doc = findDoc(job.docId), a = job.area;
  if (!doc || !a || activeDocId() !== job.docId) return;
  try {
    let z = doc.zoom; // percent, Photoshop 2024+
    if (z) z /= 100;
    else { // older: zoom as a fraction
      const [r] = await play([{ _obj: "get", _target: [{ _property: "zoom" }, { _ref: "document", _id: doc.id }] }]);
      z = typeof r.zoom === "object" ? r.zoom._value : r.zoom;
    }
    const at = (v) => ({ _unit: "distanceUnit", _value: v * z });
    await modal(() => play([{ _obj: "set", _target: [{ _ref: "property", _property: "center" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
      to: { _obj: "center", horizontal: at((a.left + a.right) / 2), vertical: at((a.top + a.bottom) / 2) } }]));
  } catch (e) {}
}

async function applyPreview() {
  if (!preview) return;
  const p = preview;
  await modal(async () => {
    await play([{ _obj: "set", _target: layerRef(p), to: { _obj: "layer", name: "Clean: " + p.job.prompt.slice(0, 40) } }]);
    if (app.activeDocument && app.activeDocument.id === p.docId) await deselect(); // done with this area
  });
  preview = null;
  p.job.outcome = "applied";
  render();
  status("Applied.");
}

// after Discard the next result still waiting (oldest first) takes its place, same rules as autoPreview
// (not after Apply: the user looks at the applied result first and picks the next one from the list)
async function previewNext() {
  const doc = activeDocId();
  const next = jobs.slice().reverse().find((j) => j.docId === doc && j.state === "ready" && !j.outcome);
  if (next) await autoPreview(next);
}

// byUser: the Discard button (marks the result); otherwise just swapping to another preview
async function discardPreview(byUser) {
  if (!preview) return;
  const p = preview;
  preview = null;
  if (findDoc(p.docId)) {
    try { await modal(() => play([{ _obj: "delete", _target: layerRef(p) }])); } catch (e) {} // user may have deleted it already
  }
  if (byUser) { p.job.outcome = "discarded"; status("Discarded. It stays in Results if you change your mind."); }
  render();
  if (byUser) await previewNext();
}

// ---------- UI ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderPresets() {
  fillPicker("presetPick", presets().map((pr) => ({ value: pr.name, label: pr.name })));
  render();
}

// the preset dropdown shows the preset whose text is in the prompt box, or its placeholder when edited
function syncPresetPick() {
  const pr = presets().find((x) => x.prompt === $("prompt").value.trim());
  if (val("presetPick") !== (pr ? pr.name : "")) setVal("presetPick", pr ? pr.name : "");
}

const finished = (j) => j.state === "ready" || j.state === "error";

// the empty list's picture: two <img> (dark / light theme) made once and moved into each new empty row, like the thumbnails
const emptyIcons = [["dk", "picture"], ["lt", "picture-light"]].map(([cls, file]) => { const i = el("img", "ic big " + cls); i.src = `icons/${file}.svg`; return i; });

// render() rebuilds the list (documents switched, jobs added or finished); a fresh <img> decodes the 1-3 MB PNG again and blinks empty
// meanwhile, so each result keeps one <img> that is just moved into the new row
const thumbs = new WeakMap();
function thumbFor(job) {
  let img = thumbs.get(job);
  if (!img) { img = el("img", "thumb"); img.src = job.thumb; thumbs.set(job, img); }
  return img;
}
// Icons inside a result's row. render() rebuilds the rows, and a fresh <img> blinks empty while UXP decodes it (the
// thumbnail did too), so each result keeps its own <img> nodes: made once, moved into every new row.
// cls: "dk" / "lt" (theme pair, see icoPair), "wh" (white, on the accent colour), or "" (coloured file, same in both themes)
const rowIcons = new WeakMap();
function ico(job, file, cls = "") {
  let own = rowIcons.get(job);
  if (!own) rowIcons.set(job, own = new Map());
  let i = own.get(file);
  if (!i) { i = el("img", "ic " + cls); i.src = `icons/${file}.svg`; own.set(file, i); }
  return i;
}
const icoPair = (job, name) => [ico(job, name, "dk"), ico(job, name + "-light", "lt")];
// the state icon before the pill, by pill colour. A live row holds the blue and the amber one (refreshLive shows one),
// so a retry turns it amber without a rebuild
const PILL_ICON = { blue: "clock-blue", amber: "refresh-amber", green: "check-ok", red: "alert-err", grey: "undo-grey" };
function pillIcons(job, cls) {
  return (job.state === "ready" || job.state === "error" ? [cls] : ["blue", "amber"]).map((k) => {
    const i = ico(job, PILL_ICON[k], "pi");
    i.pk = k;
    i.style.display = k === cls ? "block" : "none";
    return i;
  });
}
const pad2 = (n) => String(n).padStart(2, "0");
// 42s, 3m 05s
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad2(s % 60)}s`; };
// " · 25s" elapsed since the click, plus " · ~12s left" once the sampler's steps give a pace
function timing(job) {
  const now = Date.now();
  let t = " · " + dur(now - job.time);
  const [v, m] = (job.progress || "0/1").split("/").map(Number);
  if (job.state === "running" && job.sampleStart && v > 0 && v < m) {
    t += ` · ~${dur((m - v) * (job.tick - job.sampleStart) / v - (now - job.tick))} left`;
  }
  return t;
}
// Progress (a ComfyUI message per sampler step, the queue position, the timing tick every second) only updates the
// live rows' pill and bar in place: rebuilding the list several times a second replaced the Apply / Discard / x
// buttons of a finished result between press and release, so clicks on them were lost while another job ran.
let ticker = null;
const barWidth = (job) => {
  const [v, m] = (job.progress || "0/1").split("/").map(Number);
  return (job.state === "running" ? Math.max(4, Math.round(100 * v / m)) : 0) + "%";
};
function refreshLive() {
  const live = jobs.filter((j) => !finished(j));
  for (const j of live) {
    const pill = pillFor(j);
    if (j.pillEl) { j.pillEl.textContent = pill.text; j.pillEl.className = "pill " + pill.cls; }
    for (const i of j.stIcons || []) i.style.display = i.pk === pill.cls ? "block" : "none";
    if (j.barEl) j.barEl.style.width = barWidth(j);
  }
  if (!live.length) { clearInterval(ticker); ticker = null; }
}

// UXP's textarea can't scroll (text past its bottom is just hidden): the prompt is read in #promptView, which scrolls,
// and the textarea shows only while typing, one spare line taller than its text.
// fits(line) says whether a line fits the width
function wrapLines(text, fits) {
  const out = [];
  for (const para of text.split(/\r\n|\r|\n/)) { // the Windows textarea may give \r alone
    let cur = "";
    for (const w of para.split(" ")) {
      const next = cur ? cur + " " + w : w;
      if (cur && !fits(next)) { out.push(cur); cur = w; } else cur = next;
    }
    out.push(cur);
  }
  return out;
}
// ponytail: the textarea's wrap is estimated with an average glyph width (~5.3px measured, 5.5 to stay safe)
// width: given on the click that shows the textarea, which reads 0 then. With 0 (and a fallback that never applied:
// 0 - 12 is -12, not falsy) every line counted as 10 characters and the box opened ~700px tall for a moment, then
// snapped back on the next resize event: the panel blinked. Never shorter than the view (110px): a prompt that fits
// the view no longer makes the box shrink on click and grow back on leaving.
function fitPrompt(width) {
  const t = $("prompt"), per = Math.max(10, Math.floor(((width || t.offsetWidth || 292) - 12) / 5.5));
  const lines = wrapLines(t.value, (s) => s.length <= per).length + 1;
  const h = Math.max(110, lines * 14 + 10) + "px"; // 14px lines + padding
  if (t.style.height !== h) t.style.height = h;
}
// UXP fires "resize" ~18 times a second while the panel is open: only the textarea's height is refitted here (a full
// render() each time rebuilt the results list nonstop, ~15% CPU, and Apply / Discard / x clicks were lost)
window.addEventListener("resize", () => { if ($("prompt").className !== "hidden") fitPrompt(); });

// UXP spaces wrapped text lines ~30px apart whatever line-height says, so the view shows each paragraph as a wrapping
// flex row of one-word boxes (.w, 14px tall, a fixed space after each) and UXP's own layout breaks the lines. The view
// used to break them itself from the words' offsetWidth: whole px, ~1.7px short per word, so a 12-word line ran ~20px
// past the box and its last letters hid under the edge. Width changes (panel resize, a scrollbar) re-wrap on their own.
function showPromptView() {
  const box = $("promptView"), v = $("prompt").value;
  if (box.shown === v) return; // render() runs on every progress update: rebuilding would reset the scroll
  box.shown = v;
  box.innerHTML = "";
  if (!v) return box.appendChild(el("div", "para")).appendChild(el("div", "w ph", $("prompt").placeholder));
  for (const para of v.split(/\r\n|\r|\n/)) { // the Windows textarea may give \r alone
    const row = box.appendChild(el("div", "para"));
    for (const w of para.split(" ")) row.appendChild(el("div", "w", w || "\u00a0")); // an empty line keeps its height
  }
}

function render() {
  if (!panelShown) return;
  if ($("prompt").className === "hidden") showPromptView(); else fitPrompt();
  if (!ticker && jobs.some((j) => !finished(j))) ticker = setInterval(refreshLive, 1000);
  const edit = $("mode").value === "edit";
  for (const b of document.querySelectorAll("#modeSeg div")) b.className = b.dataset.v === $("mode").value ? "on" : "";
  $("modeHint").textContent = edit
    ? "Regenerates the whole selection from the prompt."
    : "Selection is the mask. A full-width strip around it is sent as context.";
  $("goText").textContent = (edit ? "Edit selection" : "Clean selection"); // not #go itself: its textContent would delete the icon
  for (const b of document.querySelectorAll("#varSeg div")) b.className = b.dataset.v === String(variations()) ? "on" : "";
  // the model the next job will use: the Settings pick, or the saved one while ComfyUI is offline/starting
  const model = val("model") || load("model") || "";
  if (val("modelQuick") !== model) setVal("modelQuick", model);
  syncPresetPick();
  // the list shows the active document's results only; it follows the document tabs (see the listener below)
  const docId = activeDocId();
  const away = !!preview && preview.docId !== docId;
  $("otherPreview").className = "other-preview" + (away ? "" : " hidden");
  if (away) $("otherText").textContent = `Unfinished preview in ${preview.job.docName}, click to go there`; // the span: textContent on #otherPreview would delete its icon
  const mine = jobs.filter((j) => j.docId === docId);
  $("count").textContent = String(mine.length); // UXP shows nothing for the number 0
  $("sessionStats").textContent = mine.length
    ? `${mine.filter((j) => j.outcome === "applied").length} applied \u00b7 ${mine.filter((j) => !finished(j)).length} running`
    : "";
  for (const f of document.querySelectorAll("#filters div")) f.className = f.dataset.f === filter ? "on" : "";

  const shown = mine.filter((j) => filter === "all" || (filter === "applied" ? j.outcome === "applied" : !j.outcome));
  const box = $("jobs");
  box.innerHTML = "";
  if (!shown.length) {
    const empty = box.appendChild(el("div", "empty"));
    for (const i of emptyIcons) empty.appendChild(i);
    empty.appendChild(el("div", "", docId === null ? "Open a document to see its results."
      : mine.length ? "Nothing here with this filter." : "Results of this page appear here."));
  }
  for (const job of shown) {
    const active = preview && preview.job === job;
    const row = el("div", "job" + (job.state === "ready" ? " ready" : "") + (active ? " active" : "") + (job.outcome ? " " + job.outcome : ""));
    if (job.thumb) row.appendChild(thumbFor(job));
    else row.appendChild(el("div", "thumb" + (job.state === "error" ? "" : " pending")));

    const txt = el("div", "txt");
    const top = el("div", "top");
    const tag = top.appendChild(el("span", "tag" + (job.edit ? " edit" : "")));
    tag.appendChild(ico(job, job.edit ? "pencil-violet" : "eraser-blue"));
    tag.appendChild(el("span", "", (job.edit ? "EDIT" : "CLEAN") + (job.vn ? " " + job.vn : "")));
    top.appendChild(el("span", "title", job.prompt)); // the list only shows this document's results: no file name
    top.appendChild(el("span", "time", `${pad2(job.time.getHours())}:${pad2(job.time.getMinutes())}` + (job.took ? ` · ${dur(job.took)}` : "")));
    txt.appendChild(top);
    row.title = job.prompt;
    const bottom = el("div", "bottom");
    if (active) { job.stIcons = null; bottom.appendChild(previewActions(job)); }
    else {
      const pill = pillFor(job), retry = job.state === "error" && job.jpeg; // failed after the page was read
      const host = retry ? bottom.appendChild(el("div", "acts")) : bottom;
      if (retry) actButton(host, "primary", "Retry", () => retryJob(job), [ico(job, "refresh-white", "wh")]);
      job.stIcons = pillIcons(job, pill.cls);
      for (const i of job.stIcons) host.appendChild(i);
      job.pillEl = host.appendChild(el("span", "pill " + pill.cls, pill.text));
    }
    txt.appendChild(bottom);
    if (!finished(job)) {
      const bar = el("div", "bar");
      job.barEl = bar.appendChild(el("div"));
      job.barEl.style.width = barWidth(job);
      txt.appendChild(bar);
    }
    row.appendChild(txt);

    const x = el("div", "x");
    for (const i of icoPair(job, "close")) x.appendChild(i);
    x.title = finished(job) ? "Remove from list" : "Cancel";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      if (active) discardPreview(false).then(() => removeJob(job)).catch(fail);
      else if (finished(job)) removeJob(job);
      else cancelJob(job).catch(fail);
    });
    row.appendChild(x);
    if (job.state === "ready") row.addEventListener("click", () => showPreview(job).then(() => scrollToArea(job)).catch(fail));
    box.appendChild(row);
    // a new preview (auto, or after Discard: maybe an older result further down) is brought into view once;
    // later renders (progress ticks) leave the list where the user scrolled it
    if (active && scrolledFor !== job) {
      scrolledFor = job;
      try { row.scrollIntoView({ block: "nearest" }); } catch (e) {}
    }
  }
}

function actButton(acts, cls, text, fn, icons) {
  const b = el("div", "btn mini " + cls);
  for (const i of icons) b.appendChild(i);
  b.appendChild(el("span", "", text));
  b.addEventListener("click", (e) => { e.stopPropagation(); fn().catch(fail); }); // not the row's click
  acts.appendChild(b);
}
function previewActions(job) {
  const acts = el("div", "acts");
  actButton(acts, "primary", "Apply", applyPreview, [ico(job, "check-white", "wh")]);
  actButton(acts, "ghost", "Discard", () => discardPreview(true), icoPair(job, "undo"));
  return acts;
}

function pillFor(job) {
  if (job.state === "error") return { cls: "red", text: "Error: " + job.error };
  if (job.state === "ready") {
    if (job.outcome === "applied") return { cls: "green", text: "Applied \u00b7 click to place again" };
    if (job.outcome === "discarded") return { cls: "grey", text: "Discarded \u00b7 click to preview" };
    return { cls: "green", text: "Ready \u00b7 click to preview" };
  }
  return { cls: job.state === "retrying" ? "amber" : "blue", text: stateText(job) + timing(job) };
}

for (const f of document.querySelectorAll("#filters div")) f.addEventListener("click", () => { filter = f.dataset.f; render(); });
$("clearDone").addEventListener("click", () => {
  const doc = activeDocId();
  for (const j of jobs.filter((j) => j.docId === doc && finished(j) && !(preview && preview.job === j))) removeJob(j);
  status("Cleared this page's finished results.");
});

// Results belong to their document (by Photoshop's document id, never reused in a session, so a new file with the
// same name never sees them). Closing a document drops all of its results at once and cancels its queued and
// running jobs in ComfyUI.
function dropClosedDocs() {
  if (preview && !findDoc(preview.docId)) preview = null;
  for (const j of jobs.filter((j) => !findDoc(j.docId))) {
    if (!finished(j)) cancelJob(j).catch(() => {});
    removeJob(j);
  }
}
// The preview layer can go behind the plugin's back: undone (Ctrl+Z / the History panel are "select" events on a
// history state), deleted or merged by hand. Kept as previewed, new results stopped previewing by themselves and
// Apply "applied" a layer that wasn't there. Its row goes back to Ready.
async function dropGonePreview() {
  const p = preview;
  if (!p || placing) return;
  let gone;
  try {
    const [r] = await play([{ _obj: "get", _target: [{ _property: "layerID" }].concat(layerRef(p)) }]);
    gone = !r || r._obj === "error";
  } catch (e) { gone = true; }
  if (gone && preview === p) { preview = null; render(); }
}
// Results follow the document tab. Checked on every event, not only "close": the close notice may arrive
// before Photoshop has dropped the document from its list.
try {
  action.addNotificationListener(["select", "open", "close", "make", "delete", "mergeLayersNew"], () => {
    dropClosedDocs();
    render();
    dropGonePreview();
  });
} catch (e) {} // a throw here would stop the rest of this file from loading

function stateText(job) {
  if (job.cancelled) return "Cancelling...";
  if (job.state === "starting") return "Starting ComfyUI...";
  if (job.state === "queued") return job.queuePos ? `Queued #${job.queuePos}` : "Queued";
  if (job.state === "retrying") return `Stuck, retrying (${job.retries}/2)...`;
  if (job.state === "running") return job.progress ? `Step ${job.progress}` : "Running...";
  const s = job.state.charAt(0).toUpperCase() + job.state.slice(1);
  return s + "..." + (job.retries ? ` (retry ${job.retries})` : "");
}
try { render(); } catch (e) { fail(e); } // a throw here would stop the rest of this file from loading

// ---------- ComfyUI I/O ----------

async function json(p) {
  const r = await p;
  if (!r.ok) throw new Error(`ComfyUI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// uploads go to ComfyUI's temp folder (wiped on every ComfyUI start), not input/.
// hand-built multipart: no FormData/Blob dependency in UXP
async function upload(base, name, bytes) {
  const b = "----cc" + Date.now();
  const field = (k, v) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  const head = ascii(field("type", "temp") + field("overwrite", "true") +
    `--${b}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: image/jpeg\r\n\r\n`);
  const tail = ascii(`\r\n--${b}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const r = await json(fetch(base + "/upload/image", {
    method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=" + b }, body: body.buffer,
  }));
  return (r.subfolder ? `${r.subfolder}/${r.name}` : r.name) + " [temp]";
}

function ascii(s) { return Uint8Array.from(s, (c) => c.charCodeAt(0)); }

function b64decode(s) {
  s = s.slice(s.indexOf(",") + 1).replace(/[^A-Za-z0-9+/]/g, "");
  const t = new Uint8Array(128);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  const out = new Uint8Array((s.length * 3) >> 2);
  for (let i = 0, j = 0; i < s.length; i += 4) {
    const n = (t[s.charCodeAt(i)] << 18) | (t[s.charCodeAt(i + 1)] << 12) | (t[s.charCodeAt(i + 2)] << 6) | t[s.charCodeAt(i + 3)];
    out[j++] = n >> 16;
    if (j < out.length) out[j++] = (n >> 8) & 255;
    if (j < out.length) out[j++] = n & 255;
  }
  return out;
}

function b64encode(u8) {
  const parts = [];
  for (let i = 0; i < u8.length; i += 3) {
    const n = (u8[i] << 16) | ((u8[i + 1] || 0) << 8) | (u8[i + 2] || 0);
    const k = u8.length - i;
    parts.push(B64[n >> 18] + B64[(n >> 12) & 63] + (k > 1 ? B64[(n >> 6) & 63] : "=") + (k > 2 ? B64[n & 63] : "="));
  }
  return parts.join("");
}
