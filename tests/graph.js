// Helper for test_workflow.py: stdin = buildGraph opts (JSON), stdout = ComfyUI API graph, built by plugin/models.js
const fs = require("fs");
const path = require("path");
const M = require("../plugin/models.js");

const opts = JSON.parse(fs.readFileSync(0, "utf8"));
const info = JSON.parse(fs.readFileSync(path.join(__dirname, "tmp/object_info.json"), "utf8"));
const templates = Object.fromEntries(M.TEMPLATES.map((t) =>
  [t, JSON.parse(fs.readFileSync(path.join(__dirname, "../plugin/workflows", t + ".json"), "utf8"))]));
process.stdout.write(JSON.stringify(M.buildGraph(info, templates, opts)));
