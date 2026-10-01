// Model family detection, auto text-encoder/VAE picking and API graph building.
// Pure functions: used by index.js in Photoshop and by tests/ under node.

const AUTO = "auto";
const TEMPLATES = ["flux2_clean", "flux2_edit", "kontext_clean", "kontext_edit", "fill_clean"];

// family from the file name; models that match nothing aren't offered
function family(name) {
  if (/fill/i.test(name)) return "fill";
  if (/kontext/i.test(name)) return "kontext";
  if (/klein|flux[-_.]?2/i.test(name)) return "flux2";
  return null;
}

function options(info, cls, input) {
  const spec = info[cls] && (info[cls].input.required[input] || (info[cls].input.optional || {})[input]);
  if (!spec) return [];
  return Array.isArray(spec[0]) ? spec[0] : (spec[1] && spec[1].options) || [];
}

// every supported diffusion model, with the loader node that can open it
function listModels(info) {
  const out = [], seen = new Set();
  for (const [cls, input] of [["UnetLoaderGGUF", "unet_name"], ["UNETLoader", "unet_name"], ["NunchakuFluxDiTLoader", "model_path"]]) {
    for (const name of options(info, cls, input)) {
      const fam = family(name);
      if (!fam || seen.has(name)) continue;
      if (cls === "UNETLoader" && /\.gguf$/i.test(name)) continue;
      seen.add(name);
      out.push({ name, cls, input, family: fam, nunchaku: cls.startsWith("Nunchaku") });
    }
  }
  return out;
}

// GGUF loaders list .safetensors too, so prefer their list when ComfyUI-GGUF is installed
const encoderList = (info) => (info.CLIPLoaderGGUF ? options(info, "CLIPLoaderGGUF", "clip_name") : options(info, "CLIPLoader", "clip_name"));
const vaeList = (info) => options(info, "VAELoader", "vae_name").filter((n) => !/^(taes|taef|pixel_space)/.test(n));

function pickEncoders(fam, model, list) {
  if (fam === "flux2") {
    const size = /4b/i.test(model) ? "4b" : "8b"; // Klein 4B -> Qwen3-4B, Klein 9B -> Qwen3-8B
    const qwen = list.filter((n) => /qwen[-_]?3/i.test(n) && !/vl/i.test(n));
    const main = qwen.find((n) => new RegExp("[-_]" + size, "i").test(n)) || qwen[0];
    return { main };
  }
  const t5 = list.filter((n) => /t5/i.test(n) && !/umt5/i.test(n));
  return { main: t5.find((n) => /xxl/i.test(n)) || t5[0], clipL: list.find((n) => /clip[-_]?l\b|clip_l/i.test(n)) };
}

function pickVae(fam, list) {
  if (fam === "flux2") return list.find((n) => /flux[-_.]?2/i.test(n));
  return list.find((n) => /^ae\.(safetensors|sft|pt)$/i.test(n))
    || list.find((n) => /flux/i.test(n) && /vae|ae/i.test(n) && !/flux[-_.]?2/i.test(n));
}

// what will actually be used, given the user's picks ("auto" or a file name)
function resolve(info, sel) {
  const model = listModels(info).find((m) => m.name === sel.model);
  if (!model) throw new Error(`Model "${sel.model}" not found in ComfyUI.`);
  const auto = pickEncoders(model.family, model.name, encoderList(info));
  const enc = { main: sel.clip && sel.clip !== AUTO ? sel.clip : auto.main, clipL: auto.clipL };
  const vae = sel.vae && sel.vae !== AUTO ? sel.vae : pickVae(model.family, vaeList(info));
  if (!enc.main) throw new Error(model.family === "flux2" ? "No Qwen3 text encoder found for Flux.2 Klein." : "No T5-XXL text encoder found for Flux.1.");
  if (model.family !== "flux2" && !enc.clipL) throw new Error("No clip_l text encoder found for Flux.1.");
  if (!vae) throw new Error(model.family === "flux2" ? "No Flux.2 VAE found (flux2-vae)." : "No Flux.1 VAE found (ae.safetensors).");
  return { model, enc, vae };
}

// fill in required widget inputs the template doesn't set (e.g. Nunchaku loader options) from ComfyUI's defaults
function withDefaults(info, node) {
  const req = (info[node.class_type] || { input: { required: {} } }).input.required;
  for (const [k, spec] of Object.entries(req)) {
    if (k in node.inputs) continue;
    const meta = spec[1] || {};
    if (Array.isArray(spec[0])) node.inputs[k] = "default" in meta ? meta.default : spec[0][0];
    else if (spec[0] === "COMBO") node.inputs[k] = "default" in meta ? meta.default : (meta.options || [])[0];
    else if ("default" in meta) node.inputs[k] = meta.default;
  }
  return node;
}

// opts: { model, clip, vae, steps, colorMatch (0-1), edit, image, mask, prompt, seed }
function buildGraph(info, templates, opts) {
  const { model, enc, vae } = resolve(info, opts);
  if (opts.edit && model.family === "fill") throw new Error("Fill models only inpaint. Use Clean mode, or an edit model (Klein / Kontext) for Edit.");
  const g = JSON.parse(JSON.stringify(templates[`${model.family}_${opts.edit ? "edit" : "clean"}`]));

  g["1"] = withDefaults(info, model.nunchaku
    ? { class_type: model.cls, inputs: { [model.input]: model.name } }
    : { class_type: model.cls, inputs: { unet_name: model.name, ...(model.cls === "UNETLoader" ? { weight_dtype: "default" } : {}) } });
  const gguf = info.CLIPLoaderGGUF && [enc.main, enc.clipL].some((n) => /\.gguf$/i.test(n || ""));
  g["2"] = model.family === "flux2"
    ? { class_type: gguf ? "CLIPLoaderGGUF" : "CLIPLoader", inputs: { clip_name: enc.main, type: "flux2" } }
    : { class_type: gguf ? "DualCLIPLoaderGGUF" : "DualCLIPLoader", inputs: { clip_name1: enc.main, clip_name2: enc.clipL, type: "flux" } };
  g["3"] = { class_type: "VAELoader", inputs: { vae_name: vae } };

  g["4"].inputs.image = opts.image;
  if (g["20"]) g["20"].inputs.image = opts.mask;
  g["7"].inputs.text = opts.prompt;
  applyColorMatch(info, g, opts.colorMatch === undefined ? 1 : opts.colorMatch);
  for (const n of Object.values(g)) {
    if ("noise_seed" in n.inputs) n.inputs.noise_seed = opts.seed;
    if (n.class_type === "KSampler") n.inputs.seed = opts.seed;
    if (opts.steps > 0 && typeof n.inputs.steps === "number") n.inputs.steps = opts.steps;
  }
  return g;
}

// Clean templates end in 22 (composite) -> 23 (ColorTransfer) -> 19 (output).
// With comfyui-inpaint-nodes, use its masked color match instead (krita-ai-diffusion does the same):
// LAB mean/std taken only from pixels outside the selection, so the removed text can't skew it.
function applyColorMatch(info, g, strength) {
  if (!g["23"]) return;
  if (strength <= 0) { delete g["22"]; delete g["23"]; g["19"].inputs.images = ["18", 0]; return; }
  if (info.INPAINT_ColorMatch) {
    delete g["22"];
    g["23"] = { class_type: "INPAINT_ColorMatch", inputs: { target: ["18", 0], reference: ["5", 0], exclude_mask: ["20", 0], strength } };
  } else g["23"].inputs.strength = strength;
}

module.exports = { AUTO, TEMPLATES, family, listModels, encoderList, vaeList, pickEncoders, pickVae, resolve, buildGraph };
