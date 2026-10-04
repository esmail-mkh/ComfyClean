"""Repro: a logo that straddles artwork/white (book icon stayed behind). Runs the plugin's graph as is ("base"),
and with the reference image pre-filled under the mask ("fill:neutral|telea"), on the same crop + mask.
Usage: python tests/repro_logo.py IMAGE [--model NAME] [--variants base,telea,neutral] [--box L,T,R,B] [--seeds N]"""
import json, sys, time
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

sys.argv_backup = sys.argv[:]
img_path = sys.argv[1]
arg = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
sys.argv = [sys.argv[0]] + (["--model", arg("--model", "flux-2-klein-9b-Q4_K_S.gguf")])
import test_workflow as T  # same helpers as the live workflow test

variants = arg("--variants", "base,telea").split(",") if "--variants" in sys.argv_backup else ["base", "telea"]
variants = sys.argv_backup[sys.argv_backup.index("--variants") + 1].split(",") if "--variants" in sys.argv_backup else variants
box = tuple(int(v) for v in (sys.argv_backup[sys.argv_backup.index("--box") + 1] if "--box" in sys.argv_backup else "355,185,795,335").split(","))
seeds = int(sys.argv_backup[sys.argv_backup.index("--seeds") + 1]) if "--seeds" in sys.argv_backup else 1
PROMPT = open(Path(__file__).parent / "tmp/prompt.txt").read().strip() if (Path(__file__).parent / "tmp/prompt.txt").exists() else \
    "Remove the entire watermark completely: every letter, logo, icon, outline, shadow and semi-transparent overlay, plus any box, frame or plate it sits on. Leave no faint trace, ghost, blur or smudge. Restore the artwork behind it exactly as if the watermark was never there, continuing every line, edge, color, gradient, texture and screentone from the surroundings. Do not change anything else."

src = Image.open(img_path).convert("RGB")
mask = Image.new("L", src.size, 0)
ImageDraw.Draw(mask).rectangle(box, fill=255)


def patch(wf, kind):
    """kind 'base' = untouched. else: fill the masked area of the page before it is encoded as the reference."""
    if kind == "base":
        return wf
    fill = kind.split("+")[0]
    wf["30"] = {"class_type": "MaskToImage", "inputs": {"mask": ["20", 0]}}
    wf["31"] = {"class_type": "ImageScale", "inputs": {"image": ["30", 0], "upscale_method": "bilinear", "width": ["6", 0], "height": ["6", 1], "crop": "disabled"}}
    wf["32"] = {"class_type": "ImageToMask", "inputs": {"image": ["31", 0], "channel": "red"}}
    wf["33"] = {"class_type": "INPAINT_MaskedFill", "inputs": {"image": ["5", 0], "mask": ["32", 0], "fill": fill, "falloff": 0}}
    wf["9"]["inputs"]["pixels"] = ["33", 0]
    return wf


def run(kind):
    wf = T.build_graph(edit=False, prompt=PROMPT, image=T.upload(src, "r_src.jpg"), mask=T.upload(mask, "r_mask.jpg"))
    wf = patch(wf, kind)
    req = T.urllib.request.Request(T.URL + "/prompt", json.dumps({"prompt": wf}).encode(), {"Content-Type": "application/json"})
    try:
        pid = json.load(T.urllib.request.urlopen(req))["prompt_id"]
    except T.urllib.error.HTTPError as e:
        sys.exit(e.read().decode())
    while (h := json.load(T.urllib.request.urlopen(f"{T.URL}/history/{pid}"))).get(pid) is None:
        time.sleep(1)
    assert h[pid]["status"]["status_str"] == "success", h[pid]["status"]
    im = next(o["images"][0] for o in h[pid]["outputs"].values() if o.get("images"))
    data = T.urllib.request.urlopen(f"{T.URL}/view?{T.urllib.parse.urlencode(im)}").read()
    (T.TMP / "output.png").write_bytes(data)
    out = Image.open(T.TMP / "output.png").convert("RGB").resize(src.size, Image.LANCZOS)
    return Image.composite(out, src, mask)


tiles = [src]
for k in variants:
    for s in range(seeds):
        t = time.time()
        tiles.append(run(k))
        print(k, f"{time.time() - t:.1f}s")
sheet = Image.new("RGB", (src.width * 2, src.height * ((len(tiles) + 1) // 2)), "white")
for i, im in enumerate(tiles):
    sheet.paste(im, ((i % 2) * src.width, (i // 2) * src.height))
sheet.save(T.TMP / f"logo_{'_'.join(variants)}.webp", "WEBP", quality=80)
print("saved", T.TMP / f"logo_{'_'.join(variants)}.webp")
