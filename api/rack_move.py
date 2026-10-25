"""Moving a rack to another site together with its devices (#394).

A racked device is at its rack's site (#377), so a rack with devices cannot
change site on an ordinary edit. ``plan`` works out what a move takes: the
devices that go along (racked ones and, through device bays, their children),
what blocks it because it is still tied to a site, and what is cleared.
``apply`` performs a plan with no blockers. Both run inside the caller's
transaction, with the rack locked (``rack_units.lock_rack``) so a device
placed meanwhile is seen or waits.

Blocks, listed with a reason each: a cable from a moving port to anything
outside the moving devices (another device, a power feed, a circuit), a VLAN
or IP address of another site on a moving device, a power feed delivered to
the rack from another site's panel, a cluster at another site, a device in a
bay of a device outside the rack, a bay child racked in another rack or
mounted in a DIN cabinet (#403), a moving device in a virtual chassis with
devices outside the rack, a rack of the same name at the new site
and, under enhanced site separation, a catalog entry local to another site on
the rack, its devices, their components, IP and MAC addresses (#407) and
routing rows (#409). Cleared:
a floor-plan tile that places the rack or one of its devices on a plan of
another site. Updated: each device's site and location, and the site a port
reservation on a moving port carries.

A reason names an object only when the caller may view it; otherwise it says
"a device", "another site" and so on (#404).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from django.db.models import Q

from .models import (
    VLAN,
    Antenna,
    AuxPort,
    Cabinet,
    Cable,
    CableTermination,
    Cluster,
    ConsolePort,
    ConsoleServerPort,
    CoolingFeed,
    CoolingIntake,
    CoolingOutflow,
    Device,
    DeviceBay,
    FloorPlanTile,
    FrontPort,
    Interface,
    InventoryItem,
    IPAddress,
    MACAddress,
    Module,
    ModuleBay,
    PortReservation,
    PowerFeed,
    PowerOutlet,
    PowerPort,
    Rack,
    RearPort,
    Site,
    VirtualChassis,
)

# The cable ends and reservable points that sit on a device.
DEVICE_POINTS = (
    "interface", "front_port", "rear_port", "console_port",
    "console_server_port", "power_port", "power_outlet", "aux_port",
)
_POINT_MODELS = {
    "interface": Interface, "front_port": FrontPort, "rear_port": RearPort,
    "console_port": ConsolePort, "console_server_port": ConsoleServerPort,
    "power_port": PowerPort, "power_outlet": PowerOutlet, "aux_port": AuxPort,
}
# Rows hanging off a moving device that carry tags, statuses or custom
# fields: (model, the path to their own name).
COMPONENTS = (
    (Interface, "name"), (FrontPort, "name"), (RearPort, "name"),
    (ConsolePort, "name"), (ConsoleServerPort, "name"), (PowerPort, "name"),
    (PowerOutlet, "name"), (AuxPort, "name"), (Antenna, "name"),
    (CoolingIntake, "name"), (CoolingOutflow, "name"),
    (DeviceBay, "name"), (ModuleBay, "name"), (Module, "module_bay__name"),
    (InventoryItem, "name"),
)
# Other rows that take their site from a moving device (``SITE_PATHS``) and
# so move with it (#409, #414): (model, the path to the device, how one is
# called, the path to what tells it apart or None).
DEVICE_ROWS = (
    ("api.Service", "device", "service {}", "name"),
    ("api.NATRule", "device", "NAT rule {}", "name"),
    ("monitoring.PortUtilizationRule", "device", "port rule {}", "name"),
    ("routing.StaticRoute", "device", "static route {}", "prefix"),
    ("routing.BGPInstance", "device", "BGP AS{}", "asn__asn"),
    ("routing.BGPSession", "instance__device", "BGP session {}", "remote_address"),
    ("routing.OSPFInstance", "device", "OSPF {}", "process_id"),
    ("routing.ISISInstance", "device", "IS-IS {}", "process"),
    ("routing.EIGRPInstance", "device", "EIGRP {}", "asn"),
    ("routing.LDPInstance", "device", "LDP", None),
    ("routing.VTEP", "device", "VTEP", None),
)
# How a catalog is called in a reason; any other uses its verbose name.
CATALOG_NOUNS = {
    "devicetype": "device type", "status": "status", "vrf": "VRF", "iprole": "IP role",
    "manufacturer": "manufacturer", "zone": "zone", "routetarget": "route target",
}
# A long list of one kind stops here and says how many more.
PER_KIND = 25


@dataclass(frozen=True)
class Ref:
    """An object a reason may name: ``name`` when the caller may view it,
    ``fallback`` otherwise."""

    model: type
    pk: object
    name: str | None
    fallback: str


@dataclass
class Plan:
    rack: Rack
    site: object
    location: object
    devices: list = field(default_factory=list)
    blockers: list = field(default_factory=list)
    tiles: list = field(default_factory=list)

    @property
    def device_ids(self) -> set:
        return {d.pk for d in self.devices}

    def block(self, code: str, message: str, **parts) -> None:
        """``message`` is a format string; each part is plain text (an
        object the caller is already moving) or a ``Ref``."""
        self.blockers.append({"code": code, "message": message, "parts": parts})


def _site(site_id, names: dict) -> Ref:
    return Ref(Site, site_id, names.get(site_id), "another site")


def _device(pk, name, fallback="a device") -> Ref:
    return Ref(Device, pk, name, fallback)


def _component(model, pk, dev: str, name: str) -> Ref:
    noun = "a port" if model in _POINT_MODELS.values() else "a component"
    return Ref(model, pk, f"{dev} {name}", f"{noun} of {dev}")


def plan(rack: Rack, site, location, *, user, tenant) -> Plan:
    """What moving ``rack`` to ``site`` (and ``location``, or none) takes.
    ``user`` and ``tenant`` decide which objects a reason may name."""
    from core.effective_settings import separation_enabled

    p = Plan(rack=rack, site=site, location=location)
    tenant_id = rack.tenant_id
    p.devices = list(
        Device.objects.filter(tenant_id=tenant_id, rack=rack)
        .select_related("device_type", "cluster", "parent_bay__device", "virtual_chassis")
        .order_by("name")
    )
    _add_children(p, tenant_id)
    ids = p.device_ids
    names = dict(Site.objects.filter(tenant_id=tenant_id).values_list("pk", "name"))

    if Rack.objects.filter(site=site, name=rack.name).exclude(pk=rack.pk).exists():
        p.block("name", "{site} already has a rack named {rack}.",
                site=site.name, rack=rack.name)
    _check_bays(p)
    _check_placement(p)
    if ids:
        _check_cables(p, ids)
        _check_vlans(p, ids, names)
        _check_ips(p, ids, names)
        for d in p.devices:
            c = d.cluster
            if c is not None and c.site_id and c.site_id != site.pk:
                p.block("cluster", "{dev}: {cluster} is at {site}.", dev=d.name,
                        cluster=Ref(Cluster, c.pk, f"cluster {c.name}", "its cluster"),
                        site=_site(c.site_id, names))
    feeds = list(
        PowerFeed.objects.filter(rack=rack)
        .exclude(power_panel__site_id=site.pk)
        .values_list("power_panel__site_id", flat=True)
    )
    for site_id in sorted(set(feeds), key=lambda s: names.get(s, "")):
        n = sum(1 for s in feeds if s == site_id)
        p.block("power_feed", f"{n} power feed{'s' if n != 1 else ''} from {{site}} "
                              f"deliver{'' if n != 1 else 's'} to this rack.",
                site=_site(site_id, names))
    # Cooling loops as power feeds (#434): a source's site is the loop's.
    loops = list(
        CoolingFeed.objects.filter(rack=rack)
        .exclude(source__site_id=site.pk)
        .values_list("source__site_id", flat=True)
    )
    for site_id in sorted(set(loops), key=lambda s: names.get(s, "")):
        n = sum(1 for s in loops if s == site_id)
        p.block("cooling_feed", f"{n} cooling feed{'s' if n != 1 else ''} from {{site}} "
                                f"deliver{'' if n != 1 else 's'} to this rack.",
                site=_site(site_id, names))
    if separation_enabled(rack.tenant):
        _check_catalog(p, names)

    p.tiles = list(
        FloorPlanTile.objects.filter(Q(rack=rack) | Q(device_id__in=ids))
        .exclude(floor_plan__location__site_id=site.pk)
    )
    _cap(p)
    _name(p, user, tenant)
    return p


def _add_children(p: Plan, tenant_id) -> None:
    """Devices installed in the bays of moving devices go along, unless they
    are racked in another rack or mounted in a DIN cabinet (#403): both tie
    them to the old site."""
    seen = p.device_ids
    frontier = set(seen)
    while frontier:
        kids = list(
            Device.objects.filter(tenant_id=tenant_id, parent_bay__device_id__in=frontier)
            .exclude(pk__in=seen)
            .select_related("device_type", "cluster", "rack", "cabinet",
                            "virtual_chassis", "parent_bay__device")
        )
        frontier = set()
        for k in kids:
            seen.add(k.pk)
            if k.rack_id and k.rack_id != p.rack.pk:
                p.block("bay", "{child} sits in a bay of {parent} but is racked in {rack}.",
                        child=_device(k.pk, k.name, "A device"),
                        parent=k.parent_bay.device.name,
                        rack=Ref(Rack, k.rack_id, k.rack.name, "another rack"))
                continue
            if k.cabinet_id:
                p.block("bay", "{child} sits in a bay of {parent} but is mounted in "
                               "{cabinet}.",
                        child=_device(k.pk, k.name, "A device"),
                        parent=k.parent_bay.device.name,
                        cabinet=Ref(Cabinet, k.cabinet_id, f"cabinet {k.cabinet.name}",
                                    "a cabinet"))
                continue
            p.devices.append(k)
            frontier.add(k.pk)


def _check_bays(p: Plan) -> None:
    ids = p.device_ids
    for d in p.devices:
        bay = getattr(d, "parent_bay", None)
        if bay is not None and bay.device_id not in ids:
            p.block("bay", "{dev} sits in a bay of {parent}, outside the rack.",
                    dev=d.name, parent=_device(bay.device_id, bay.device.name))


def _check_placement(p: Plan) -> None:
    """A virtual chassis whose other members stay behind. (A racked device
    is never in a DIN cabinet - ``device_rack_or_cabinet`` - and a bay child
    in one is stopped in ``_add_children``.)"""
    ids = p.device_ids
    chassis = {d.virtual_chassis_id: d for d in p.devices if d.virtual_chassis_id}
    if not chassis:
        return
    split = set(
        Device.objects.filter(virtual_chassis_id__in=chassis).exclude(pk__in=ids)
        .values_list("virtual_chassis_id", flat=True)
    )
    for d in p.devices:
        vc = d.virtual_chassis
        if vc is not None and vc.pk in split:
            p.block("virtual_chassis", "{dev} is in {vc} with devices outside the rack.",
                    dev=d.name,
                    vc=Ref(VirtualChassis, vc.pk, f"virtual chassis {vc.name}",
                           "a virtual chassis"))


def _check_cables(p: Plan, ids: set) -> None:
    touch = Q()
    for f in DEVICE_POINTS:
        touch |= Q(**{f"{f}__device_id__in": ids})
    cable_ids = set(
        CableTermination.objects.filter(touch).values_list("cable_id", flat=True)
    )
    if not cable_ids:
        return
    rows = CableTermination.objects.filter(cable_id__in=cable_ids).values(
        "cable_id",
        *[f"{f}_id" for f in DEVICE_POINTS],
        *[f"{f}__device_id" for f in DEVICE_POINTS],
        *[f"{f}__device__name" for f in DEVICE_POINTS],
        *[f"{f}__name" for f in DEVICE_POINTS],
    )
    inside_end: dict = {}
    leaving: set = set()
    for row in rows:
        dev = next((row[f"{f}__device_id"] for f in DEVICE_POINTS
                    if row[f"{f}__device_id"] is not None), None)
        if dev in ids:
            f = next(f for f in DEVICE_POINTS if row[f"{f}__device_id"] == dev)
            inside_end.setdefault(row["cable_id"], _component(
                _POINT_MODELS[f], row[f"{f}_id"], row[f"{f}__device__name"],
                row[f"{f}__name"]))
        else:
            leaving.add(row["cable_id"])
    cables = {c.pk: c for c in Cable.objects.filter(pk__in=leaving)}
    for cid in sorted(leaving, key=lambda c: inside_end[c].name):
        # The far end is never named.
        p.block("cable", "{cable} on {end} leaves the rack.",
                cable=Ref(Cable, cid, str(cables[cid]), "A cable"), end=inside_end[cid])


def _check_vlans(p: Plan, ids: set, names: dict) -> None:
    site_pk = p.site.pk
    rows = list(
        Interface.objects.filter(device_id__in=ids, vlan__site__isnull=False)
        .exclude(vlan__site_id=site_pk)
        .values_list("device__name", "name", "pk", "vlan_id", "vlan__vlan_id",
                     "vlan__site_id")
    )
    rows += list(
        Interface.tagged_vlans.through.objects.filter(
            interface__device_id__in=ids, vlan__site__isnull=False
        )
        .exclude(vlan__site_id=site_pk)
        .values_list("interface__device__name", "interface__name", "interface_id",
                     "vlan_id", "vlan__vlan_id", "vlan__site_id")
    )
    for dev, port, port_pk, vlan_pk, vid, site_id in sorted(set(rows), key=str):
        p.block("vlan", "{port} carries {vlan} of {site}.",
                port=_component(Interface, port_pk, dev, port),
                vlan=Ref(VLAN, vlan_pk, f"VLAN {vid}", "a VLAN"),
                site=_site(site_id, names))


def _check_ips(p: Plan, ids: set, names: dict) -> None:
    site_pk = p.site.pk
    elsewhere = (
        (Q(site__isnull=False) & ~Q(site_id=site_pk))
        | (Q(prefix__site__isnull=False) & ~Q(prefix__site_id=site_pk))
    )
    rows = (
        _ips(p, ids).filter(elsewhere)
        .values_list("pk", "assigned_device__name", "assigned_interface__device__name",
                     "site_id", "prefix__site_id")
        .distinct()
    )
    counts: dict = {}
    for _pk, dev, iface_dev, site_id, prefix_site in rows:
        where = site_id if site_id and site_id != site_pk else prefix_site
        key = (dev or iface_dev, where)
        counts[key] = counts.get(key, 0) + 1
    for (dev, site_id), n in sorted(counts.items(), key=lambda kv: str(kv[0])):
        p.block("ip", f"{{dev}}: {n} IP address{'es' if n != 1 else ''} of {{site}}.",
                dev=dev, site=_site(site_id, names))


def _ips(p: Plan, ids: set):
    return IPAddress.objects.filter(tenant_id=p.rack.tenant_id).filter(
        Q(assigned_device_id__in=ids) | Q(assigned_interface__device_id__in=ids))


def _local(model, noun: str, tenant_id, site_pk) -> dict:
    """Entries of a catalog local to a site other than the new one:
    ``{pk: (noun, name, owning site)}``. One query."""
    return {
        pk: (noun, name, owner)
        for pk, name, owner in model.objects.filter(
            owning_site__tenant_id=tenant_id, owning_site__isnull=False
        ).exclude(owning_site_id=site_pk).values_list("pk", "name", "owning_site_id")
    }


@dataclass(frozen=True)
class _Subject:
    """Rows of one model that move: the values that name a row (``label``,
    its pk first), the catalog foreign keys it carries as ``(field, catalog
    model)``, and how a row becomes the subject of a reason."""

    model: type
    rows: object
    label: tuple
    fks: tuple
    ref: object


def _local_catalogs() -> dict:
    """Every catalog a row points at by foreign key that can be local to a
    site: those of ``CATALOG_SITE_PATHS`` with their own ``owning_site``.
    Tags and custom fields are read apart; a custom-field group and the
    component templates are never referenced by a row that moves."""
    from django.apps import apps

    from auth_api.site_paths import CATALOG_SITE_PATHS
    from core.models import Tag
    from customization.models import CustomField, CustomFieldGroup

    return {
        m: CATALOG_NOUNS.get(m._meta.model_name, str(m._meta.verbose_name))
        for m in apps.get_models()
        if CATALOG_SITE_PATHS.get(m._meta.model_name) == "owning_site"
        and m not in (Tag, CustomField, CustomFieldGroup)
    }


def _catalog_fks(model, catalogs: dict) -> tuple:
    return tuple(
        (f.name, f.related_model) for f in model._meta.concrete_fields
        if f.many_to_one and f.related_model in catalogs
    )


def _subjects(p: Plan) -> list:
    """Everything that moves and may carry a catalog entry: the rack, its
    devices, their components, IP and MAC addresses (#407), and the routing
    rows that take their site from a moving device (#409)."""
    from django.apps import apps

    catalogs = _local_catalogs()
    ids, tenant_id = p.device_ids, p.rack.tenant_id

    def plain(row):
        return row[1]

    def component(model):
        return lambda row: _component(model, row[0], row[1], row[2])

    def ip(row):
        dev = row[1] or row[2]
        return Ref(IPAddress, row[0], f"{dev} {row[3]}", f"an IP address of {dev}")

    def mac(row):
        return Ref(MACAddress, row[0], f"{row[1]} {row[2]}", f"a MAC address of {row[1]}")

    def routing(model, called):
        return lambda row: _component(
            model, row[0], row[1],
            called.format("" if len(row) < 3 or row[2] is None else row[2]).strip())

    out = [
        _Subject(Rack, Rack.objects.filter(pk=p.rack.pk), ("pk", "name"),
                 _catalog_fks(Rack, catalogs), plain),
        _Subject(Device, Device.objects.filter(pk__in=ids), ("pk", "name"),
                 _catalog_fks(Device, catalogs), plain),
    ]
    if not ids:
        return out
    for model, name_path in COMPONENTS:
        out.append(_Subject(model, model.objects.filter(device_id__in=ids),
                            ("pk", "device__name", name_path),
                            _catalog_fks(model, catalogs), component(model)))
    out.append(_Subject(IPAddress, _ips(p, ids),
                        ("pk", "assigned_device__name", "assigned_interface__device__name",
                         "ip_address"),
                        _catalog_fks(IPAddress, catalogs), ip))
    out.append(_Subject(MACAddress, MACAddress.objects.filter(
        tenant_id=tenant_id, assigned_interface__device_id__in=ids),
        ("pk", "assigned_interface__device__name", "mac_address"),
        _catalog_fks(MACAddress, catalogs), mac))
    for label, device, called, name_path in DEVICE_ROWS:
        model = apps.get_model(label)
        out.append(_Subject(
            model, model.objects.filter(**{f"{device}_id__in": ids}),
            ("pk", f"{device}__name", *([name_path] if name_path else [])),
            _catalog_fks(model, catalogs), routing(model, called)))
    return out


def _check_catalog(p: Plan, names: dict) -> None:
    """Under enhanced site separation a catalog entry local to one site is
    not offered at another, so nothing that moves may take one along (see
    ``_subjects``). Every catalog of ``CATALOG_SITE_PATHS`` a moving row can
    reference is checked: tags, custom fields, and each foreign key to a
    catalog with an owning site - device type, status, VRF, IP role,
    manufacturer and the like (#407, #409). Query count does not grow with
    the number of rows."""
    from django.contrib.contenttypes.models import ContentType

    from core.models import Tag, TaggedItem
    from customization.models import CustomField

    site_pk, tenant_id = p.site.pk, p.rack.tenant_id
    subjects = _subjects(p)
    catalogs = _local_catalogs()
    referenced = {cat for s in subjects for _f, cat in s.fks}
    local = {cat: _local(cat, catalogs[cat], tenant_id, site_pk)
             for cat in sorted(referenced, key=lambda m: m._meta.label)}
    tags = _local(Tag, "tag", tenant_id, site_pk)
    fields = {
        key: (pk, "custom field", label, owner)
        for pk, key, label, owner in CustomField.objects.filter(
            tenant_id=tenant_id, owning_site__isnull=False
        ).exclude(owning_site_id=site_pk).values_list("pk", "key", "label", "owning_site_id")
    }

    def found(subject, model, pk, noun, name, owner):
        article = "an" if noun.startswith(("IP", "a", "e", "i", "o", "u")) else "a"
        p.block("catalog", "{obj}: {entry} is local to {site}.", obj=subject,
                entry=Ref(model, pk, f"{noun} {name}", f"{article} {noun}"),
                site=_site(owner, names))

    # Tags: one query over every subject, then the names of the tagged rows.
    tagged = [s for s in subjects if _has_field(s.model, "tags")]
    if tags and tagged:
        cts = ContentType.objects.get_for_models(*[s.model for s in tagged])
        where = Q()
        for s in tagged:
            where |= Q(content_type=cts[s.model], object_id__in=s.rows.values("pk"))
        hits: dict = {}
        for ct_id, obj_id, tag_id in TaggedItem.objects.filter(
                where, tag_id__in=tags).values_list("content_type_id", "object_id", "tag_id"):
            hits.setdefault(ct_id, []).append((obj_id, tag_id))
        for s in tagged:
            pairs = hits.get(cts[s.model].pk)
            if not pairs:
                continue
            rows = {r[0]: r for r in s.rows.filter(pk__in={o for o, _ in pairs})
                    .values_list(*s.label)}
            for obj_id, tag_id in sorted(pairs, key=lambda x: (str(rows[x[0]][1:]), str(x[1]))):
                found(s.ref(rows[obj_id]), Tag, tag_id, *tags[tag_id])

    for s in subjects:
        fks = [(f, cat) for f, cat in s.fks if local[cat]]
        keys = list(fields) if _has_field(s.model, "custom_fields") else []
        if not fks and not keys:
            continue
        where = Q()
        for f, cat in fks:
            where |= Q(**{f"{f}_id__in": local[cat]})
        if keys:
            where |= Q(custom_fields__has_any_keys=keys)
        extra = [f"{f}_id" for f, _cat in fks] + (["custom_fields"] if keys else [])
        for row in s.rows.filter(where).values_list(*s.label, *extra).order_by(*s.label[1:]):
            subject = s.ref(row)
            values = dict(zip(extra, row[len(s.label):], strict=True))
            for f, cat in fks:
                entry = local[cat].get(values[f"{f}_id"])
                if entry is not None:
                    found(subject, cat, values[f"{f}_id"], *entry)
            for key, value in sorted((values.get("custom_fields") or {}).items()):
                if key in fields and value not in (None, "", [], {}):
                    found(subject, CustomField, *fields[key])


def _has_field(model, name: str) -> bool:
    from django.core.exceptions import FieldDoesNotExist

    try:
        model._meta.get_field(name)
    except FieldDoesNotExist:
        return False
    return True


def _cap(p: Plan) -> None:
    """At most ``PER_KIND`` reasons of one kind, then how many more."""
    kept, counts = [], {}
    for b in p.blockers:
        counts[b["code"]] = counts.get(b["code"], 0) + 1
        if counts[b["code"]] <= PER_KIND:
            kept.append(b)
    for code, n in counts.items():
        if n > PER_KIND:
            kept.append({"code": code, "message": f"…and {n - PER_KIND} more.",
                         "parts": {}})
    p.blockers = kept


def _name(p: Plan, user, tenant) -> None:
    """Turn each reason into its message, naming an object only when the
    caller may view it (#404). One query per kind of object named."""
    from auth_api import rbac

    wanted: dict = {}
    for b in p.blockers:
        for v in b["parts"].values():
            if isinstance(v, Ref) and v.name is not None and v.pk is not None:
                wanted.setdefault(v.model, set()).add(v.pk)
    visible: dict = {}
    for model, pks in wanted.items():
        if getattr(user, "is_superuser", False):
            visible[model] = pks
            continue
        visible[model] = set(rbac.restrict_queryset(
            model.objects.filter(pk__in=pks), user, tenant, model._meta.model_name, "view",
        ).values_list("pk", flat=True))

    def text(v):
        if not isinstance(v, Ref):
            return v
        return v.name if v.pk in visible.get(v.model, ()) else v.fallback

    p.blockers = [
        {"code": b["code"],
         "message": b["message"].format(**{k: text(v) for k, v in b["parts"].items()})}
        for b in p.blockers
    ]


def payload(p: Plan, *, moved: bool) -> dict:
    def ref(obj):
        return {"id": str(obj.pk), "name": obj.name} if obj is not None else None

    rack = p.rack
    return {
        "rack": ref(rack),
        "from_site": {"id": str(rack.site_id), "name": rack.site.name},
        "to_site": ref(p.site),
        "to_location": ref(p.location),
        "devices": [
            {"id": str(d.pk), "name": d.name, "position": d.position,
             "face": d.face, "mount": d.mount, "racked": d.rack_id == rack.pk}
            for d in p.devices
        ],
        "cleared": {"floor_plan_tiles": len(p.tiles)},
        "blockers": p.blockers,
        "can_move": not p.blockers,
        "moved": moved,
    }


def apply(p: Plan) -> None:
    """Perform a plan with no blockers. Each object is saved on its own so
    the change log records every one."""
    assert not p.blockers
    site, location = p.site, p.location
    for d in p.devices:
        d.site = site
        d.location = location
        d.save(update_fields=["site", "location", "updated_at"])
    rack = p.rack
    rack.site = site
    rack.location = location
    rack.save(update_fields=["site", "location", "updated_at"])
    ids = p.device_ids
    for tile in p.tiles:
        if tile.rack_id == rack.pk:
            tile.rack = None
        if tile.device_id in ids:
            tile.device = None
        if tile.link_kind in ("rack", "device"):
            tile.link_kind = ""
        tile.save(update_fields=["rack", "device", "link_kind", "updated_at"])
    if ids:
        held = Q()
        for f in DEVICE_POINTS:
            held |= Q(**{f"{f}__device_id__in": ids})
        for hold in PortReservation.objects.filter(held):
            # save() recomputes the site from the held port.
            hold.save()
