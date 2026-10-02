// node tests/test_selection.js -- readSelection (plugin/index.js) places a partial getSelection result at the right spot
const src = require("fs").readFileSync(__dirname + "/../plugin/index.js", "utf8");
const start = src.indexOf("async function readSelection");
const fn = src.slice(start).match(/^[^]*?\r?\n\}\r?\n/)[0]; // up to the function's closing brace (file may be CRLF)
const rect = { left: 0, top: 10, right: 6, bottom: 14 }; // 6x4
const fakeImaging = (bounds, data) => ({ getSelection: async () => ({ sourceBounds: bounds,
  imageData: { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top, getData: async () => data, dispose() {} } }) });
const assert = require("assert");
(async () => {
  let imaging = fakeImaging({ left: 2, top: 11, right: 4, bottom: 13 }, Uint8Array.from([1, 2, 3, 4])); // 2x2 part
  let readSelection = eval("(" + fn.replace("async function readSelection", "async function") + ")");
  assert.deepStrictEqual([...await readSelection(1, rect)], [0,0,0,0,0,0, 0,0,1,2,0,0, 0,0,3,4,0,0, 0,0,0,0,0,0]);
  imaging = fakeImaging(rect, Uint8Array.from({ length: 24 }, (_, i) => i)); // whole rect
  readSelection = eval("(" + fn.replace("async function readSelection", "async function") + ")");
  assert.deepStrictEqual([...await readSelection(1, rect)], Array.from({ length: 24 }, (_, i) => i));
  console.log("readSelection ok");
})();
