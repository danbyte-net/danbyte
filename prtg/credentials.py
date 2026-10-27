"""Where the credentials a sensor needs are set in PRTG.

A PRTG sensor kind reads its login from one settings section (the kind's
``credential_group``: ``snmpversiongroup``, ``windowsconnection``,
``linuxconnection``, ``vmwareconnection``,
``paessler-vmware-vmware_credentials_section``,
``paessler-proxmox-credentials_section`` …), which a device inherits from its
group, the groups above it and the probe unless it is set on the device.

A sensor profile says, per section its kinds need, where Danbyte puts it:

* **Inherit** (the default) - nothing is sent; PRTG's own inheritance
  decides. The plan reads what PRTG has above the device and a sensor whose
  section is set nowhere waits in the queue as *Needs attention*.
* **Set on the group** - on the group the device goes under (the policy's,
  the registration group, or the layout group Danbyte builds).
* **Set on the device** - on the PRTG device Danbyte creates.

A policy may override a profile's choice section by section. What is sent
comes from a :class:`~prtg.models.PrtgCredential` (or an SNMP profile for
``snmpversiongroup``) picked with the choice; for **Set on the device** with
none picked, the credentials Danbyte holds for the object itself (its SNMP
profile, or a device credential of the matching kind).

Values go to PRTG with ``_inherited: false`` through the same section
``PATCH`` a device's credentials use. Danbyte keeps a keyed hash of what it
wrote, writes again only when that changes, and never reads a secret back -
PRTG returns passwords as ``*********``.
"""
from __future__ import annotations

from dataclasses import dataclass

from django.utils import timezone

from . import sensor_kinds as sk

INHERIT, GROUP, DEVICE = "inherit", "group", "device"
MODES = (INHERIT, GROUP, DEVICE)

PROXMOX = "paessler-proxmox-credentials_section"
VMWARE_V2 = "paessler-vmware-vmware_credentials_section"


@dataclass(frozen=True)
class Section:
    name: str
    label: str
    #: The PrtgCredential kind (or "snmp") that fills it; "" when Danbyte
    #: cannot write it and only inheritance applies.
    source: str
    #: The fields that say "a login is set" when PRTG reads the section.
    identity: tuple


SECTIONS = {
    s.name: s for s in (
        Section("snmpversiongroup", "SNMP", "snmp",
                ("snmpcommv1", "snmpcommv2", "snmpuser")),
        Section("windowsconnection", "Windows", "windows_login",
                ("windowsloginusername",)),
        Section("linuxconnection", "Linux / SSH", "ssh", ("linuxloginusername",)),
        Section("vmwareconnection", "VMware", "vmware", ("esxuser",)),
        Section(VMWARE_V2, "VMware (new sensors)", "vmware",
                (f"{VMWARE_V2}-vmware_credentials_group-username",)),
        Section(PROXMOX, "Proxmox", "proxmox",
                (f"{PROXMOX}-credentials_group-api_token_id",)),
    )
}


def section_label(name: str) -> str:
    known = SECTIONS.get(name)
    if known:
        return known.label
    # paessler-<vendor>-<...>: the vendor reads best.
    parts = name.split("-")
    if len(parts) > 2 and parts[0] == "paessler":
        return parts[1].replace("_", " ").title()
    return name


def _is_credentials(name: str) -> bool:
    return name in SECTIONS or "credential" in name or name.endswith("connection")


def sections_of(conn, kind: str) -> list[str]:
    """The credential sections a sensor kind reads: Danbyte's own kinds by
    what they need, a PRTG kind by its ``credential_group`` in the cached
    sensor list."""
    known = sk.BY_VALUE.get(kind)
    if known is not None:
        return {sk.SNMP: ["snmpversiongroup"], sk.WINDOWS: ["windowsconnection"]}.get(
            known.needs or "", []
        )
    from .manual import cached_kind

    row = cached_kind(conn, kind) or {}
    names = str(row.get("credentials") or "").split()
    return [n for n in names if _is_credentials(n)]


def profile_sections(profile) -> list[dict]:
    """Every credential section a profile's definitions need, in first-use
    order: ``[{section, label, writable, kinds: [label]}]``."""
    out: dict = {}
    for defn in profile.definitions.all():
        for name in sections_of(profile.connection, defn.kind):
            row = out.setdefault(name, {
                "section": name, "label": section_label(name),
                "writable": bool(SECTIONS.get(name) and SECTIONS[name].source),
                "kinds": [],
            })
            label = defn.name or sk.label(defn.kind) or defn.kind
            if label not in row["kinds"]:
                row["kinds"].append(label)
    return list(out.values())


def clean_placement(conn, value) -> dict:
    """A placement map as stored: known modes only, a picked credential of
    this connection whose kind fills the section, nothing for Inherit.
    Raises ValueError with a sentence."""
    from monitoring.models import SnmpProfile

    from .models import PrtgCredential

    if value in (None, "", {}):
        return {}
    if not isinstance(value, dict):
        raise ValueError("Expected an object of sections.")
    out = {}
    for name, entry in value.items():
        if not isinstance(entry, dict):
            raise ValueError(f"{name}: expected an object.")
        mode = entry.get("mode") or INHERIT
        if mode not in MODES:
            raise ValueError(f"{name}: '{mode}' is not inherit, group or device.")
        if mode == INHERIT:
            continue
        section = SECTIONS.get(name)
        if section is None or not section.source:
            raise ValueError(f"Danbyte cannot write {section_label(name)} credentials; "
                             "leave it on Inherit.")
        row = {"mode": mode}
        cred_id = str(entry.get("credential") or "").strip()
        snmp_id = str(entry.get("snmp_profile") or "").strip()
        if section.source == "snmp":
            if snmp_id:
                if not SnmpProfile.objects.filter(pk=snmp_id, tenant=conn.tenant).exists():
                    raise ValueError(f"{section.label}: pick an SNMP profile of this tenant.")
                row["snmp_profile"] = snmp_id
            elif mode == GROUP:
                raise ValueError(f"{section.label}: pick the SNMP profile to set on the group.")
        else:
            if cred_id:
                cred = PrtgCredential.objects.filter(pk=cred_id, connection=conn).first()
                if cred is None:
                    raise ValueError(f"{section.label}: pick a credential of this connection.")
                if cred.kind != section.source:
                    raise ValueError(f"{section.label}: {cred.name} is a "
                                     f"{cred.get_kind_display()} credential.")
                row["credential"] = cred_id
            elif mode == GROUP:
                raise ValueError(f"{section.label}: pick the credential to set on the group.")
        out[name] = row
    return out


def placement_for(want, needed: list[str]) -> dict:
    """Each needed section's placement for one object: the first matching
    policy that sets it, else the first of the object's profiles that does,
    else Inherit. ``{section: {mode, credential?, snmp_profile?, by}}``."""
    out = {}
    for name in needed:
        found = None
        for policy in want.policies:
            entry = (policy.credential_placement or {}).get(name)
            if entry and entry.get("mode", INHERIT) != INHERIT:
                found = {**entry, "by": {"policy": str(policy.id), "name": policy.name}}
                break
        if found is None:
            for profile in want.profiles:
                entry = (profile.credential_placement or {}).get(name)
                if entry and entry.get("mode", INHERIT) != INHERIT:
                    found = {**entry, "by": {"profile": str(profile.id),
                                             "name": profile.name}}
                    break
        if found is None:
            lead = want.profiles[0] if want.profiles else None
            found = {"mode": INHERIT, "by": (
                {"profile": str(lead.id), "name": lead.name} if lead else {})}
        out[name] = found
    return out


def needed_sections(conn, sensors: list[dict]) -> list[str]:
    out: list = []
    for inst in sensors:
        for name in sections_of(conn, inst.get("kindid") or inst["kind"]):
            if name not in out:
                out.append(name)
    return out


# ── values ──────────────────────────────────────────────────────────────────


def credential_values(cred) -> dict:
    """A PrtgCredential as the PRTG section it fills, ``_inherited`` off.
    ``{section: values}`` - VMware fills both of PRTG's VMware sections."""
    p = cred.params or {}
    s = cred.secret_params or {}
    if cred.kind == "proxmox":
        user = str(p.get("user") or "").strip()
        realm = str(p.get("realm") or "").strip()
        token = str(p.get("token_id") or "").strip()
        ident = user if "@" in user or not realm else f"{user}@{realm}"
        if token and "!" not in ident:
            ident = f"{ident}!{token}"
        return {PROXMOX: {
            "_inherited": False,
            f"{PROXMOX}-credentials_group-api_token_id": ident,
            f"{PROXMOX}-credentials_group-api_token_secret": s.get("token_secret", ""),
            f"{PROXMOX}-connection_group-port": int(p.get("port") or 8006),
        }}
    if cred.kind == "vmware":
        return {
            "vmwareconnection": {"_inherited": False, "esxuser": p.get("user", ""),
                                 "esxpassword": s.get("password", "")},
            VMWARE_V2: {
                "_inherited": False,
                f"{VMWARE_V2}-vmware_credentials_group-username": p.get("user", ""),
                f"{VMWARE_V2}-vmware_credentials_group-password": s.get("password", ""),
                f"{VMWARE_V2}-connection_group-port": int(p.get("port") or 443),
            },
        }
    if cred.kind == "windows_login":
        return {"windowsconnection": {
            "_inherited": False, "windowslogindomain": p.get("domain", ""),
            "windowsloginusername": p.get("user", ""),
            "windowsloginpassword": s.get("password", ""),
        }}
    if cred.kind == "ssh":
        out = {"_inherited": False, "linuxloginusername": p.get("user", ""),
               "sshport": int(p.get("port") or 22)}
        if s.get("private_key"):
            # PRTG 26.3: login mode 1 is a private key, 0 a password.
            out.update(linuxloginmode="1", privatekey=s["private_key"])
        else:
            out.update(linuxloginmode="0", linuxloginpassword=s.get("password", ""))
        return {"linuxconnection": out}
    return {}


def snmp_values(profile) -> dict:
    """An SNMP profile as ``snmpversiongroup``."""
    from .writer import snmp_section

    return {"snmpversiongroup": snmp_section(profile)}


def device_credential_values(obj, kind: str) -> dict:
    """What a device's own stored credential of ``kind`` (a PrtgCredential
    kind) gives, or {}. Device credentials hold the login as one username:
    ``DOMAIN\\user`` for Windows, ``user@realm!tokenid`` for Proxmox."""
    from monitoring.models import DeviceCredential

    from .provision import _is_vm

    if obj is None or _is_vm(obj):
        return {}
    kinds = {
        "windows_login": ("windows_login",), "proxmox": ("proxmox",),
        "vmware": ("vmware",), "ssh": ("ssh_key", "ssh_password"),
    }.get(kind, ())
    dc = DeviceCredential.objects.filter(device=obj, kind__in=kinds).order_by("name").first()
    if dc is None:
        return {}
    secret = dc.resolve_secret() or {}
    user = dc.username or ""

    class _Shim:
        pass

    shim = _Shim()
    shim.kind = kind
    if kind == "windows_login":
        domain, _, login = user.rpartition("\\")
        shim.params = {"domain": domain, "user": login or user}
        shim.secret_params = {"password": secret.get("password", "")}
    elif kind == "proxmox":
        shim.params = {"user": user, "port": dc.port}
        shim.secret_params = {"token_secret": secret.get("password", "")}
    elif kind == "ssh":
        shim.params = {"user": user, "port": dc.port}
        shim.secret_params = {"password": secret.get("password", ""),
                              "private_key": secret.get("private_key", "")}
    else:
        shim.params = {"user": user, "port": dc.port}
        shim.secret_params = {"password": secret.get("password", "")}
    return credential_values(shim)


def values_for(section: str, entry: dict, obj=None, tenant=None) -> tuple[dict, str]:
    """The ``{section: values}`` to write for one placement entry, and the
    name of the credential it came from. ``({}, "")`` when there is none."""
    from monitoring.models import SnmpProfile

    from .models import PrtgCredential

    spec = SECTIONS.get(section)
    if spec is None or not spec.source:
        return {}, ""
    if spec.source == "snmp":
        profile = None
        if entry.get("snmp_profile"):
            profile = SnmpProfile.objects.filter(pk=entry["snmp_profile"]).first()
        elif obj is not None:
            from monitoring.snmp_resolve import resolve_device_profile, resolve_vm_profile

            from .provision import _is_vm

            profile, _ = (resolve_vm_profile if _is_vm(obj) else resolve_device_profile)(
                obj, tenant or obj.tenant)
        if profile is None:
            return {}, ""
        return snmp_values(profile), f"SNMP {profile.name}"
    if entry.get("credential"):
        cred = PrtgCredential.objects.filter(pk=entry["credential"]).first()
        if cred is None:
            return {}, ""
        values = credential_values(cred)
        return ({section: values[section]} if section in values else {}), cred.name
    if obj is not None:
        values = device_credential_values(obj, spec.source)
        if section in values:
            return {section: values[section]}, f"{spec.label} of {obj.name}"
    return {}, ""


# ── what PRTG has ───────────────────────────────────────────────────────────


def effective(data: dict, sections, own_name: str = "") -> dict:
    """PRTG's answer for an object's sections as ``{section: {set,
    inherited, source}}``: whether a login is in effect, and where it comes
    from - the object itself, or the group or probe it inherits from."""
    out = {}
    for name in sections:
        sec = data.get(name)
        if not isinstance(sec, dict):
            out[name] = {"set": None, "inherited": None, "source": ""}
            continue
        spec = SECTIONS.get(name)
        if spec is not None:
            fields = spec.identity
        else:
            fields = tuple(k for k in sec if not k.startswith("_") and (
                "user" in k.lower() or "token" in k.lower() or "key" in k.lower()
                or "pass" in k.lower()))
        present = any(str(sec.get(f) or "").strip() for f in fields)
        inherited = sec.get("_inherited")
        src = sec.get("_inheritancesource") or {}
        if inherited is False or inherited is None:
            source = own_name
        else:
            source = str(src.get("name") or "")
        out[name] = {"set": present, "inherited": bool(inherited),
                     "source": source if present else ""}
    return out


def read_effective(conn, objid: str, kind: str, sections, *, v2=None,
                   cache: dict | None = None) -> dict | None:
    """What PRTG has in effect for ``sections`` on a probe, group or device,
    read live through API v2 (kept on the connection for the pages). None
    when it cannot be read."""
    from .client import PrtgError
    from .client_v2 import PrtgV2Client

    sections = sorted(set(sections))
    if not sections or not objid:
        return {}
    ck = (str(objid), tuple(sections))
    if cache is not None and ck in cache:
        return cache[ck]
    if conn.v2_available is False:
        return None
    v2 = v2 or PrtgV2Client.for_connection(conn)
    try:
        data = v2.settings(objid, kind, sections)
    except PrtgError:
        if cache is not None:
            cache[ck] = None
        return None
    result = effective(data, sections, str(data.get("name") or ""))
    if cache is not None:
        cache[ck] = result
    reads = dict(conn.credential_reads or {})
    entry = dict(reads.get(str(objid)) or {})
    entry["read_at"] = timezone.now().isoformat()
    entry["sections"] = {**(entry.get("sections") or {}), **result}
    reads[str(objid)] = entry
    if len(reads) > 200:
        # Oldest first out: the cache is for the pages, not a history.
        for key in sorted(reads, key=lambda k: reads[k].get("read_at", ""))[:len(reads) - 200]:
            reads.pop(key, None)
    conn.credential_reads = reads
    conn.save(update_fields=["credential_reads"])
    return result


def cached_effective(conn, objid: str) -> dict:
    return ((conn.credential_reads or {}).get(str(objid)) or {}).get("sections") or {}


def describe(state: dict | None, label: str) -> str:
    """A section's inheritance as the pages say it."""
    if not state or state.get("set") is None:
        return ""
    if state.get("set"):
        if state.get("inherited"):
            return f"Inherited from {state.get('source') or 'a group above'}"
        return f"Set on {state.get('source') or 'this object'}"
    return f"{label}: not set on any group above this device"
