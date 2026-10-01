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

// every supported diffusion model, with the loader node that can open it.
// The loaders' file lists overlap (Nunchaku's lists the whole diffusion_models folder, and its
// models are plain .safetensors), so the loader is picked from the file name, not the list it came from.
const NUNCHAKU = /svdq|nunchaku/i;
function listModels(info) {
  const out = [], seen = new Set();
  const names = ["UnetLoaderGGUF", "UNETLoader", "NunchakuFluxDiTLoader"]
    .flatMap((cls) => options(info, cls, cls === "NunchakuFluxDiTLoader" ? "model_path" : "unet_name"));
  for (const name of names) {
    const fam = family(name);
    if (!fam || seen.has(name)) continue;
    seen.add(name);
    let cls = "UNETLoader", input = "unet_name";
    if (/\.gguf$/i.test(name)) cls = "UnetLoaderGGUF";
    else if (NUNCHAKU.test(name)) [cls, input] = ["NunchakuFluxDiTLoader", "model_path"]; // Flux.1 only
    if (!info[cls] || (cls === "NunchakuFluxDiTLoader" && fam === "flux2")) continue; // loader not installed / can't load it
    out.push({ name, cls, input, family: fam, nunchaku: cls === "NunchakuFluxDiTLoader" });
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
    // only the matching size: the other one fails in the sampler with a shape error (missingFiles says what to get)
    const main = qwen.find((n) => new RegExp("[-_]" + size, "i").test(n));
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
  const get = " Download link in Settings.";
  if (!enc.main) throw new Error((model.family === "flux2" ? `No Qwen3-${/4b/i.test(model.name) ? "4B" : "8B"} text encoder found for this Klein model.` : "No T5-XXL text encoder found for Flux.1.") + get);
  if (model.family !== "flux2" && !enc.clipL) throw new Error("No clip_l text encoder found for Flux.1." + get);
  if (!vae) throw new Error((model.family === "flux2" ? "No Flux.2 VAE found (flux2-vae)." : "No Flux.1 VAE found (ae.safetensors).") + get);
  return { model, enc, vae };
}

// /object_info look-alike built from the ComfyUI folder on disk, so the pickers can list models while
// ComfyUI is off. files: { unet, enc, vae } file names (models/diffusion_models+unet, text_encoders+clip, vae),
// nodes: custom_nodes folder names (GGUF / Nunchaku loaders exist only when installed). Only for listing, never for graphs.
function diskInfo(files, nodes) {
  const combo = (k, v) => ({ input: { required: { [k]: [v] } } });
  const info = { UNETLoader: combo("unet_name", files.unet), CLIPLoader: combo("clip_name", files.enc), VAELoader: combo("vae_name", files.vae) };
  if (nodes.some((n) => /gguf/i.test(n))) Object.assign(info, { UnetLoaderGGUF: combo("unet_name", files.unet), CLIPLoaderGGUF: combo("clip_name", files.enc) });
  if (nodes.some((n) => /nunchaku/i.test(n))) info.NunchakuFluxDiTLoader = combo("model_path", files.unet);
  if (nodes.some((n) => /inpaint-nodes/i.test(n))) info.INPAINT_ColorMatch = { input: { required: {} } };
  return info;
}

// Custom node packs the plugin can use. Everything else in the templates is ComfyUI core.
const PACKS = {
  gguf: { name: "ComfyUI-GGUF", url: "https://github.com/city96/ComfyUI-GGUF" },
  nunchaku: { name: "ComfyUI-nunchaku", url: "https://github.com/nunchaku-tech/ComfyUI-nunchaku" },
  inpaint: { name: "comfyui-inpaint-nodes", url: "https://github.com/Acly/comfyui-inpaint-nodes" },
};

// What the user should install: [{ name, url, why, required }].
// files: model file names found on disk (ComfyUI doesn't list .gguf files at all without ComfyUI-GGUF, so only
// the disk tells they exist). coreNodes: node types the templates use; [] = unknown (ComfyUI offline, disk scan).
function missingNodes(info, files, coreNodes) {
  const out = [];
  const oldCore = [...new Set(coreNodes)].filter((c) => !info[c] && !c.startsWith("INPAINT_")); // INPAINT_*: the pack below
  if (oldCore.length) {
    out.push({ name: "Update ComfyUI", url: "https://github.com/comfyanonymous/ComfyUI", required: true, why: `it is too old (missing ${oldCore.join(", ")})` });
  }
  const hasGguf = files.some((n) => /\.gguf$/i.test(n));
  if (!info.UnetLoaderGGUF && (hasGguf || !listModels(info).length)) {
    out.push({ ...PACKS.gguf, required: true, why: hasGguf ? "your .gguf models need it" : "no usable model found; .gguf models need it" });
  }
  if (!info.NunchakuFluxDiTLoader && files.some((n) => NUNCHAKU.test(n) && family(n) && family(n) !== "flux2")) {
    out.push({ ...PACKS.nunchaku, required: true, why: "your svdq (Nunchaku) models need it" });
  }
  if (!info.INPAINT_ColorMatch) out.push({ ...PACKS.inpaint, required: true, why: "Clean's color match needs it" });
  return out;
}

// Text encoder / VAE files to download when the selected model's auto pick finds none (ComfyUI docs' links).
const HF = "https://huggingface.co/";
const DOWNLOADS = {
  qwen4b: { name: "qwen_3_4b.safetensors", folder: "text_encoders", url: HF + "Comfy-Org/flux2-klein-4B/blob/main/split_files/text_encoders/qwen_3_4b.safetensors" },
  qwen8b: { name: "qwen_3_8b_fp8mixed.safetensors", folder: "text_encoders", url: HF + "Comfy-Org/flux2-klein-9B/blob/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors" },
  flux2vae: { name: "flux2-vae.safetensors", folder: "vae", url: HF + "Comfy-Org/flux2-dev/blob/main/split_files/vae/flux2-vae.safetensors" },
  t5: { name: "t5xxl_fp8_e4m3fn_scaled.safetensors", folder: "text_encoders", url: HF + "comfyanonymous/flux_text_encoders/blob/main/t5xxl_fp8_e4m3fn_scaled.safetensors" },
  clipL: { name: "clip_l.safetensors", folder: "text_encoders", url: HF + "comfyanonymous/flux_text_encoders/blob/main/clip_l.safetensors" },
  ae: { name: "ae.safetensors", folder: "vae", url: HF + "Comfy-Org/Lumina_Image_2.0_Repackaged/blob/main/split_files/vae/ae.safetensors" },
  // Q4_K_M GGUF text encoders: about a third of the size; need ComfyUI-GGUF (offered only when it is installed)
  qwen4bGguf: { name: "Qwen3-4B-Q4_K_M.gguf", folder: "text_encoders", url: HF + "Qwen/Qwen3-4B-GGUF/blob/main/Qwen3-4B-Q4_K_M.gguf" },
  qwen8bGguf: { name: "Qwen3-8B-Q4_K_M.gguf", folder: "text_encoders", url: HF + "Qwen/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf" },
  t5Gguf: { name: "t5-v1_1-xxl-encoder-Q4_K_M.gguf", folder: "text_encoders", url: HF + "city96/t5-v1_1-xxl-encoder-gguf/blob/main/t5-v1_1-xxl-encoder-Q4_K_M.gguf" },
};

// [{ name, folder, url }] the selected model still needs. A text encoder / VAE picked by hand (not Auto) is trusted.
function missingFiles(info, sel) {
  const m = listModels(info).find((x) => x.name === sel.model);
  if (!m) return [];
  const flux2 = m.family === "flux2", auto = pickEncoders(m.family, m.name, encoderList(info)), out = [];
  const enc = (flux2 ? (/4b/i.test(m.name) ? "qwen4b" : "qwen8b") : "t5") + (info.CLIPLoaderGGUF ? "Gguf" : "");
  if ((!sel.clip || sel.clip === AUTO) && !auto.main) out.push(DOWNLOADS[enc]);
  if (!flux2 && !auto.clipL) out.push(DOWNLOADS.clipL); // Flux.1's clip_l is always picked automatically
  if ((!sel.vae || sel.vae === AUTO) && !pickVae(m.family, vaeList(info))) out.push(flux2 ? DOWNLOADS.flux2vae : DOWNLOADS.ae);
  return out;
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

// Clean templates end in 23 (INPAINT_ColorMatch, comfyui-inpaint-nodes) -> 19 (output), as krita-ai-diffusion:
// LAB mean/std taken only from pixels outside the selection, so the removed text can't skew it. Required: without
// it cleaned patches come out visibly darker/lighter. 0 = off (the only way to run without the pack).
function applyColorMatch(info, g, strength) {
  if (!g["23"]) return;
  if (strength <= 0) { delete g["23"]; g["19"].inputs.images = ["18", 0]; return; }
  if (!info.INPAINT_ColorMatch) throw new Error("Clean needs the comfyui-inpaint-nodes custom node for its color match. Install it (link in Settings), or set Color match to 0.");
  g["23"].inputs.strength = strength;
}

module.exports = { AUTO, TEMPLATES, family, listModels, encoderList, vaeList, pickEncoders, pickVae, resolve, buildGraph, diskInfo, missingNodes, missingFiles };
