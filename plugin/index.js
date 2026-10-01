const { app, core, imaging, action, constants } = require("photoshop");
const uxp = require("uxp");
const { localFileSystem: fs, formats } = uxp.storage;

const $ = (id) => document.getElementById(id);
const FIELDS = ["mode", "prompt", "pad", "stuck", "url", "model", "clip"];
const CLIENT = "ps_clean_" + Date.now();
const SRGB = "sRGB IEC61966-2.1";
const jobs = []; // newest first. Results live only in memory: gone when Photoshop closes.
let preview = null; // { job, docId, layerId } -- the result currently shown in its document
let jobSeq = 0;
let ws = null;

// "Clean selection" is also a Plugins-menu command, so it can get a keyboard shortcut
uxp.entrypoints.setup({
  commands: { clean: () => clean().catch(fail) },
  panels: {
    main: {
      show(node) { if (node && node !== document.body && !node.contains($("app"))) node.appendChild($("app")); },
    },
  },
});

const load = (f) => { try { return localStorage.getItem("cc_" + f); } catch (e) { return null; } };
const save = (f) => { try { localStorage.setItem("cc_" + f, $(f).value); } catch (e) {} };

// remember settings between sessions
for (const f of FIELDS) {
  const v = load(f);
  if (v !== null) $(f).value = v;
  $(f).addEventListener("change", () => save(f));
}
if (!$("prompt").value) $("prompt").value = $("preset").value;
$("preset").addEventListener("change", () => { $("prompt").value = $("preset").value; save("prompt"); });
$("go").addEventListener("click", () => clean().catch(fail));
$("reload").addEventListener("click", () => loadModels().catch(fail));
$("apply").addEventListener("click", () => applyPreview().catch(fail));
$("discard").addEventListener("click", () => discardPreview(true).catch(fail));
$("mode").addEventListener("change", () => render());
// 4B model wants Qwen3-4B, 9B wants Qwen3-8B
$("model").addEventListener("change", () => {
  const want = /4b/i.test($("model").value) ? /qwen3.?4b/i : /9b/i.test($("model").value) ? /qwen3.?8b/i : null;
  const opt = want && [...$("clip").options].find((o) => want.test(o.value));
  if (opt) { $("clip").value = opt.value; save("clip"); }
});
loadModels().catch(() => status("ComfyUI not reachable. Start it, then Reload models."));
// leftovers from a crash mid-place
fs.getTemporaryFolder().then(async (t) => {
  for (const e of await t.getEntries()) if (e.name.startsWith("ps_clean_")) await e.delete();
}).catch(() => {});

function status(msg) { $("status").textContent = msg; }
function fail(e) { status("Error: " + (e.message || e)); }
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

// options carry the loader node class so .safetensors and .gguf both work
async function loadModels() {
  const info = await json(fetch(baseUrl() + "/object_info"));
  const fill = (sel, loaders, fallback) => {
    sel.innerHTML = "";
    for (const cls of loaders) {
      if (!info[cls]) continue;
      const req = info[cls].input.required, spec = req[Object.keys(req)[0]];
      for (const name of Array.isArray(spec[0]) ? spec[0] : (spec[1] && spec[1].options) || []) {
        const o = document.createElement("option");
        o.value = name; o.textContent = name; o.dataset.cls = cls;
        sel.appendChild(o);
      }
    }
    sel.value = load(sel.id) || fallback;
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  };
  fill($("model"), ["UnetLoaderGGUF", "UNETLoader"], "flux-2-klein-9b-Q4_K_S.gguf");
  fill($("clip"), ["CLIPLoaderGGUF", "CLIPLoader"], "Qwen3-8B-Q4_K_M.gguf");
  status("Models loaded. Make a selection, then click Clean.");
}

// ---------- jobs ----------

async function clean() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("No document open.");
  const sel = doc.selection.bounds;
  if (!sel) throw new Error("Make a selection first.");

  const edit = $("mode").value === "edit";
  const pad = +$("pad").value || 0;
  // Only this crop goes to ComfyUI, so page height doesn't matter.
  // clean: full page width, selection's height band + context above/below. edit: just the selection box.
  const rect = edit ? clampRect(sel, doc)
    : clampRect({ left: 0, right: doc.width, top: sel.top - pad, bottom: sel.bottom + pad }, doc);
  const job = {
    id: `ps_clean_${Date.now()}_${++jobSeq}`, docId: doc.id, docName: doc.title, base: baseUrl(),
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

    job.state = "uploading"; render();
    // node ids match plugin/workflow.json: 1 = model, 2 = text encoder, 4 = image, 20 = mask, 7 = prompt, 15 = seed
    const wf = JSON.parse(await (await (await fs.getPluginFolder()).getEntry("workflow.json")).read());
    wf["4"].inputs.image = await upload(job.base, job.id + ".jpg", jpeg);
    wf["7"].inputs.text = job.prompt;
    wf["15"].inputs.noise_seed = Math.floor(Math.random() * 2 ** 31);
    const model = $("model").selectedOptions[0], clip = $("clip").selectedOptions[0];
    if (model) wf["1"] = model.dataset.cls === "UNETLoader"
      ? { class_type: "UNETLoader", inputs: { unet_name: model.value, weight_dtype: "default" } }
      : { class_type: "UnetLoaderGGUF", inputs: { unet_name: model.value } };
    if (clip) wf["2"] = { class_type: clip.dataset.cls, inputs: { clip_name: clip.value, type: "flux2" } };
    if (edit) toEditGraph(wf);
    else wf["20"].inputs.image = await upload(job.base, job.id + "_mask.jpg", await maskJpeg(job));
    if (job.cancelled) throw new Error("Cancelled");

    connectWs(job.base);
    job.wf = wf;
    job.retries = 0;
    await submit(job, false);
    const img = await waitResult(job);
    job.png = new Uint8Array(await (await fetch(`${job.base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`)).arrayBuffer());
    job.thumb = "data:image/png;base64," + b64encode(job.png);
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

// edit mode: no mask, no color match -- plain Flux.2 Klein edit of the whole crop.
// mirrored in tests/test_workflow.py, keep in sync
function toEditGraph(wf) {
  for (const n of ["20", "21", "22", "23"]) delete wf[n];
  wf["16"] = { class_type: "EmptyFlux2LatentImage", inputs: { width: ["6", 0], height: ["6", 1], batch_size: 1 } };
  wf["17"].inputs.latent_image = ["16", 0];
  wf["19"].inputs.images = ["18", 0];
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
    if (m.type === "executing") { job.sampling = d.node === "17"; job.tick = Date.now(); }
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
  await tmp.write(job.png.buffer, { format: formats.binary });
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
  removeJob(p.job);
  status("Applied.");
}

async function discardPreview(dropJob) {
  if (!preview) return;
  const p = preview;
  preview = null;
  if (findDoc(p.docId)) {
    try { await modal(() => play([{ _obj: "delete", _target: layerRef(p) }])); } catch (e) {} // user may have deleted it already
  }
  if (dropJob) { removeJob(p.job); status("Discarded."); } else render();
}

// ---------- UI ----------

function render() {
  $("previewBar").style.display = preview ? "flex" : "none";
  $("go").textContent = $("mode").value === "edit" ? "Edit selection" : "Clean selection";
  const box = $("jobs");
  box.innerHTML = "";
  for (const job of jobs) {
    const el = document.createElement("div");
    el.className = "job" + (job.state === "ready" ? " ready" : "") + (preview && preview.job === job ? " active" : "");
    if (job.thumb) { const img = document.createElement("img"); img.src = job.thumb; el.appendChild(img); }
    const txt = document.createElement("div");
    txt.className = "txt";
    const title = document.createElement("div");
    title.textContent = (job.edit ? "Edit: " : "") + job.prompt.slice(0, 50);
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = job.docName + " · " + stateText(job);
    txt.appendChild(title); txt.appendChild(sub); el.appendChild(txt);

    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = job.state === "ready" || job.state === "error" ? "Remove" : "Cancel";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      if (preview && preview.job === job) discardPreview(true).catch(fail);
      else if (job.state === "ready" || job.state === "error") removeJob(job);
      else cancelJob(job).catch(fail);
    });
    el.appendChild(x);
    if (job.state === "ready") el.addEventListener("click", () => showPreview(job).catch(fail));
    box.appendChild(el);
  }
}

function stateText(job) {
  if (job.cancelled) return "cancelling...";
  if (job.state === "queued") return job.queuePos ? `queued #${job.queuePos}` : "queued";
  if (job.state === "retrying") return `stuck, retrying (${job.retries}/2)...`;
  if (job.state === "running") return job.progress ? `step ${job.progress}` : "running...";
  if (job.state === "ready") return preview && preview.job === job ? "previewing" : "ready - click to preview";
  if (job.state === "error") return "error: " + job.error;
  return job.state + "..." + (job.retries ? ` (retry ${job.retries})` : "");
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
