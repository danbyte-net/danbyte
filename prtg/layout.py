"""PRTG group trees built from Danbyte's regions, sites, locations and roles.

With a group layout on the connection, a device goes under a chain of groups
Danbyte keeps in step, built under the layout root (a probe or group; the
registration group when none is picked):

* ``sites`` - root › region (the region chain, optional) › site › location
  (the location chain, optional) › device
* ``roles`` - root › role (e.g. *Core switches*) › device
* ``sites_roles`` - root › … › site › location › role › device

A link in the chain the object does not have is left out: a device without a
site sits under the root in a site layout; one without a role under its site
in ``sites_roles``.

Each group Danbyte makes carries ``danbyte`` and ``danbyte-group-<kind>-
<uuid>`` tags. A group is found by that tag under the expected parent first,
then by its exact name there - an operator's own *Core switches* group is
reused, never duplicated and never renamed or removed.

Nothing here writes to PRTG: the planning pass proposes ``create_group`` rows
(:mod:`prtg.provision`), applying them writes (:mod:`prtg.writer`).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

GROUP_TAG = "danbyte-group-"
#: How deep a region or location chain may go before it is cut.
MAX_DEPTH = 16


@dataclass(frozen=True)
class Node:
    kind: str
    object_id: str
    name: str

    @property
    def tag(self) -> str:
        return f"{GROUP_TAG}{self.kind}-{self.object_id}"


class Tree:
    """The tenant's regions, sites, locations and roles, read once per pass."""

    def __init__(self, tenant):
        from api.models import DeviceRole, Location, Region, Site

        self.regions = {
            r["id"]: r for r in Region.objects.filter(tenant=tenant)
            .values("id", "name", "parent_id")
        }
        self.sites = {
            s["id"]: s for s in Site.objects.filter(tenant=tenant)
            .values("id", "name", "region_id")
        }
        self.locations = {
            loc["id"]: loc for loc in Location.objects.filter(tenant=tenant)
            .values("id", "name", "parent_id", "site_id")
        }
        self.roles = {
            r["id"]: r for r in DeviceRole.objects.filter(tenant=tenant).values("id", "name")
        }

    def _up(self, table: dict, start) -> list[dict]:
        out, seen, current = [], set(), start
        while current and current in table and current not in seen and len(out) < MAX_DEPTH:
            seen.add(current)
            out.append(table[current])
            current = table[current].get("parent_id")
        return list(reversed(out))

    def region_chain(self, region_id) -> list[Node]:
        return [Node("region", str(r["id"]), r["name"])
                for r in self._up(self.regions, region_id)]

    def location_chain(self, location_id) -> list[Node]:
        return [Node("location", str(loc["id"]), loc["name"])
                for loc in self._up(self.locations, location_id)]


def _site_and_location(obj):
    from .provision import _is_vm, vm_site_id

    if _is_vm(obj):
        host = obj.device if getattr(obj, "device_id", None) else None
        return vm_site_id(obj), (host.location_id if host is not None else None)
    return obj.site_id, obj.location_id


def chain(conn, obj, tree: Tree, *, layout: str | None = None,
          regions: bool | None = None, locations: bool | None = None) -> list[Node]:
    """The groups between the layout root and the object, top-down."""
    layout = layout or conn.group_layout
    regions = conn.layout_regions if regions is None else regions
    locations = conn.layout_locations if locations is None else locations
    nodes: list[Node] = []
    if layout in ("sites", "sites_roles"):
        site_id, location_id = _site_and_location(obj)
        site = tree.sites.get(site_id) if site_id else None
        if site is not None:
            if regions and site.get("region_id"):
                nodes.extend(tree.region_chain(site["region_id"]))
            nodes.append(Node("site", str(site["id"]), site["name"]))
            if locations and location_id:
                found = tree.location_chain(location_id)
                # A location of another site would put the device in the wrong
                # place; only the site's own chain counts.
                if all(tree.locations[_uuid(n)]["site_id"] == site["id"] for n in found):
                    nodes.extend(found)
    if layout in ("roles", "sites_roles"):
        role = tree.roles.get(obj.role_id) if getattr(obj, "role_id", None) else None
        if role is not None:
            nodes.append(Node("role", str(role["id"]), role["name"]))
    return nodes


def _uuid(node: Node):
    import uuid

    return uuid.UUID(node.object_id)


def node_key(root_objid: str, nodes: list[Node]) -> str:
    """The queue key of the last node's group: where it sits, as a hash of
    the root and the chain of Danbyte objects above it."""
    text = str(root_objid) + "/" + "/".join(f"{n.kind}:{n.object_id}" for n in nodes)
    return "grp-" + hashlib.sha1(text.encode()).hexdigest()[:24]


def root_of(conn) -> dict | None:
    """The probe or group the layout is built under: ``{objid, path, kind}``."""
    objid = conn.layout_root_id or conn.register_group_id
    if not objid:
        return None
    path = conn.layout_root_path if conn.layout_root_id else conn.register_group_path
    found = next((g for g in conn.groups_cache or [] if g.get("objid") == objid), None)
    return {"objid": objid, "path": (found or {}).get("path") or path or objid,
            "name": (found or {}).get("name") or (path or objid).split(" / ")[-1],
            "kind": (found or {}).get("kind") or "group"}


@dataclass
class Step:
    """One group of an object's chain, as PRTG has it now."""

    node: Node
    key: str
    parent_key: str
    #: The PRTG group, when one is there: found by tag or by name.
    objid: str = ""
    parent_objid: str = ""
    matched_by: str = ""
    current_name: str = ""
    path: str = ""
    depth: int = 0

    @property
    def exists(self) -> bool:
        return bool(self.objid)


class Groups:
    """PRTG's groups as the last read saw them, by parent."""

    def __init__(self, groups: list[dict]):
        self.by_id = {g["objid"]: g for g in groups}
        self.children: dict = {}
        for g in groups:
            self.children.setdefault(str(g.get("parent_id") or ""), []).append(g)

    def find(self, parent_objid: str, node: Node) -> tuple[dict | None, str]:
        kids = self.children.get(str(parent_objid), [])
        for g in kids:
            if g.get("kind") == "group" and node.tag in (g.get("tags") or []):
                return g, "tag"
        for g in kids:
            if g.get("kind") == "group" and g.get("name") == node.name:
                return g, "name"
        return None, ""


def resolve(root: dict, nodes: list[Node], groups: Groups) -> list[Step]:
    """Walk the chain under the root: each group PRTG has (by tag, then by
    name), until the first that is missing; everything below it is missing
    too."""
    steps: list[Step] = []
    parent_objid, parent_key, path = root["objid"], "", root.get("path") or root["objid"]
    for depth, node in enumerate(nodes):
        key = node_key(root["objid"], nodes[: depth + 1])
        path = f"{path} / {node.name}"
        step = Step(node=node, key=key, parent_key=parent_key, parent_objid=parent_objid,
                    path=path, depth=depth)
        if parent_objid:
            found, how = groups.find(parent_objid, node)
            if found is not None:
                step.objid, step.matched_by = str(found["objid"]), how
                step.current_name = found.get("name", "")
        steps.append(step)
        parent_objid, parent_key = step.objid, key
    return steps


def target(root: dict, steps: list[Step]) -> dict:
    """Where the device goes: the deepest step (or the root), as a plan's
    ``group``."""
    if not steps:
        return {"objid": root["objid"], "path": root.get("path", ""),
                "kind": root.get("kind") or "group", "source": "layout", "layout": True}
    last = steps[-1]
    return {"objid": last.objid, "path": last.path, "kind": "group", "key": last.key,
            "source": "layout", "layout": True,
            "needs": [s.key for s in steps if not s.exists]}


def preview(conn, objects, *, layout: str, regions: bool, locations: bool,
            root: dict | None, limit: int = 20) -> dict:
    """The layout for up to ``limit`` objects, from Danbyte's data and the
    last group list: ``{root, layout, rows: [{object, path: [{name, kind,
    exists, matched_by}]}], groups: [{path, objects}]}``."""
    from .provision import _target

    tree = Tree(conn.tenant)
    groups = Groups(conn.groups_cache or [])
    root = root or {"objid": "", "path": "", "name": "", "kind": "group"}
    rows, by_path = [], {}
    for obj in list(objects)[:limit]:
        nodes = chain(conn, obj, tree, layout=layout, regions=regions, locations=locations)
        steps = resolve(root, nodes, groups) if root["objid"] else [
            Step(node=n, key="", parent_key="") for n in nodes]
        path = [{"name": s.node.name, "kind": s.node.kind, "exists": s.exists,
                 "matched_by": s.matched_by} for s in steps]
        rows.append({"object": {**_target(obj), "name": obj.name}, "path": path})
        label = " › ".join([root.get("name") or root.get("path") or "Root",
                            *[p["name"] for p in path]])
        entry = by_path.setdefault(label, {"path": label, "names": [p["name"] for p in path],
                                           "objects": []})
        entry["objects"].append(obj.name)
    return {"root": root, "layout": layout, "rows": rows,
            "groups": sorted(by_path.values(), key=lambda e: e["path"].lower())}
