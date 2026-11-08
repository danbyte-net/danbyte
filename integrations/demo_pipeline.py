"""The opt-in demo deploy pipeline: two sandboxed scripts, their script
targets, a "Router (demo)" pipeline running them in order, and a disabled
webhook target to point at a real runner later.

Never part of bootstrap or a migration. ``manage.py seed_pipeline_demo``
calls :func:`seed`. Everything is found by name, so a second run updates the
same rows: the scripts' code and parameters and the pipeline's first two
steps go back to the demo definition, while what a person switches (enabled,
extra vars, default roles, run on change, the webhook's URL and secret, steps
added after the two) is kept.
"""
from __future__ import annotations

from django.db import transaction

VNETS_SCRIPT = "Proxmox VNets (demo)"
CHECK_SCRIPT = "Config check (demo)"
VNETS_TARGET = "Proxmox VNets (demo)"
CHECK_TARGET = "Config check (demo)"
WEBHOOK_TARGET = "Demo runner (disabled)"
PIPELINE = "Router (demo)"
WEBHOOK_URL = "https://runner.example.invalid/danbyte/deploy"

DEVICE_IDS = {
    "name": "device_ids", "label": "Devices", "type": "object", "required": True,
    "default": None, "choices": [], "help": "Set by a deploy.", "object_type": "device",
}
DRY_RUN = {
    "name": "dry_run", "label": "Dry run", "type": "boolean", "required": False,
    "default": False, "choices": [], "help": "", "object_type": "",
}
VNET_PATTERN = {
    "name": "vnet_pattern", "label": "VNet name pattern", "type": "string",
    "required": False, "default": "", "choices": [],
    "help": "For cables without a VNet, e.g. c{n:04}. Blank: the Proxmox source's.",
    "object_type": "",
}

# The shared opening of both scripts: the deployed ids, from a deploy (a
# list) or the Run dialog (text).
_IDS = '''
def device_ids():
    ids = run.param("device_ids") or []
    if isinstance(ids, str):
        try:
            ids = json.loads(ids)
        except ValueError:
            ids = ids.replace(",", " ").split()
    if isinstance(ids, str):
        ids = [ids]
    return [str(i) for i in ids if i]
'''

VNETS_SOURCE = '''"""Plan the Proxmox VNets a device's cables need (demo).

For each device: read its interfaces and cables, work out each cable's VNet
(the cable's own VNet, else a name from the pattern) and log one line per
cabled interface. The sandbox cannot reach Proxmox, so the plan compares with
what Danbyte last synced from a Proxmox source (its SDN VNets and the VMs'
NIC bridges) and, without that, lists every VNet that should exist.

Writes vnet-plan.json: {vnets_to_create, nics_wrong_vnet}. Exits 1 when a
cable has no VNet and there is no pattern to name one.
"""
import json
import re
import sys

from danbyte_sdk import ApiError, db, run

VNET = re.compile(r"^[a-z][a-z0-9]{0,7}$")
''' + _IDS + '''

def proxmox_sources():
    try:
        return [s for s in db.list("virtualization-sources") if s.get("kind") == "proxmox"]
    except ApiError as exc:
        run.log(f"No Proxmox sources readable (HTTP {exc.status}).")
        return []


def synced(sources, ids):
    """VNets Danbyte synced, and the NIC bridges its network plan reports
    as wrong, by interface id."""
    vnets, wrong = set(), {}
    for src in sources:
        try:
            for vn in db.list("virt-networks", source=src["id"]):
                if vn.get("sdn_zone"):
                    vnets.add(vn.get("ext_key") or vn.get("name"))
        except ApiError:
            pass
        for did in ids:
            try:
                plan = db.request(
                    "GET", f"/api/virtualization-sources/{src['id']}/network-plan/",
                    params={"device": did},
                )
            except ApiError:
                continue
            for row in plan.get("nics_wrong_vnet") or []:
                if row.get("device", {}).get("id") == did:
                    wrong[row["interface"]["id"]] = row.get("current") or ""
    return vnets, wrong


def vnet_of(cable, pattern):
    if cable.get("pve_vnet"):
        return cable["pve_vnet"], False
    if pattern and cable.get("numid") is not None:
        try:
            name = pattern.format(n=cable["numid"])
        except (KeyError, IndexError, ValueError):
            return "", True
        return (name if VNET.match(name) else ""), True
    return "", False


def peer_of(cable, did, iface_id):
    ends = (cable.get("a_terminations") or []) + (cable.get("b_terminations") or [])
    mine = [t for t in ends if t.get("id") == iface_id]
    if not mine:
        return None
    side = "a" if mine[0] in (cable.get("a_terminations") or []) else "b"
    other = cable.get("b_terminations" if side == "a" else "a_terminations") or []
    names = [f"{(t.get('device') or {}).get('name', '?')} {t.get('name', '?')}" for t in other]
    return ", ".join(names) or "-"


ids = device_ids()
if not ids:
    run.fail("No devices given (device_ids).")
dry_run = bool(run.param("dry_run"))
if dry_run:
    run.log("dry run")

sources = proxmox_sources()
pattern = (run.param("vnet_pattern") or "").strip()
if not pattern:
    pattern = next((s.get("vnet_name_pattern") for s in sources if s.get("vnet_name_pattern")), "")
known, wrong_bridge = synced(sources, ids)
have_sync = bool(known or wrong_bridge)
if pattern:
    run.log(f"VNet name pattern: {pattern}")
run.log("Comparing with synced Proxmox data." if have_sync
        else "No synced Proxmox VNets: listing every VNet that should exist.")

to_create, wrong, problems, lines = {}, [], [], 0
for did in ids:
    device = db.get("devices", did)
    run.log(f"{device['name']}")
    ifaces = {i["id"]: i for i in db.list("interfaces", device=did)
              if (i.get("device") or {}).get("id") == did}
    cables = db.list("cables", device=did)
    for cable in sorted(cables, key=lambda c: c.get("numid") or 0):
        ends = (cable.get("a_terminations") or []) + (cable.get("b_terminations") or [])
        for t in ends:
            if t.get("kind") != "interface" or t.get("id") not in ifaces:
                continue
            iface = ifaces[t["id"]]
            peer = peer_of(cable, did, t["id"])
            vnet, from_pattern = vnet_of(cable, pattern)
            label = cable.get("label") or f"cable {cable.get('numid')}"
            lines += 1
            if not vnet:
                problems.append(f"{device['name']} {iface['name']}: {label} has no VNet")
                run.log(f"  {iface['name']} -> {peer}  -  no VNet")
                continue
            if vnet in known:
                state = "ok"
            else:
                state = "missing"
                entry = to_create.setdefault(vnet, {
                    "name": vnet, "suggested": from_pattern, "cables": [],
                })
                if label not in entry["cables"]:
                    entry["cables"].append(label)
            if t["id"] in wrong_bridge and wrong_bridge[t["id"]] != vnet:
                state += f", NIC on {wrong_bridge[t['id']] or 'no bridge'}"
                wrong.append({
                    "device": device["name"], "interface": iface["name"], "cable": label,
                    "current": wrong_bridge[t["id"]], "wanted": vnet,
                })
            run.log(f"  {iface['name']} -> {peer}  {vnet}  {state}")

plan = {
    "dry_run": dry_run,
    "synced": have_sync,
    "vnets_to_create": [to_create[k] for k in sorted(to_create)],
    "nics_wrong_vnet": wrong,
}
run.output_json("vnet-plan.json", plan)
run.log(f"{lines} cabled interfaces, {len(to_create)} VNets to create, "
        f"{len(wrong)} NICs on the wrong VNet.")
if problems:
    for p in problems:
        run.log(f"FAILED: {p} and no name pattern is set.")
    sys.exit(1)
'''

CHECK_SOURCE = '''"""Check that each device has what a config push needs (demo).

Logs the earlier pipeline steps, then for each device checks the primary IP,
platform and role and renders its bound config template when it has one.
Fails with one line per device that is not ready.
"""
import json

from danbyte_sdk import ApiError, db, run
''' + _IDS + '''

steps = run.param("steps") or []
for s in steps:
    files = ", ".join(o.get("name", "") for o in s.get("outputs") or []) or "no files"
    run.log(f"Step {s.get('step')} {s.get('target')}: {s.get('status')} ({files})")
    for o in s.get("outputs") or []:
        if o.get("name") == "vnet-plan.json" and o.get("url"):
            try:
                plan = db.request("GET", o["url"])
                run.log(f"  vnet-plan.json: {len(plan.get('vnets_to_create') or [])} to create, "
                        f"{len(plan.get('nics_wrong_vnet') or [])} wrong")
            except (ApiError, ValueError, AttributeError) as exc:
                run.log(f"  vnet-plan.json not readable: {exc}")
if run.param("dry_run"):
    run.log("dry run")

ids = device_ids()
if not ids:
    run.fail("No devices given (device_ids).")
failed = []
for did in ids:
    d = db.get("devices", did)
    missing = [label for key, label in
               (("primary_ip", "primary IP"), ("platform", "platform"), ("role", "role"))
               if not d.get(key)]
    if missing:
        failed.append(f"{d['name']}: no {', '.join(missing)}")
        run.log(f"{d['name']}  missing {', '.join(missing)}")
        continue
    try:
        r = db.request("GET", f"/api/devices/{did}/render/")
    except ApiError as exc:
        detail = exc.detail.get("detail") if isinstance(exc.detail, dict) else exc.detail
        if exc.status == 400 and str(detail) == "Unknown template.":
            run.log(f"{d['name']}  ok (no config template bound, render skipped)")
            continue
        failed.append(f"{d['name']}: the config does not render: {detail}")
        run.log(f"{d['name']}  render failed: {detail}")
        continue
    files = r.get("files") if isinstance(r, dict) and "files" in r else {"": r}
    for path, row in (files or {}).items():
        text = (row or {}).get("output") or ""
        name = path or (row or {}).get("path") or (row or {}).get("template") or "config"
        run.log(f"{d['name']}  ok ({name}: {len(text.splitlines())} lines)")

if failed:
    run.fail("Not ready: " + "; ".join(failed))
run.log(f"{len(ids)} device(s) ready.")
'''

SCRIPTS = {
    VNETS_SCRIPT: {
        "description": "Demo: plans the Proxmox VNets a device's cables need and "
                       "writes vnet-plan.json.",
        "source": VNETS_SOURCE,
        "params_schema": [DEVICE_IDS, DRY_RUN, VNET_PATTERN],
    },
    CHECK_SCRIPT: {
        "description": "Demo: checks primary IP, platform and role, and renders the "
                       "bound config.",
        "source": CHECK_SOURCE,
        "params_schema": [DEVICE_IDS, DRY_RUN],
    },
}


def _script(tenant, name, owner):
    from scripting.models import Script

    spec = SCRIPTS[name]
    code = {
        "description": spec["description"], "source": spec["source"],
        "params_schema": spec["params_schema"], "language": "python",
        # Sandboxed, read only, as whoever deploys.
        "trusted": False, "token_scope": "read", "run_as": "caller",
    }
    script = Script.objects.filter(tenant=tenant, name=name).first()
    if script is None:
        return Script.objects.create(
            tenant=tenant, name=name, owner=owner, visibility="global",
            timeout_seconds=120, enabled=True, **code,
        ), True
    for k, v in code.items():
        setattr(script, k, v)
    script.save()
    return script, False


def _target(tenant, name, **fields):
    from .models import AutomationTarget

    t = AutomationTarget.objects.filter(tenant=tenant, name=name).first()
    if t is None:
        return AutomationTarget.objects.create(tenant=tenant, name=name, **fields), True
    changed = [k for k, v in fields.items() if k in ("kind", "script") and getattr(t, k) != v]
    for k in changed:
        setattr(t, k, fields[k])
    if changed:
        t.save()
    return t, False


@transaction.atomic
def seed(tenant, owner=None) -> dict:
    """Make (or bring back to the demo definition) the demo pipeline in
    ``tenant``. Answers ``{pipeline, scripts, targets, created}``."""
    from .models import DeployPipeline, DeployPipelineStep

    created = 0
    vnets, made = _script(tenant, VNETS_SCRIPT, owner)
    created += made
    check, made = _script(tenant, CHECK_SCRIPT, owner)
    created += made
    t_vnets, made = _target(tenant, VNETS_TARGET, kind="script", script=vnets,
                            object_types=["device"], extra_vars={})
    created += made
    t_check, made = _target(tenant, CHECK_TARGET, kind="script", script=check,
                            object_types=["device"], extra_vars={})
    created += made
    # Left disabled and out of the pipeline: a disabled target fails its step.
    _, made = _target(tenant, WEBHOOK_TARGET, kind="webhook", enabled=False,
                      base_url=WEBHOOK_URL, object_types=["device"], extra_vars={})
    created += made

    pipeline = DeployPipeline.objects.filter(tenant=tenant, name=PIPELINE).first()
    if pipeline is None:
        pipeline = DeployPipeline.objects.create(
            tenant=tenant, name=PIPELINE, object_types=["device"], enabled=True,
            auto_on_change=False,
            description="Demo: plan the VNets from the cables, then check the config.",
        )
        created += 1
    elif pipeline.object_types != ["device"]:
        pipeline.object_types = ["device"]
        pipeline.save()
    steps = list(pipeline.steps.order_by("order", "created_at"))
    for i, target in enumerate((t_vnets, t_check), start=1):
        row = steps[i - 1] if i <= len(steps) else None
        fields = {"order": i, "target": target, "stop_on_failure": True,
                  "wait_for_result": False}
        if row is None:
            DeployPipelineStep.objects.create(pipeline=pipeline, **fields)
            created += 1
        elif any(getattr(row, k) != v for k, v in fields.items()):
            for k, v in fields.items():
                setattr(row, k, v)
            row.save()
    return {
        "pipeline": pipeline,
        "scripts": [vnets, check],
        "targets": [t_vnets, t_check],
        "created": created,
    }
