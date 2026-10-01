const { app, core, imaging, action, constants } = require("photoshop");
const uxp = require("uxp");
const { localFileSystem: fs, formats } = uxp.storage;
const models = require("./models.js");

const $ = (id) => document.getElementById(id);
const MAIN_FIELDS = ["mode", "prompt"]; // auto-saved as you use them
const SETTINGS = ["pad", "stuck", "url", "comfyDir", "model", "clip", "vae", "steps", "colorMatch"]; // saved with the Save button
const CLIENT = "ps_clean_" + Date.now();
const SRGB = "sRGB IEC61966-2.1";
// newest first; every result of this Photoshop session (memory only, gone when Photoshop closes).
// ponytail: each result keeps its PNG as a data URL (~1-3 MB); a very long session grows memory, Clear frees it
const jobs = [];
let filter = "all"; // results filter: all | new | applied
let preview = null; // { job, docId, layerId } -- the result currently shown in its document
let jobSeq = 0;
let ws = null;
let objectInfo = null; // ComfyUI /object_info, cached by loadModels
let templates = null; // plugin/workflows/*.json
let starting = null; // shared promise while the plugin is starting ComfyUI

// first-run presets; after that the user's list lives in settings.json (cfg.presets)
const DEFAULT_PRESETS = [
  { name: "Text, keep bubble", prompt: "Remove all text and lettering. Keep the speech bubble exactly as it is: same shape, outline, tail and white fill. Fill where the text was with the same clean background as the rest of the bubble. Do not change anything else; keep every line, color and detail identical." },
  { name: "Text", prompt: "Remove all text and lettering. Fill where the text was with the background around it, matching its color, texture and lines. Do not change anything else." },
  { name: "Text + bubble", prompt: "Remove the speech bubble and all text in it. Restore the artwork behind it so it continues naturally from the surroundings. Do not change anything else." },
  { name: "SFX", prompt: "Remove the sound effect lettering. Restore the artwork behind it so it continues naturally from the surroundings, with the same lines, colors and screentone. Do not change anything else." },
  { name: "Object", prompt: "Remove the selected object. Fill the area with what should be behind it, matching the surroundings. Do not change anything else." },
];
const presets = () => cfg.presets || DEFAULT_PRESETS;

// "Clean selection" is also a Plugins-menu command, so it can get a keyboard shortcut
uxp.entrypoints.setup({
  // from a shortcut the panel may be hidden, so problems also get an alert
  commands: { clean: () => clean().catch((e) => { fail(e); app.showAlert(e.message || String(e)); }) },
  panels: {
    main: {
      show(node) { if (node && node !== document.body && !node.contains($("app"))) node.appendChild($("app")); },
    },
  },
});

// settings live in a JSON file in the plugin's data folder, so they survive Photoshop restarts
let cfg = {};
const load = (f) => (cfg[f] === undefined ? null : cfg[f]);
async function writeCfg() {
  const f = await (await fs.getDataFolder()).createFile("settings.json", { overwrite: true });
  await f.write(JSON.stringify(cfg, null, 2));
}
const save = (f) => { cfg[f] = $(f).value; writeCfg().catch(fail); };
const fillFields = (names) => { for (const f of names) if (load(f) !== null) $(f).value = load(f); };

async function start() {
  try { cfg = JSON.parse(await (await (await fs.getDataFolder()).getEntry("settings.json")).read()); } catch (e) { cfg = {}; }
  fillFields(MAIN_FIELDS.concat(SETTINGS));
  if (!$("prompt").value) $("prompt").value = presets()[0] ? presets()[0].prompt : "";
  renderPresets();
  render();
  await loadModels().catch(() => {});
}

$("presetSave").addEventListener("click", () => {
  const name = $("presetName").value.trim(), prompt = $("prompt").value.trim();
  if (!name || !prompt) return status("Type a prompt and a preset name first.", true);
  cfg.presets = presets().filter((x) => x.name !== name).concat([{ name, prompt }]); // same name = overwrite
  writeCfg().catch(fail);
  $("presetName").value = "";
  $("presetAdd").className = "preset-add hidden";
  renderPresets();
  status(`Preset "${name}" saved.`);
});
$("presetCancel").addEventListener("click", () => { $("presetAdd").className = "preset-add hidden"; });
$("prompt").addEventListener("change", () => save("prompt"));
$("prompt").addEventListener("input", () => render());
for (const b of document.querySelectorAll("#modeSeg div")) {
  b.addEventListener("click", () => { $("mode").value = b.dataset.v; save("mode"); render(); });
}
$("go").addEventListener("click", () => clean().catch(fail));
$("apply").addEventListener("click", () => applyPreview().catch(fail));
$("discard").addEventListener("click", () => discardPreview(true).catch(fail));

// separate settings page: gear opens it, Save writes the file, Back throws edits away
const showSettings = (on) => {
  $("mainView").className = on ? "hidden" : "";
  $("settingsView").className = on ? "" : "hidden";
  $("saveMsg").textContent = "";
};
$("gear").addEventListener("click", () => showSettings(true));
$("back").addEventListener("click", () => { fillFields(SETTINGS); showSettings(false); });
$("saveSettings").addEventListener("click", async () => {
  for (const f of SETTINGS) cfg[f] = $(f).value;
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
  if (folder) $("comfyDir").value = folder.nativePath;
});
$("reload").addEventListener("click", () => loadModels().then(() => { $("saveMsg").textContent = "Connected."; })
  .catch((e) => { $("saveMsg").textContent = e.message || String(e); }));
for (const f of ["model", "clip", "vae"]) $(f).addEventListener("change", () => showAutoPicks());
start();
// leftovers from a crash mid-place
fs.getTemporaryFolder().then(async (t) => {
  for (const e of await t.getEntries()) if (e.name.startsWith("ps_clean_")) await e.delete();
}).catch(() => {});

function status(msg, err) { $("status").textContent = msg; $("status").className = "status" + (err ? " err" : ""); }
function fail(e) { status(e.message || String(e), true); }
function conn(ok, text) { $("dot").className = "dot " + (ok ? "ok" : "off"); $("connText").textContent = text; }
const baseUrl = () => $("url").value.replace(/\/+$/, "");
const modal = (fn, name = "Comfy Clean") => core.executeAsModal(fn, { commandName: name });
const play = (cmds) => action.batchPlay(cmds, {});
const deselect = () => play([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }]);
const layerRef = (p) => [{ _ref: "layer", _id: p.layerId }, { _ref: "document", _id: p.docId }];
const findDoc = (id) => app.documents.find((d) => d.id === id);
const clampRect = (b, doc) => ({
  left: Math.max(0, Math.floor(b.left)), top: Math.max(0, Math.floor(b.top)),
  right: Math.min(doc.width, Math.ceil(b.right)), bottom: Math.min(doc.height, Math.ceil(b.bottom)),
});

// model list = every Klein / Kontext / Fill file ComfyUI can load (GGUF, safetensors, Nunchaku);
// text encoder and VAE default to "Auto" = picked per model family by models.js
async function loadModels() {
  try { objectInfo = await json(fetch(baseUrl() + "/object_info")); } catch (e) {
    conn(false, "ComfyUI offline");
    throw new Error("ComfyUI not reachable. Start it, or check the URL in Settings.");
  }
  const fill = (sel, items, auto) => {
    const prev = sel.value; // keep an unsaved pick when testing the connection
    sel.innerHTML = "";
    if (auto) items = [{ value: models.AUTO, label: "Auto" }].concat(items);
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it.value; o.textContent = it.label;
      sel.appendChild(o);
    }
    sel.value = prev || load(sel.id) || (auto ? models.AUTO : "flux-2-klein-9b-Q4_K_S.gguf");
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  };
  const tag = { flux2: "Klein", kontext: "Kontext", fill: "Fill" };
  const list = models.listModels(objectInfo);
  if (!list.length) throw new Error("No Flux.2 Klein, Kontext or Fill model found in ComfyUI.");
  fill($("model"), list.map((m) => ({ value: m.name, label: `${m.name}  (${tag[m.family]}${m.nunchaku ? ", Nunchaku" : ""})` })));
  fill($("clip"), models.encoderList(objectInfo).map((n) => ({ value: n, label: n })), true);
  fill($("vae"), models.vaeList(objectInfo).map((n) => ({ value: n, label: n })), true);
  showAutoPicks();
  conn(true, $("model").value.replace(/\.(gguf|safetensors)$/, ""));
  status("Make a selection, then click " + ($("mode").value === "edit" ? "Edit." : "Clean."));
}

function showAutoPicks() {
  if (!objectInfo) return;
  try {
    const r = models.resolve(objectInfo, { model: $("model").value, clip: $("clip").value, vae: $("vae").value });
    $("autoHint").textContent = `Uses: ${r.enc.main}${r.enc.clipL ? " + " + r.enc.clipL : ""} \u00b7 ${r.vae}`;
    $("autoHint").className = "hint";
  } catch (e) {
    $("autoHint").textContent = e.message;
    $("autoHint").className = "hint err";
  }
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
  const sel = doc.selection.bounds;
  if (!sel) throw new Error("Make a selection first.");

  const edit = $("mode").value === "edit";
  const pad = +$("pad").value || 0;
  showPanel();
  // Only this crop goes to ComfyUI, so page height doesn't matter.
  // clean: full page width, selection's height band + context above/below. edit: just the selection box.
  const rect = edit ? clampRect(sel, doc)
    : clampRect({ left: 0, right: doc.width, top: sel.top - pad, bottom: sel.bottom + pad }, doc);
  const job = {
    id: `ps_clean_${Date.now()}_${++jobSeq}`, docId: doc.id, docName: doc.title, base: baseUrl(), time: new Date(),
    prompt: $("prompt").value.trim(), edit, rect, w: rect.right - rect.left, h: rect.bottom - rect.top, state: "reading",
  };
  jobs.unshift(job);
  render();

  try {
    let jpeg;
    await modal(async (ctx) => {
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
        jpeg = b64decode(await imaging.encodeImageData({ imageData: pix.imageData, base64: true }));
        pix.imageData.dispose();
        // exact selection at full res: layer mask in Photoshop, and the repaint mask for Flux
        const s = await imaging.getSelection({ documentID: doc.id, sourceBounds: rect });
        job.sel = await s.imageData.getData({ chunky: true });
        s.imageData.dispose();
      } finally {
        await ctx.hostControl.resumeHistory(sid, false);
      }
    });

    // selection is captured; now make sure ComfyUI is up (may start it) and build the graph
    await ensureComfy(job);
    if (!objectInfo) await loadModels();
    const wf = models.buildGraph(objectInfo, await loadTemplates(), {
      model: $("model").value || load("model"), clip: $("clip").value || load("clip") || models.AUTO,
      vae: $("vae").value || load("vae") || models.AUTO, steps: +$("steps").value || 0,
      colorMatch: Math.min(1, Math.max(0, $("colorMatch").value === "" ? 1 : +$("colorMatch").value || 0)),
      edit, prompt: job.prompt, seed: Math.floor(Math.random() * 2 ** 31), image: "", mask: "",
    });

    job.state = "uploading"; render();
    // template node ids: 4 = image, 20 = mask (clean templates only)
    wf["4"].inputs.image = await upload(job.base, job.id + ".jpg", jpeg);
    if (wf["20"]) wf["20"].inputs.image = await upload(job.base, job.id + "_mask.jpg", await maskJpeg(job));
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
    status("Result ready. Click it to preview.");
  } catch (e) {
    if (job.cancelled) return removeJob(job);
    job.state = "error";
    job.error = e.message || String(e);
  } finally {
    render();
  }
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

async function ensureComfy(job) {
  if (await reachable(job.base)) return;
  objectInfo = null;
  const dir = $("comfyDir").value.trim().replace(/[\\/]+$/, "");
  if (!dir) throw new Error("ComfyUI isn't running. Start it, or set the ComfyUI folder in Settings so the plugin can start it.");
  job.state = "starting"; render();
  if (!starting) starting = startComfy(dir, job.base).finally(() => { starting = null; });
  await starting;
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
  const limit = +$("stuck").value || 0;
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
      render();
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
    if (m.type === "executing") { job.sampling = d.node === job.sampler; job.tick = Date.now(); }
    if (m.type === "progress") { job.state = "running"; job.progress = `${d.value}/${d.max}`; job.tick = Date.now(); }
    render();
  };
}

async function cancelJob(job) {
  job.cancelled = true;
  render();
  if (!job.pid) return;
  await post(job.base, "/queue", { delete: [job.pid] });
  if (job.state === "running") await post(job.base, "/interrupt", { prompt_id: job.pid });
}

function removeJob(job) {
  const i = jobs.indexOf(job);
  if (i >= 0) jobs.splice(i, 1);
  render();
}

// ---------- preview / apply ----------

async function showPreview(job) {
  if (preview && preview.job === job) return;
  const doc = findDoc(job.docId);
  if (!doc) throw new Error(`"${job.docName}" was closed.`);
  await discardPreview(false);
  status("Placing preview...");

  const tmp = await (await fs.getTemporaryFolder()).createFile(job.id + ".png", { overwrite: true });
  await tmp.write(b64decode(job.thumb).buffer, { format: formats.binary });
  try {
    await modal(async (ctx) => {
      if (app.activeDocument.id !== doc.id) app.activeDocument = doc; // always the document the selection came from
      const sid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Comfy Clean" });
      // keep whatever the user has selected now (maybe the next bubble)
      let userSel = null;
      if (doc.selection.bounds) {
        const r = clampRect(doc.selection.bounds, doc);
        const s = await imaging.getSelection({ documentID: doc.id, sourceBounds: r });
        userSel = { r, data: s.imageData };
      }

      await play([{ _obj: "placeEvent", null: { _path: await fs.createSessionToken(tmp), _kind: "local" } }]);
      const layer = doc.activeLayers[0];
      let b = layer.bounds;
      await layer.scale(100 * job.w / (b.right - b.left), 100 * job.h / (b.bottom - b.top), constants.AnchorPosition.TOPLEFT);
      b = layer.bounds;
      await layer.translate(job.rect.left - b.left, job.rect.top - b.top);
      await layer.rasterize(constants.RasterizeType.ENTIRELAYER);
      layer.name = "Clean preview";

      // layer mask = the exact original selection, no expand/feather
      const m = await imaging.createImageDataFromBuffer(job.sel, { width: job.w, height: job.h, components: 1, chunky: true, colorSpace: "Grayscale" });
      await imaging.putSelection({ documentID: doc.id, imageData: m, replace: true, targetBounds: { left: job.rect.left, top: job.rect.top } });
      m.dispose();
      await play([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } }]);

      if (userSel) {
        await imaging.putSelection({ documentID: doc.id, imageData: userSel.data, replace: true, targetBounds: { left: userSel.r.left, top: userSel.r.top } });
        userSel.data.dispose();
      } else await deselect();
      preview = { job, docId: doc.id, layerId: layer.id };
      await ctx.hostControl.resumeHistory(sid, true);
    });
  } finally {
    await tmp.delete();
  }
  status("Preview shown. Apply to keep it, Discard to remove.");
  render();
}

async function applyPreview() {
  if (!preview) return;
  const p = preview;
  await modal(() => play([{ _obj: "set", _target: layerRef(p), to: { _obj: "layer", name: "Clean: " + p.job.prompt.slice(0, 40) } }]));
  preview = null;
  p.job.outcome = "applied";
  render();
  status("Applied.");
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
}

// ---------- UI ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderPresets() {
  const box = $("presets");
  box.innerHTML = "";
  for (const pr of presets()) {
    const c = el("div", "chip", pr.name);
    c.dataset.p = pr.prompt;
    c.title = pr.prompt;
    c.addEventListener("click", () => { $("prompt").value = pr.prompt; save("prompt"); render(); });
    const del = el("span", "del", "\u00d7");
    del.title = "Delete preset";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      cfg.presets = presets().filter((x) => x !== pr);
      writeCfg().catch(fail);
      renderPresets();
      status(`Preset "${pr.name}" deleted.`);
    });
    c.appendChild(del);
    box.appendChild(c);
  }
  const add = el("div", "chip add", "+");
  add.title = "Save the current prompt as a preset";
  add.addEventListener("click", () => { $("presetAdd").className = "preset-add"; $("presetName").focus(); });
  box.appendChild(add);
  render();
}

const finished = (j) => j.state === "ready" || j.state === "error";
const pad2 = (n) => String(n).padStart(2, "0");

function render() {
  const edit = $("mode").value === "edit";
  for (const b of document.querySelectorAll("#modeSeg div")) b.className = b.dataset.v === $("mode").value ? "on" : "";
  $("modeHint").textContent = edit
    ? "Regenerates the whole selection from the prompt."
    : "Selection is the mask. A full-width strip around it is sent as context.";
  $("go").textContent = edit ? "Edit selection" : "Clean selection";
  for (const c of document.querySelectorAll("#presets .chip")) {
    if (c.dataset.p !== undefined) c.className = "chip" + (c.dataset.p === $("prompt").value.trim() ? " on" : "");
  }
  $("previewBar").className = "preview-bar" + (preview ? "" : " hidden");
  $("count").textContent = jobs.length;
  $("sessionStats").textContent = jobs.length
    ? `${jobs.filter((j) => j.outcome === "applied").length} applied \u00b7 ${jobs.filter((j) => !finished(j)).length} running`
    : "";
  for (const f of document.querySelectorAll("#filters div")) f.className = f.dataset.f === filter ? "on" : "";

  const shown = jobs.filter((j) => filter === "all" || (filter === "applied" ? j.outcome === "applied" : !j.outcome));
  const box = $("jobs");
  box.innerHTML = "";
  if (!shown.length) {
    box.appendChild(el("div", "empty", jobs.length ? "Nothing here with this filter." : "Every result of this Photoshop session shows up here. Click one to preview it in place."));
  }
  for (const job of shown) {
    const active = preview && preview.job === job;
    const row = el("div", "job" + (job.state === "ready" ? " ready" : "") + (active ? " active" : "") + (job.outcome ? " " + job.outcome : ""));
    if (job.thumb) { const img = el("img", "thumb"); img.src = job.thumb; row.appendChild(img); }
    else row.appendChild(el("div", "thumb" + (job.state === "error" ? "" : " pending")));

    const txt = el("div", "txt");
    const top = el("div", "top");
    top.appendChild(el("span", "tag" + (job.edit ? " edit" : ""), job.edit ? "EDIT" : "CLEAN"));
    top.appendChild(el("span", "doc", job.docName));
    top.appendChild(el("span", "time", `${pad2(job.time.getHours())}:${pad2(job.time.getMinutes())}`));
    txt.appendChild(top);
    txt.appendChild(el("div", "title", job.prompt));
    const pill = pillFor(job, active);
    const bottom = el("div", "bottom");
    bottom.appendChild(el("span", "pill " + pill.cls, pill.text));
    txt.appendChild(bottom);
    if (!finished(job)) {
      const bar = el("div", "bar"), fill = el("div");
      const [v, m] = (job.progress || "0/1").split("/").map(Number);
      fill.style.width = (job.state === "running" ? Math.max(4, Math.round(100 * v / m)) : 0) + "%";
      bar.appendChild(fill); txt.appendChild(bar);
    }
    row.appendChild(txt);

    const x = el("div", "x", "\u2715");
    x.title = finished(job) ? "Remove from list" : "Cancel";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      if (active) discardPreview(false).then(() => removeJob(job)).catch(fail);
      else if (finished(job)) removeJob(job);
      else cancelJob(job).catch(fail);
    });
    row.appendChild(x);
    if (job.state === "ready") row.addEventListener("click", () => showPreview(job).catch(fail));
    box.appendChild(row);
  }
}

function pillFor(job, active) {
  if (active) return { cls: "blue", text: "Previewing" };
  if (job.state === "error") return { cls: "red", text: "Error: " + job.error };
  if (job.state === "ready") {
    if (job.outcome === "applied") return { cls: "green", text: "Applied \u00b7 click to place again" };
    if (job.outcome === "discarded") return { cls: "grey", text: "Discarded \u00b7 click to preview" };
    return { cls: "green", text: "Ready \u00b7 click to preview" };
  }
  return { cls: job.state === "retrying" ? "amber" : "blue", text: stateText(job) };
}

for (const f of document.querySelectorAll("#filters div")) f.addEventListener("click", () => { filter = f.dataset.f; render(); });
$("clearDone").addEventListener("click", () => {
  for (const j of jobs.filter((j) => finished(j) && !(preview && preview.job === j))) removeJob(j);
  status("Cleared finished results.");
});

function stateText(job) {
  if (job.cancelled) return "Cancelling...";
  if (job.state === "starting") return "Starting ComfyUI...";
  if (job.state === "queued") return job.queuePos ? `Queued #${job.queuePos}` : "Queued";
  if (job.state === "retrying") return `Stuck, retrying (${job.retries}/2)...`;
  if (job.state === "running") return job.progress ? `Step ${job.progress}` : "Running...";
  const s = job.state.charAt(0).toUpperCase() + job.state.slice(1);
  return s + "..." + (job.retries ? ` (retry ${job.retries})` : "");
}
render();

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

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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
