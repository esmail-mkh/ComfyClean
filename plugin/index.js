const { app, core, imaging, action, constants } = require("photoshop");
const { localFileSystem: fs, formats } = require("uxp").storage;

const $ = (id) => document.getElementById(id);
const FIELDS = ["mode", "prompt", "pad", "url", "model", "clip"];
let running = 0;
let jobSeq = 0;

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
$("go").addEventListener("click", () => clean().catch((e) => status("Error: " + (e.message || e))));
$("reload").addEventListener("click", () => loadModels().catch((e) => status("Error: " + (e.message || e))));
// 4B model wants Qwen3-4B, 9B wants Qwen3-8B
$("model").addEventListener("change", () => {
  const want = /4b/i.test($("model").value) ? /qwen3.?4b/i : /9b/i.test($("model").value) ? /qwen3.?8b/i : null;
  const opt = want && [...$("clip").options].find((o) => want.test(o.value));
  if (opt) { $("clip").value = opt.value; save("clip"); }
});
loadModels().catch(() => status("ComfyUI not reachable. Start it, then Reload models."));

// options carry the loader node class so .safetensors and .gguf both work
async function loadModels() {
  const base = $("url").value.replace(/\/+$/, "");
  const info = await json(fetch(base + "/object_info"));
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

function status(msg) { $("status").textContent = (running ? `[${running} running] ` : "") + msg; }

const modal = (fn) => core.executeAsModal(fn, { commandName: "Comfy Clean" });
const play = (cmds) => action.batchPlay(cmds, {});
const selectionRef = [{ _ref: "channel", _property: "selection" }];
const saveSel = (name) => play([{ _obj: "duplicate", _target: selectionRef, name }]);
const loadSel = (name) => play([{ _obj: "set", _target: selectionRef, to: { _ref: "channel", _name: name } }]);
const dropChannel = (name) => play([{ _obj: "delete", _target: [{ _ref: "channel", _name: name }] }]);
const deselect = () => play([{ _obj: "set", _target: selectionRef, to: { _enum: "ordinal", _value: "none" } }]);

async function clean() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("No document open.");
  const sel = doc.selection.bounds;
  if (!sel) throw new Error("Make a selection first.");

  const base = $("url").value.replace(/\/+$/, "");
  const prompt = $("prompt").value.trim();
  const pad = +$("pad").value || 0;
  const edit = $("mode").value === "edit";
  const id = `ps_clean_${Date.now()}_${++jobSeq}`;

  // Only this crop goes to ComfyUI, so page height doesn't matter.
  // clean: full page width, selection's height band + context above/below. edit: just the selection box.
  const rect = edit ? {
    left: Math.max(0, Math.floor(sel.left)),
    top: Math.max(0, Math.floor(sel.top)),
    right: Math.min(doc.width, Math.ceil(sel.right)),
    bottom: Math.min(doc.height, Math.ceil(sel.bottom)),
  } : {
    left: 0,
    top: Math.max(0, Math.floor(sel.top - pad)),
    right: doc.width,
    bottom: Math.min(doc.height, Math.ceil(sel.bottom + pad)),
  };
  const w = rect.right - rect.left, h = rect.bottom - rect.top;

  running++;
  try {
    status("Reading pixels...");
    let jpeg, maskJpeg;
    await modal(async () => {
      await saveSel(id); // keep the exact selection shape for the layer mask later
      // workflow rescales to ~1MP anyway; cap upload size for huge selections
      const targetSize = Math.max(w, h) > 2048 ? (w > h ? { width: 2048 } : { height: 2048 }) : undefined;
      const pix = await imaging.getPixels({
        documentID: doc.id, sourceBounds: rect, targetSize,
        componentSize: 8, applyAlpha: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1",
      });
      jpeg = b64decode(await imaging.encodeImageData({ imageData: pix.imageData, base64: true }));
      pix.imageData.dispose();
      if (edit) return;

      // selection -> grayscale -> RGB jpeg, so Flux only repaints the selected part
      const selImg = await imaging.getSelection({ documentID: doc.id, sourceBounds: rect, targetSize });
      const g = await selImg.imageData.getData({ chunky: true });
      const rgb = new Uint8Array(g.length * 3);
      for (let i = 0; i < g.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g[i];
      const maskData = await imaging.createImageDataFromBuffer(rgb, {
        width: selImg.imageData.width, height: selImg.imageData.height, components: 3,
        colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1",
      });
      maskJpeg = b64decode(await imaging.encodeImageData({ imageData: maskData, base64: true }));
      selImg.imageData.dispose();
      maskData.dispose();
    });

    status("Uploading...");
    // node ids match plugin/workflow.json: 1 = model, 2 = text encoder, 4 = image, 20 = mask, 7 = prompt, 15 = seed
    const wfFile = await (await fs.getPluginFolder()).getEntry("workflow.json");
    const wf = JSON.parse(await wfFile.read());
    wf["4"].inputs.image = await upload(base, id + ".jpg", jpeg);
    if (edit) toEditGraph(wf);
    else wf["20"].inputs.image = await upload(base, id + "_mask.jpg", maskJpeg);
    wf["7"].inputs.text = prompt;
    wf["15"].inputs.noise_seed = Math.floor(Math.random() * 2 ** 31);
    const model = $("model").selectedOptions[0], clip = $("clip").selectedOptions[0];
    if (model) wf["1"] = model.dataset.cls === "UNETLoader"
      ? { class_type: "UNETLoader", inputs: { unet_name: model.value, weight_dtype: "default" } }
      : { class_type: "UnetLoaderGGUF", inputs: { unet_name: model.value } };
    if (clip) wf["2"] = { class_type: clip.dataset.cls, inputs: { clip_name: clip.value, type: "flux2" } };

    status("Generating...");
    const pid = (await json(fetch(base + "/prompt", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: wf }),
    }))).prompt_id;
    const img = await waitResult(base, pid);
    const png = await (await fetch(`${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`)).arrayBuffer();

    // ponytail: temp file is the only way to place an image; deleted right after
    const tmp = await (await fs.getTemporaryFolder()).createFile(id + ".png", { overwrite: true });
    await tmp.write(png, { format: formats.binary });

    status("Placing...");
    await modal(async () => {
      if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
      const userSel = doc.selection.bounds ? id + "_user" : null; // user may have selected the next bubble meanwhile
      if (userSel) await saveSel(userSel);

      await play([{ _obj: "placeEvent", null: { _path: await fs.createSessionToken(tmp), _kind: "local" } }]);
      const layer = doc.activeLayers[0];
      let b = layer.bounds;
      await layer.scale(100 * w / (b.right - b.left), 100 * h / (b.bottom - b.top), constants.AnchorPosition.TOPLEFT);
      b = layer.bounds;
      await layer.translate(rect.left - b.left, rect.top - b.top);
      await layer.rasterize(constants.RasterizeType.ENTIRELAYER);
      layer.name = "Clean: " + prompt.slice(0, 40);

      await loadSel(id); // exact selection, no expand/feather
      await play([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } }]);
      await dropChannel(id);

      if (userSel) { await loadSel(userSel); await dropChannel(userSel); } else await deselect();
    });
    await tmp.delete();
    running--;
    status("Done.");
  } catch (e) {
    running--;
    try { await modal(() => dropChannel(id)); } catch (_) {}
    throw e;
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

async function json(p) {
  const r = await p;
  if (!r.ok) throw new Error(`ComfyUI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function waitResult(base, pid) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = (await json(fetch(`${base}/history/${pid}`)))[pid];
    if (!h) continue;
    if (h.status && h.status.status_str === "error") {
      const err = (h.status.messages || []).find((m) => m[0] === "execution_error");
      throw new Error(err ? err[1].exception_message : "ComfyUI execution failed");
    }
    const out = Object.values(h.outputs || {}).find((o) => o.images && o.images.length);
    if (out) return out.images[0];
  }
}

// hand-built multipart: no FormData/Blob dependency in UXP
async function upload(base, name, bytes) {
  const b = "----cc" + Date.now();
  const head = ascii(`--${b}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n` +
    `--${b}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: image/jpeg\r\n\r\n`);
  const tail = ascii(`\r\n--${b}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const r = await json(fetch(base + "/upload/image", {
    method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=" + b }, body: body.buffer,
  }));
  return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
}

function ascii(s) { return Uint8Array.from(s, (c) => c.charCodeAt(0)); }

function b64decode(s) {
  s = s.slice(s.indexOf(",") + 1).replace(/[^A-Za-z0-9+/]/g, "");
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const t = new Uint8Array(128);
  for (let i = 0; i < 64; i++) t[A.charCodeAt(i)] = i;
  const out = new Uint8Array((s.length * 3) >> 2);
  for (let i = 0, j = 0; i < s.length; i += 4) {
    const n = (t[s.charCodeAt(i)] << 18) | (t[s.charCodeAt(i + 1)] << 12) | (t[s.charCodeAt(i + 2)] << 6) | t[s.charCodeAt(i + 3)];
    out[j++] = n >> 16;
    if (j < out.length) out[j++] = (n >> 8) & 255;
    if (j < out.length) out[j++] = n & 255;
  }
  return out;
}
