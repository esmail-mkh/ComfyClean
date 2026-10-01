"""Runs plugin/workflow.json against a live ComfyUI the same way the plugin does:
crop + selection mask in, result composited back through the mask, then checks the
cleaned area matches the known clean background (no darker/lighter patch).
Usage: python tests/test_workflow.py [--edit]  (ComfyUI must be running on 127.0.0.1:8188)"""
import json, random, sys, time, urllib.parse, urllib.request, uuid
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

URL = "http://127.0.0.1:8188"
ROOT = Path(__file__).parent
TMP = ROOT / "tmp"
TMP.mkdir(exist_ok=True)


def make_scene():
    """Clean background (ground truth), same with text on top, and a selection mask around the text."""
    W, H = 700, 500
    y, x = np.mgrid[0:H, 0:W]
    base = np.stack([60 + 120 * x / W, 80 + 100 * y / H, 170 - 60 * x / W], -1)
    base += np.random.default_rng(1).normal(0, 6, base.shape)  # screentone-ish grain
    gt = Image.fromarray(base.clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    src = gt.copy()
    d = ImageDraw.Draw(src)
    font = ImageFont.truetype("arialbd.ttf", 70)
    box = d.textbbox((150, 190), "KRAAASH!", font=font, stroke_width=5)
    d.text((150, 190), "KRAAASH!", fill="white", font=font, stroke_width=5, stroke_fill="black")
    mask = Image.new("L", src.size, 0)
    ImageDraw.Draw(mask).rectangle([box[0] - 6, box[1] - 6, box[2] + 6, box[3] + 6], fill=255)
    return gt, src, mask


def upload(img, name):
    p = TMP / name
    img.convert("RGB").save(p, quality=95)
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\ntemp\r\n"
            f"--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n"
            f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            "Content-Type: image/jpeg\r\n\r\n").encode() + p.read_bytes() + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(URL + "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    return json.load(urllib.request.urlopen(req))["name"] + " [temp]"  # same as the plugin: ComfyUI temp/, not input/


def to_edit_graph(wf):
    """Mirror of toEditGraph() in plugin/index.js."""
    for n in ("20", "21", "22", "23"):
        del wf[n]
    wf["16"] = {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": ["6", 0], "height": ["6", 1], "batch_size": 1}}
    wf["17"]["inputs"]["latent_image"] = ["16", 0]
    wf["19"]["inputs"]["images"] = ["18", 0]


def run(src, mask, prompt_text):
    wf = json.loads((ROOT.parent / "plugin" / "workflow.json").read_text())
    wf["4"]["inputs"]["image"] = upload(src, "t_src.jpg")
    if mask is None:
        to_edit_graph(wf)
    else:
        wf["20"]["inputs"]["image"] = upload(mask, "t_mask.jpg")
    wf["7"]["inputs"]["text"] = prompt_text
    wf["15"]["inputs"]["noise_seed"] = random.randint(0, 2**31)
    req = urllib.request.Request(URL + "/prompt", json.dumps({"prompt": wf}).encode(), {"Content-Type": "application/json"})
    try:
        pid = json.load(urllib.request.urlopen(req))["prompt_id"]
    except urllib.error.HTTPError as e:
        sys.exit(e.read().decode())
    while (h := json.load(urllib.request.urlopen(f"{URL}/history/{pid}"))).get(pid) is None:
        time.sleep(1)
    assert h[pid]["status"]["status_str"] == "success", h[pid]["status"]
    img = next(o["images"][0] for o in h[pid]["outputs"].values() if o.get("images"))
    data = urllib.request.urlopen(f"{URL}/view?{urllib.parse.urlencode(img)}").read()
    (TMP / "output.png").write_bytes(data)
    return Image.open(TMP / "output.png").convert("RGB")


def test_edit(src):
    t = time.time()
    out = run(src, None, "make the whole image black and white")
    sat = np.asarray(out.convert("HSV"))[..., 1].mean()
    out.convert("RGB").save(TMP / "edit.webp", "WEBP", quality=80)
    print(f"edit {time.time() - t:.1f}s  saturation {sat:.0f}")
    assert sat < 40, "edit mode didn't apply the prompt"


if __name__ == "__main__":
    gt, src, mask = make_scene()
    if "--edit" in sys.argv:
        test_edit(src)
        sys.exit(print("ok"))
    t = time.time()
    out = run(src, mask, "remove the sound effect lettering, restore the background art behind it")
    out = out.resize(src.size, Image.LANCZOS)  # plugin scales the layer back to the crop size
    final = Image.composite(out, src, mask)    # plugin applies the selection as a layer mask

    m = np.array(mask) > 0
    diff = np.asarray(final, float)[m] - np.asarray(gt, float)[m]
    bias, mae = diff.mean(), np.abs(diff).mean()
    print(f"{time.time() - t:.1f}s  brightness bias {bias:+.1f}  MAE {mae:.1f}  (0-255 scale)")

    sheet = Image.new("RGB", (src.width * 3, src.height))
    for i, im in enumerate((src, final, gt)):
        sheet.paste(im, (i * src.width, 0))
    sheet.save(TMP / "compare.webp", "WEBP", quality=80)

    assert abs(bias) < 8, "cleaned patch is visibly darker/lighter than the background"
    assert mae < 25, "cleaned patch doesn't match the background"
    print("ok")
