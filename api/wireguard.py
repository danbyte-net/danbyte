"""WireGuard values on a tunnel termination: the shape checks, and the
``tunnels`` block a device or VM render sees.

A private key never enters Danbyte. ``private_key_ref`` is a reference the
push tool resolves - a ``<keychain:NAME>`` placeholder (the routing keychain
contract) or an absolute path on the box - and anything that decodes as a
32-byte key is refused, so a pasted key cannot be stored by mistake.
"""
from __future__ import annotations

import base64
import binascii
import ipaddress
import re

from django.apps import apps
from django.core.exceptions import ValidationError

#: ``<keychain:NAME>`` - the same shape the routing render prints.
_KEYCHAIN_REF_RE = re.compile(r"^<keychain:([^<>\s]+)>$")


def _decodes_to_key(value: str) -> bool:
    """Is ``value`` base64 of exactly 32 bytes (a Curve25519 key)?"""
    v = (value or "").strip()
    if len(v) != 44 or not v.endswith("="):
        return False
    try:
        return len(base64.b64decode(v, validate=True)) == 32
    except (binascii.Error, ValueError):
        return False


def validate_public_key(value: str, field: str = "public_key") -> None:
    if not _decodes_to_key(value):
        raise ValidationError(
            {field: "A WireGuard public key is 44 characters of base64 (32 bytes)."}
        )


def validate_private_key_ref(value: str, *, tenant_id=None,
                             field: str = "private_key_ref") -> None:
    v = (value or "").strip()
    if not v:
        return
    if _decodes_to_key(v):
        raise ValidationError(
            {field: "That looks like a key. Store a reference: <keychain:NAME> "
                    "or a path on the box."}
        )
    m = _KEYCHAIN_REF_RE.match(v)
    if m:
        if tenant_id is not None:
            keychain = apps.get_model("routing", "RoutingKeychain")
            if not keychain.objects.filter(tenant_id=tenant_id, name=m.group(1)).exists():
                raise ValidationError({field: f"No keychain named {m.group(1)}."})
        return
    if v.startswith("/") and not any(c.isspace() for c in v) and ".." not in v.split("/"):
        return
    raise ValidationError(
        {field: "Use <keychain:NAME> or an absolute path, like /etc/wireguard/private.key."}
    )


def normalize_allowed_ips(value, field: str = "allowed_ips") -> list[str]:
    """A list of CIDRs, as the box prints them, deduplicated in order. A
    comma-separated string (a CSV cell) is accepted; a host address becomes
    its /32 or /128."""
    if value in (None, ""):
        return []
    if isinstance(value, str):
        value = [v for v in (p.strip() for p in value.split(",")) if v]
    if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
        raise ValidationError({field: "Expected a list of networks."})
    out: list[str] = []
    for raw in value:
        try:
            net = str(ipaddress.ip_network(raw.strip(), strict=True))
        except ValueError as exc:
            raise ValidationError({field: f"Not a valid network: {raw}"}) from exc
        if net not in out:
            out.append(net)
    return out


# ─── Render ──────────────────────────────────────────────────────────────────

def _wireguard_dict(t) -> dict | None:
    if t.tunnel.encapsulation != "wireguard":
        return None
    return {
        "listen_port": t.listen_port,
        "public_key": t.public_key or None,
        "private_key_ref": t.private_key_ref or None,
        "allowed_ips": list(t.allowed_ips or []),
        "endpoint_port": t.endpoint_port,
        "persistent_keepalive": t.persistent_keepalive or None,
    }


def _outside(t) -> str | None:
    ip = t.outside_ip if t.outside_ip_id else None
    return ip.ip_address if ip is not None else None


def _endpoint(host: str | None, port: int | None) -> str | None:
    if not host or not port:
        return None
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


def peer_terminations(t, ends) -> list:
    """The ends ``t`` talks to: every other end for a peer; spokes and other
    hubs for a hub; hubs for a spoke (every other end when there is no hub)."""
    others = [o for o in ends if o.pk != t.pk]
    if t.role == "hub":
        return [o for o in others if o.role in ("spoke", "hub")]
    if t.role == "spoke":
        hubs = [o for o in others if o.role == "hub"]
        return hubs if hubs else others
    return others


def peer_dict(o) -> dict:
    point = o.point
    owner = (point.device if o.interface_id else point.vm) if point is not None else None
    port = o.endpoint_port or o.listen_port
    host = _outside(o)
    return {
        "id": str(o.id),
        "device": owner.name if owner is not None else None,
        "interface": point.name if point is not None else None,
        "role": o.role,
        "outside_ip": host,
        "endpoint_port": port,
        "endpoint": _endpoint(host, port),
        "public_key": o.public_key or None,
        "allowed_ips": list(o.allowed_ips or []),
        "persistent_keepalive": o.persistent_keepalive or None,
    }


def termination_dict(t, ends) -> dict:
    point = t.point
    return {
        "id": str(t.id),
        "name": t.tunnel.name,
        "encapsulation": t.tunnel.encapsulation,
        #: The tunnel's number (``Tunnel.tunnel_id``), not a row id.
        "tunnel_id": t.tunnel.tunnel_id,
        "role": t.role,
        "interface": point.name if point is not None else None,
        "outside_ip": _outside(t),
        "wireguard": _wireguard_dict(t),
        "peers": [peer_dict(o) for o in peer_terminations(t, ends)],
    }


_PREFETCH = (
    "tunnel__terminations__interface__device",
    "tunnel__terminations__vm_interface__vm",
    "tunnel__terminations__outside_ip",
)


def _rows(obj) -> list[dict]:
    label = obj._meta.label_lower
    term = apps.get_model("api", "TunnelTermination")
    if label == "api.device":
        qs = term.objects.filter(interface__device=obj)
    elif label == "api.virtualmachine":
        qs = term.objects.filter(vm_interface__vm=obj)
    else:
        return []
    qs = (
        qs.filter(tunnel__tenant_id=obj.tenant_id)
        .select_related("tunnel", "outside_ip", "interface", "vm_interface")
        .prefetch_related(*_PREFETCH)
        .order_by("tunnel__name", "created_at")
    )
    return [termination_dict(t, list(t.tunnel.terminations.all())) for t in qs]


def tunnels_context(obj) -> list[dict]:
    """``tunnels``: every tunnel end on this device or VM, with the far
    end(s) resolved under ``peers``."""
    return _rows(obj)


def tunnels_by_interface_context(obj) -> dict:
    """``tunnels_by_interface``: the same rows keyed by the local port name."""
    return {r["interface"]: r for r in _rows(obj) if r["interface"]}
