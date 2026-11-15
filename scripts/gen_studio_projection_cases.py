"""Write frontend/src/lib/studio-projection.cases.json from api.model_projection.

    .venv/bin/python manage.py shell -c "exec(open('scripts/gen_studio_projection_cases.py').read())"

Run it after changing studio-projection.json or the projection; both test
suites (lib/model-studio.test.ts, api/tests_model_pack_renders.py) read the
cases. Format the output after: npx prettier --write (from frontend/)."""
import json
from pathlib import Path

from django.conf import settings

from api import model_projection as mp

frame = {"w": 0.4826, "h": 0.04445}
index = {
    "Te1/0/1": ["interface", "25gbase-x-sfp28"],
    "Te1/0/2": ["interface", "25gbase-x-sfp28"],
    "Hu1/0/49": ["interface", "100gbase-x-qsfp28"],
    "Gi0/0": ["interface", "1000base-t"],
    "con 0": ["console-port", "rj-45"],
    "usb": ["console-port", "usb-mini-b"],
    "PS-0": ["power-port", "iec-60320-c16"],
}
F, R = [0, 0, -1], [0, 0, 1]
anchors = [
    {"name": "Te1/0/1", "p": [0.2, 0.03, -0.25], "n": F},
    {"name": "Te1/0/2", "p": [0.18, 0.012, -0.25], "n": [0, 0.3, -0.95]},
    {"name": "Hu1/0/49", "p": [-0.15, 0.022, -0.25], "n": F},
    {"name": "Te1/0/1", "p": [0.0, 0.0, -0.25], "n": F},
    {"name": "Gi0/0", "p": [0.1, 0.02, 0.25], "n": R},
    {"name": "con 0", "p": [-0.05, 0.02, 0.25], "n": R},
    {"name": "usb", "p": [-0.02, 0.02, 0.0], "n": [0, 1, 0]},
    {"name": "PS-0", "p": [0.17, 0.022, 0.25], "n": [0, 0, 2]},
    {"name": "Te1/1/1", "p": [0.3, 0.02, -0.25], "n": F},
    {"name": "Mystery", "p": [-0.21, 0.04, -0.25], "n": F},
    {"name": "", "p": [0, 0, 0], "n": F},
    {"name": "Te1/0/3", "p": [0.16, 0.03, -0.25], "n": F, "w": 0.0137, "h": 0.0088},
    {"name": "Te1/0/4", "p": [0.14, 0.03, -0.25], "n": F, "w": 0, "h": 0.0088},
]
ports = [{
    "frame": frame, "index": index, "anchors": anchors,
    "expected": mp.image_ports_from_anchors(anchors, index, frame),
}]
half = {"w": 0.2413, "h": 0.0889}
ports.append({
    "frame": half, "index": {}, "anchors": anchors[:3],
    "expected": mp.image_ports_from_anchors(anchors[:3], {}, half),
})

boxes = [
    {"id": "SYS", "min": [0.209, 0.029, -0.2505], "max": [0.211, 0.031, -0.2495]},
    {"id": "port:Te1/0/1", "min": [0.199, 0.034, -0.2505], "max": [0.201, 0.036, -0.2495]},
    {"id": "STATUS", "bay": "PS-0", "min": [0.16, 0.02, 0.249], "max": [0.162, 0.022, 0.251]},
    {"id": "STATUS", "bay": "PS-1", "min": [-0.162, 0.02, 0.249], "max": [-0.16, 0.022, 0.251]},
    {"id": "SYS", "min": [0, 0, 0], "max": [0, 0, 0]},
    {"id": "INSIDE", "min": [0, 0.02, -0.01], "max": [0.002, 0.022, 0.01]},
    {"id": "TINY", "min": [0.0, 0.01, -0.25], "max": [0.0, 0.01, -0.25]},
    {"id": "OUT", "min": [0.4, 0.01, -0.25], "max": [0.41, 0.012, -0.25]},
]
sources = {"|SYS": "device.status", "|port:Te1/0/1": "interface.oper_status",
           "PS-0|STATUS": "module.status"}


def run_leds(bx, src, fr, depth):
    py = {k.replace("|", "\u0000"): v for k, v in src.items()}
    return mp.image_leds_from_boxes(bx, py, fr, depth)


leds = [{"frame": frame, "depth": 0.5, "boxes": boxes, "sources": sources,
         "expected": run_leds(boxes, sources, frame, 0.5)},
        {"frame": frame, "depth": 0.1, "boxes": boxes[:3], "sources": {},
         "expected": run_leds(boxes[:3], {}, frame, 0.1)}]

types = [
    ("interface", "25gbase-x-sfp28"), ("interface", "10gbase-x-sfpp"),
    ("interface", "100gbase-x-qsfp28"), ("interface", "400gbase-x-qsfpdd"),
    ("interface", "400gbase-x-osfp"), ("interface", "100gbase-x-cfp"),
    ("interface", "1000base-t"), ("interface", "10gbase-t"), ("interface", "100base-tx"),
    ("interface", "1000base-x-gbic"), ("interface", "other"), ("interface", ""),
    ("console-port", "usb-mini-b"), ("console-port", "usb-c"), ("console-port", "rj-45"),
    ("console-port", "de-9"), ("console-port", ""), ("console-server-port", ""),
    ("power-port", "iec-60320-c14"), ("power-port", "iec-60320-c20"),
    ("power-port", "nema-5-15p"), ("power-outlet", ""), ("front-port", "lc"),
    ("front-port", "mpo"), ("rear-port", ""), ("front-port", "bnc"),
    ("interface", "Te-SFP+"), ("aux-port", "8p8c"),
]
kinds = [[k, t, mp.port_box_kind(k, t)] for k, t in types]

fits = []
for box, up, front, fit, target in (
    ([[-0.2413, 0, -0.45], [0.2413, 0.044, 0.0]], "y", "+z", "auto",
     {"w": 0.4826, "h": 0.04445}),
    ([[-0.2413, 0, 0], [0.2413, 0.044, 0.45]], "y", "-z", "auto", {"d": 0.4}),
    ([[-0.1, -0.2, 0], [0.1, 0.0, 0.05]], "z", "+x", "native", {"w": 1}),
    ([[-0.1, -0.2, 0], [0.1, 0.0, 0.05]], "z", "-x", "auto", None),
):
    f = mp.Fit(box, up, front, fit, target)
    points = [[0.2, 0.03, -0.01], [-0.1, 0.01, -0.4], [0.0, 0.0, 0.0]]
    dirs = [[0, 1, 0], [0, 0, 1], [1, 0, 0]]
    fits.append({
        "box": box, "up": up, "front": front, "fit": fit, "target": target,
        "points": points, "expected_points": [f.point(p) for p in points],
        "dirs": dirs, "expected_dirs": [f.direction(d) for d in dirs],
    })

out = {
    "_comment": "Cases both test suites run: frontend lib/model-studio.test.ts and "
                "api/tests_model_pack_renders.py. Expected values came from "
                "api.model_projection; regenerate when the table changes.",
    "ports": ports, "leds": leds, "port_box_kind": kinds, "fit": fits,
}
path = Path(settings.BASE_DIR) / "frontend/src/lib/studio-projection.cases.json"
path.write_text(json.dumps(out, indent=1) + "\n")
print("wrote", path)
