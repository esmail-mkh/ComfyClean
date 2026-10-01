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
  INPAINT_ColorMatch: { input: { required: {} } }, // comfyui-inpaint-nodes (required by Clean)
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

// color match: comfyui-inpaint-nodes' masked match, required for Clean; 0 = off (runs without the pack)
g = build(fake, "flux-2-klein-9b-Q4_K_S.gguf", false, { colorMatch: 0.7 });
assert.deepStrictEqual(g["23"], { class_type: "INPAINT_ColorMatch", inputs: { target: ["18", 0], reference: ["5", 0], exclude_mask: ["20", 0], strength: 0.7 } });
checkLinks(g, "masked color match");
const noCM = Object.fromEntries(Object.entries(fake).filter(([c]) => c !== "INPAINT_ColorMatch"));
assert.throws(() => build(noCM, "flux-2-klein-9b-Q4_K_S.gguf", false, { colorMatch: 0.5 }), /comfyui-inpaint-nodes/);
g = build(noCM, "flux-2-klein-9b-Q4_K_S.gguf", false, { colorMatch: 0 });
assert.ok(!g["23"]);
assert.deepStrictEqual(g["19"].inputs.images, ["18", 0]);
assert.ok(build(noCM, "flux-2-klein-9b-Q4_K_S.gguf", true), "Edit has no color match, runs without the pack");

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

// custom nodes the user is told to install
{
  const names = (needs) => needs.map((m) => m.name);
  const without = (info, ...cls) => Object.fromEntries(Object.entries(info).filter(([c]) => !cls.includes(c)));
  assert.deepStrictEqual(names(M.missingNodes(fake, ["flux-2-klein-9b-Q4_K_S.gguf"], [])), [], "all there");
  assert.deepStrictEqual(names(M.missingNodes(without(fake, "UnetLoaderGGUF", "CLIPLoaderGGUF"), ["flux-2-klein-9b-Q4_K_S.gguf"], [])),
    ["ComfyUI-GGUF"], ".gguf on disk, no GGUF loader");
  assert.ok(M.missingNodes(without(fake, "UnetLoaderGGUF", "CLIPLoaderGGUF"), ["x.gguf"], [])[0].required);
  const bare = { VAELoader: fake.VAELoader, CLIPLoader: { input: { required: { clip_name: [[]] } } }, UNETLoader: { input: { required: { unet_name: [[]] } } } };
  assert.deepStrictEqual(names(M.missingNodes(bare, [], [])), ["ComfyUI-GGUF", "comfyui-inpaint-nodes"], "no usable model at all: point at GGUF");
  assert.deepStrictEqual(names(M.missingNodes(without(fake, "NunchakuFluxDiTLoader"), ["svdq-int4_r32-flux.1-kontext-dev.safetensors"], [])),
    ["ComfyUI-nunchaku"], "svdq file, no Nunchaku loader");
  const needs = M.missingNodes(fake, [], ["ReferenceLatent", "ReferenceLatent", "INPAINT_ColorMatch"]); // fake has no core nodes
  assert.deepStrictEqual(names(needs), ["Update ComfyUI"]);
  assert.ok(/missing ReferenceLatent\)$/.test(needs[0].why), "missing core nodes named once; INPAINT_* is the pack, not core");
  const noPack = M.missingNodes(without(fake, "INPAINT_ColorMatch"), [], []);
  assert.deepStrictEqual(names(noPack), ["comfyui-inpaint-nodes"], "inpaint nodes: required even while ComfyUI is off");
  assert.ok(noPack[0].required);
  assert.ok(M.diskInfo({ unet: [], enc: [], vae: [] }, ["comfyui-inpaint-nodes"]).INPAINT_ColorMatch, "disk scan sees the pack folder");
  if (fs.existsSync(live)) { // the real ComfyUI here has everything the templates need
    const info = JSON.parse(fs.readFileSync(live, "utf8"));
    const core = Object.values(templates).flatMap((g) => Object.entries(g).filter(([id]) => !["1", "2", "3"].includes(id)).map(([, n]) => n.class_type));
    assert.deepStrictEqual(names(M.missingNodes(info, ["flux-2-klein-9b-Q4_K_S.gguf"], core)), [], "live ComfyUI: nothing to install");
  }
}

// text encoder / VAE downloads the selected model still needs
{
  const files = (info, sel) => M.missingFiles(info, { clip: M.AUTO, vae: M.AUTO, ...sel }).map((f) => f.name);
  const withLists = (enc, vae) => ({ ...fake, CLIPLoaderGGUF: { input: { required: { clip_name: [enc] } } }, VAELoader: { input: { required: { vae_name: [vae] } } } });
  assert.deepStrictEqual(files(fake, { model: "flux-2-klein-9b-Q4_K_S.gguf" }), [], "all there");
  const only4b = withLists(["Qwen3-4B-Q5_K_M.gguf"], ["flux2-vae.safetensors"]);
  assert.deepStrictEqual(files(only4b, { model: "flux-2-klein-9b-Q4_K_S.gguf" }), ["Qwen3-8B-Q4_K_M.gguf"], "9B never borrows the 4B encoder; GGUF installed: Q4_K_M");
  // without ComfyUI-GGUF a .gguf encoder can't load: the safetensors one instead
  const noGguf = { ...Object.fromEntries(Object.entries(only4b).filter(([c]) => !/GGUF/.test(c))), CLIPLoader: { input: { required: { clip_name: [["Qwen3-4B-Q5_K_M.gguf"]] } } } };
  noGguf.UNETLoader = { input: { required: { unet_name: [["flux-2-klein-9b-fp8.safetensors"]] } } };
  assert.deepStrictEqual(files(noGguf, { model: "flux-2-klein-9b-fp8.safetensors" }), ["qwen_3_8b_fp8mixed.safetensors"], "no GGUF: safetensors");
  assert.throws(() => M.resolve(only4b, { model: "flux-2-klein-9b-Q4_K_S.gguf", clip: M.AUTO, vae: M.AUTO }), /Qwen3-8B.*Settings/);
  assert.deepStrictEqual(files(only4b, { model: "flux-2-klein-4b-Q5_K_M.gguf" }), [], "4B has its encoder");
  assert.deepStrictEqual(files(only4b, { model: "flux-2-klein-9b-Q4_K_S.gguf", clip: "Qwen3-4B-Q5_K_M.gguf" }), [], "picked by hand: trusted");
  assert.deepStrictEqual(files(withLists(["Qwen3-8B-Q4_K_M.gguf"], ["ae.safetensors"]), { model: "flux-2-klein-9b-Q4_K_S.gguf" }), ["flux2-vae.safetensors"]);
  assert.deepStrictEqual(files(withLists([], []), { model: "flux1-kontext-dev-fp8.safetensors" }),
    ["t5-v1_1-xxl-encoder-Q4_K_M.gguf", "clip_l.safetensors", "ae.safetensors"], "Flux.1 needs T5 (Q4_K_M GGUF), clip_l, ae");
  assert.ok(M.missingFiles(withLists([], []), { model: "flux1-fill-dev-Q4_K.gguf", clip: M.AUTO, vae: M.AUTO }).every((f) => /^https:\/\/huggingface\.co\//.test(f.url) && f.folder));
}

// disk scan (ComfyUI off): a real portable install's files -> same lists and auto picks as the live loaders
{
  const files = {
    unet: ["Flux2-Klein-9B-True-V3-Q4_K.gguf", "flux-2-klein-4b-Q5_K_M.gguf", "flux-2-klein-9b-Q4_K_S.gguf", "qwen-image-2.1-Q4_K_M.gguf"],
    enc: ["Qwen3-4B-Q5_K_M.gguf", "Qwen3-8B-Q4_K_M.gguf", "clip_g.safetensors", "clip_l.safetensors", "qwen3vl_8b_w4a8_heretic.safetensors", "t5-v1_1-xxl-encoder-Q5_K_S.gguf"],
    vae: ["Qwen_Image-VAE.safetensors", "ae.safetensors", "flux2-vae.safetensors"],
  };
  const info = M.diskInfo(files, ["ComfyUI-GGUF", "comfyui-manager"]);
  assert.deepStrictEqual(M.listModels(info).map((m) => m.name), files.unet.slice(0, 3));
  const r = M.resolve(info, { model: "flux-2-klein-9b-Q4_K_S.gguf", clip: M.AUTO, vae: M.AUTO });
  assert.strictEqual(r.enc.main, "Qwen3-8B-Q4_K_M.gguf");
  assert.strictEqual(r.vae, "flux2-vae.safetensors");
  assert.strictEqual(M.listModels(M.diskInfo(files, [])).length, 0, "GGUF files need ComfyUI-GGUF");
}
console.log("ok");
