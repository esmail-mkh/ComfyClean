// node tests/test_models.js  -- checks auto model/encoder/VAE picking and that every template builds into a valid graph.
// Uses tests/tmp/object_info.json (live ComfyUI dump) if present, plus fake Flux.1 / Nunchaku installs.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const M = require("../plugin/models.js");

const templates = Object.fromEntries(M.TEMPLATES.map((t) =>
  [t, JSON.parse(fs.readFileSync(path.join(__dirname, "../plugin/workflows", t + ".json"), "utf8"))]));

const combo = (list) => [list];
// Like the real nodes: UNETLoader and NunchakuFluxDiTLoader both list every .safetensors in diffusion_models
// (ComfyUI-nunchaku nodes/models/flux.py), GGUF loader lists .gguf too.
const SAFETENSORS = ["flux1-kontext-dev-fp8.safetensors", "svdq-int4_r32-flux.1-fill-dev.safetensors", "svdq-int4_r32-flux.1-kontext-dev.safetensors"];
const fake = {
  UnetLoaderGGUF: { input: { required: { unet_name: combo(["flux-2-klein-4b-Q5_K_M.gguf", "flux-2-klein-9b-Q4_K_S.gguf", "flux1-fill-dev-Q4_K.gguf", "qwen-image-2.1-Q4_K_M.gguf", ...SAFETENSORS]) } } },
  UNETLoader: { input: { required: { unet_name: combo(SAFETENSORS), weight_dtype: combo(["default", "fp8_e4m3fn"]) } } },
  NunchakuFluxDiTLoader: { input: { required: {
    model_path: combo(SAFETENSORS),
    cache_threshold: ["FLOAT", { default: 0, min: 0, max: 1 }],
    attention: [["nunchaku-fp16", "flash-attention2"], { default: "nunchaku-fp16" }],
    cpu_offload: [["auto", "enable", "disable"], { default: "auto" }],
    device_id: ["INT", { default: 0, lazy: true }],
    data_type: [["bfloat16", "float16"], { default: "bfloat16" }],
  }, optional: { i2f_mode: [["enabled", "always"], { default: "enabled" }] } } },
  CLIPLoaderGGUF: { input: { required: { clip_name: combo(["Qwen3-4B-Q5_K_M.gguf", "Qwen3-8B-Q4_K_M.gguf", "qwen3vl_8b_x.safetensors", "clip_l.safetensors", "t5xxl_fp8_e4m3fn.safetensors", "t5-v1_1-xxl-encoder-Q5_K_S.gguf"]) } } },
  VAELoader: { input: { required: { vae_name: combo(["Qwen_Image-VAE.safetensors", "ae.safetensors", "flux2-vae.safetensors", "taef1"]) } } },
};

function checkLinks(g, label) {
  for (const [id, n] of Object.entries(g)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v)) assert.ok(g[v[0]], `${label}: node ${id}.${k} links to missing node ${v[0]}`);
    }
  }
}

function build(info, model, edit, extra = {}) {
  return M.buildGraph(info, templates, { model, clip: M.AUTO, vae: M.AUTO, steps: 0, edit, image: "a.jpg [temp]", mask: "m.jpg [temp]", prompt: "remove text", seed: 7, ...extra });
}

// unsupported families stay out of the list
const names = M.listModels(fake).map((m) => m.name);
assert.ok(!names.includes("qwen-image-2.1-Q4_K_M.gguf"));
assert.strictEqual(names.length, 6);

// Klein: right Qwen size, flux2 VAE, GGUF clip loader
let g = build(fake, "flux-2-klein-4b-Q5_K_M.gguf", false);
assert.deepStrictEqual([g["2"].class_type, g["2"].inputs.clip_name, g["3"].inputs.vae_name], ["CLIPLoaderGGUF", "Qwen3-4B-Q5_K_M.gguf", "flux2-vae.safetensors"]);
g = build(fake, "flux-2-klein-9b-Q4_K_S.gguf", true);
assert.strictEqual(g["2"].inputs.clip_name, "Qwen3-8B-Q4_K_M.gguf");
assert.ok(!g["20"], "edit graph has no mask");

// Flux.1 fill (gguf) and kontext (safetensors): T5 + clip_l, ae VAE
g = build(fake, "flux1-fill-dev-Q4_K.gguf", false);
assert.deepStrictEqual([g["1"].class_type, g["2"].class_type, g["2"].inputs.clip_name1, g["2"].inputs.clip_name2, g["3"].inputs.vae_name],
  ["UnetLoaderGGUF", "DualCLIPLoader", "t5xxl_fp8_e4m3fn.safetensors", "clip_l.safetensors", "ae.safetensors"]);
g = build(fake, "flux1-fill-dev-Q4_K.gguf", false, { clip: "t5-v1_1-xxl-encoder-Q5_K_S.gguf" }); // any .gguf encoder -> GGUF loader
assert.strictEqual(g["2"].class_type, "DualCLIPLoaderGGUF");
assert.throws(() => build(fake, "flux1-fill-dev-Q4_K.gguf", true), /Fill models only inpaint/);
g = build(fake, "flux1-kontext-dev-fp8.safetensors", false, { steps: 12 });
assert.deepStrictEqual([g["1"].class_type, g["1"].inputs.weight_dtype, g["15"].inputs.steps, g["15"].inputs.seed], ["UNETLoader", "default", 12, 7]);

// Nunchaku: picked by file name even though UNETLoader lists the same file; required options from node defaults
const byName = Object.fromEntries(M.listModels(fake).map((m) => [m.name, m.cls]));
assert.deepStrictEqual(byName, {
  "flux-2-klein-4b-Q5_K_M.gguf": "UnetLoaderGGUF", "flux-2-klein-9b-Q4_K_S.gguf": "UnetLoaderGGUF", "flux1-fill-dev-Q4_K.gguf": "UnetLoaderGGUF",
  "flux1-kontext-dev-fp8.safetensors": "UNETLoader",
  "svdq-int4_r32-flux.1-fill-dev.safetensors": "NunchakuFluxDiTLoader", "svdq-int4_r32-flux.1-kontext-dev.safetensors": "NunchakuFluxDiTLoader",
});
g = build(fake, "svdq-int4_r32-flux.1-kontext-dev.safetensors", true);
assert.deepStrictEqual(g["1"], { class_type: "NunchakuFluxDiTLoader", inputs: {
  model_path: "svdq-int4_r32-flux.1-kontext-dev.safetensors", cache_threshold: 0, attention: "nunchaku-fp16", cpu_offload: "auto", device_id: 0, data_type: "bfloat16" } });
g = build(fake, "svdq-int4_r32-flux.1-fill-dev.safetensors", false);
assert.deepStrictEqual([g["1"].class_type, g["2"].class_type, g["3"].inputs.vae_name, g["24"].inputs.guidance], ["NunchakuFluxDiTLoader", "DualCLIPLoader", "ae.safetensors", 30]);
checkLinks(g, "nunchaku fill");
// without ComfyUI-nunchaku installed, svdq files aren't offered (the regular loader can't open them)
const noNunchaku = { ...fake }; delete noNunchaku.NunchakuFluxDiTLoader;
assert.ok(!M.listModels(noNunchaku).some((m) => /svdq/.test(m.name)));

// manual overrides win over auto
g = build(fake, "flux-2-klein-9b-Q4_K_S.gguf", false, { clip: "Qwen3-4B-Q5_K_M.gguf", vae: "ae.safetensors" });
assert.deepStrictEqual([g["2"].inputs.clip_name, g["3"].inputs.vae_name], ["Qwen3-4B-Q5_K_M.gguf", "ae.safetensors"]);

// color match: masked node when available, ColorTransfer fallback, 0 = off
const withCM = { ...fake, INPAINT_ColorMatch: { input: { required: {} } } };
g = build(withCM, "flux-2-klein-9b-Q4_K_S.gguf", false, { colorMatch: 0.7 });
assert.deepStrictEqual(g["23"], { class_type: "INPAINT_ColorMatch", inputs: { target: ["18", 0], reference: ["5", 0], exclude_mask: ["20", 0], strength: 0.7 } });
assert.ok(!g["22"]);
checkLinks(g, "masked color match");
g = build(fake, "flux-2-klein-9b-Q4_K_S.gguf", false, { colorMatch: 0.5 });
assert.deepStrictEqual([g["23"].class_type, g["23"].inputs.strength], ["ColorTransfer", 0.5]);
g = build(withCM, "flux-2-klein-9b-Q4_K_S.gguf", false, { colorMatch: 0 });
assert.ok(!g["23"] && !g["22"]);
assert.deepStrictEqual(g["19"].inputs.images, ["18", 0]);

// every family x mode builds and all links resolve
for (const [model, modes] of [["flux-2-klein-9b-Q4_K_S.gguf", [false, true]], ["flux1-kontext-dev-fp8.safetensors", [false, true]], ["flux1-fill-dev-Q4_K.gguf", [false]]]) {
  for (const edit of modes) checkLinks(build(fake, model, edit), `${model} edit=${edit}`);
}

// real ComfyUI install, if dumped
const live = path.join(__dirname, "tmp/object_info.json");
if (fs.existsSync(live)) {
  const info = JSON.parse(fs.readFileSync(live, "utf8"));
  for (const m of M.listModels(info)) {
    const r = M.resolve(info, { model: m.name, clip: M.AUTO, vae: M.AUTO });
    console.log(`live: ${m.name} [${m.family}] -> ${r.enc.main}${r.enc.clipL ? " + " + r.enc.clipL : ""}, ${r.vae}`);
  }

  // every graph (built with fake model files) must match the real node schemas of this ComfyUI:
  // class exists, required inputs present, combo values valid, links point at real output slots
  const FILE_INPUTS = new Set(["unet_name", "clip_name", "clip_name1", "clip_name2", "vae_name", "model_path", "image"]);
  const live2 = { ...info, NunchakuFluxDiTLoader: fake.NunchakuFluxDiTLoader }; // not installed here
  const cases = [["flux-2-klein-9b-Q4_K_S.gguf", false], ["flux-2-klein-9b-Q4_K_S.gguf", true], ["flux1-kontext-dev-fp8.safetensors", false],
    ["flux1-kontext-dev-fp8.safetensors", true], ["flux1-fill-dev-Q4_K.gguf", false], ["svdq-int4_r32-flux.1-fill-dev.safetensors", false]];
  for (const [model, edit] of cases) {
    const g = build({ ...fake, ...info, UnetLoaderGGUF: fake.UnetLoaderGGUF, UNETLoader: { input: { required: { ...info.UNETLoader.input.required, unet_name: combo(SAFETENSORS) } } },
      NunchakuFluxDiTLoader: fake.NunchakuFluxDiTLoader, CLIPLoaderGGUF: fake.CLIPLoaderGGUF, VAELoader: fake.VAELoader }, model, edit);
    for (const [id, n] of Object.entries(g)) {
      const def = live2[n.class_type];
      assert.ok(def, `${model}: node ${id} class ${n.class_type} missing in ComfyUI`);
      for (const [k, spec] of Object.entries(def.input.required)) {
        assert.ok(k in n.inputs, `${model}: ${n.class_type}.${k} required but not set`);
        const v = n.inputs[k], opts = Array.isArray(spec[0]) ? spec[0] : spec[0] === "COMBO" ? spec[1].options : null;
        if (opts && !Array.isArray(v) && !FILE_INPUTS.has(k)) assert.ok(opts.includes(v), `${model}: ${n.class_type}.${k} = ${v} not in ${opts}`);
      }
      for (const [k, v] of Object.entries(n.inputs)) {
        const known = k in def.input.required || k in (def.input.optional || {});
        assert.ok(known, `${model}: ${n.class_type} has no input "${k}"`);
        if (Array.isArray(v) && live2[g[v[0]].class_type].output) {
          assert.ok(v[1] < live2[g[v[0]].class_type].output.length, `${model}: ${id}.${k} uses output ${v[1]} of ${g[v[0]].class_type}`);
        }
      }
    }
  }
  console.log("live schema check: " + cases.length + " graphs ok");
}
console.log("ok");
