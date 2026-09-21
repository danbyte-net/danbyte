"""Export-template rendering - Jinja2 in a sandbox.

Renders every object of a template's ``object_type`` (in the active tenant) with
the user-authored template. Uses Jinja's SandboxedEnvironment so a template
can't reach attributes/methods that would execute code or mutate data.

The per-device / per-VM renderers take extra context from **providers**:
another app registers a ``key -> fn(obj) -> value`` pair from its
``AppConfig.ready()`` and every template sees ``key`` (the routing app's
``routing`` block is the first). The same registry feeds the Ansible
inventory, so a template and a playbook read the same shape.
"""
from __future__ import annotations

import ipaddress
import re
from collections.abc import Callable

# key -> fn(obj) -> JSON-able value. Populated by apps at start-up.
_CONTEXT_PROVIDERS: dict[str, Callable] = {}


def register_context_provider(key: str, fn: Callable) -> None:
    """Add ``key`` to every device/VM render context (and the inventory's
    hostvars), computed by ``fn(obj)``. Called from ``AppConfig.ready()``."""
    _CONTEXT_PROVIDERS[key] = fn


def provider_context(obj) -> dict:
    return {key: fn(obj) for key, fn in _CONTEXT_PROVIDERS.items()}


# ─── Address filters ─────────────────────────────────────────────────────────
# A template that writes a router config needs the pieces of an address -
# the mask for IOS, the length for FRR, the wildcard for an OSPF network
# statement. An IPAddress row carries a bare address; its length is its own
# mask when one is stored, else its prefix's, so the filters accept the row
# as well as a string.

def _iface_of(value):
    """``ipaddress.ip_interface`` from a string ("10.0.0.1/24", "10.0.0.1")
    or an IPAddress row (address + its mask, else its prefix's length, /32 or
    /128 when it sits in no prefix)."""
    if isinstance(value, (ipaddress.IPv4Interface, ipaddress.IPv6Interface)):
        return value
    addr = getattr(value, "ip_address", None)
    if addr is not None:
        length = getattr(value, "prefix_length", None)
        return ipaddress.ip_interface(f"{addr}/{length}" if length is not None else addr)
    return ipaddress.ip_interface(str(value).strip())


def _f_cidr(value) -> str:
    return str(_iface_of(value))


def _f_host(value) -> str:
    return str(_iface_of(value).ip)


def _f_prefixlen(value) -> int:
    return _iface_of(value).network.prefixlen


def _f_netmask(value) -> str:
    return str(_iface_of(value).netmask)


def _f_wildcard(value) -> str:
    return str(_iface_of(value).hostmask)


def _f_network(value) -> str:
    return str(_iface_of(value).network)


def _t_ipv4(value) -> bool:
    try:
        return _iface_of(value).version == 4
    except ValueError:
        return False


def _t_ipv6(value) -> bool:
    try:
        return _iface_of(value).version == 6
    except ValueError:
        return False


FILTERS = {
    "cidr": _f_cidr,
    "host": _f_host,
    "prefixlen": _f_prefixlen,
    "netmask": _f_netmask,
    "wildcard": _f_wildcard,
    "network": _f_network,
}
TESTS = {"ipv4": _t_ipv4, "ipv6": _t_ipv6}


# A model method a template may call: Django's choice label, which reads
# nothing but the row in hand. Everything else a model can DO is refused -
# a block list of names cannot keep up with the next accessor someone adds,
# and one of them (DeviceCredential.resolve_secret) read the secret store
# while the sandbox was busy blocking three other names (#216).
_SAFE_MODEL_CALL = re.compile(r"^get_\w+_display$")


def _template_environment_class():
    from jinja2.sandbox import SandboxedEnvironment

    class _Environment(SandboxedEnvironment):
        """The sandbox plus what a template must never reach on a model row
        (#193): a secret-bearing field (``core.secret_fields`` - the same
        rule the audit trail and exports apply, so an encrypted webhook
        secret or an Authorization header cannot be printed), the PSK
        accessors, and the escape hatches from one row to every row - a
        manager's or queryset's ``model`` and any attribute of a model
        class, which would reach ``Model.objects`` across tenants."""

        def is_safe_attribute(self, obj, attr, value):
            if not super().is_safe_attribute(obj, attr, value):
                return False
            from core.secret_fields import SECRET_ACCESSORS

            # However the row was reached - a reverse relation, a list, a
            # filter - an accessor that opens the secret store is refused.
            if attr in SECRET_ACCESSORS:
                return False
            if isinstance(obj, type) and hasattr(obj, "_meta"):
                return False
            meta = getattr(obj, "_meta", None)
            if meta is not None and hasattr(meta, "get_field"):
                from django.core.exceptions import FieldDoesNotExist

                from core.secret_fields import is_secret_field

                try:
                    field = meta.get_field(attr)
                except FieldDoesNotExist:
                    field = None
                if field is not None:
                    return not is_secret_field(obj, field)
                # Not a stored field. A property is data and passes; a method
                # is behaviour and does not, unless it is a choice label.
                return not callable(value) or bool(_SAFE_MODEL_CALL.match(attr))
            from django.db.models import Manager, QuerySet

            if isinstance(obj, (Manager, QuerySet)) and attr in ("model", "raw", "extra", "db", "query"):
                return False
            return True

    return _Environment


def _env():
    env = _template_environment_class()(
        trim_blocks=True, lstrip_blocks=True, autoescape=False
    )
    env.filters.update(FILTERS)
    env.tests.update(TESTS)
    return env


def has_secret_fields(model) -> bool:
    """Whether ``model`` carries a credential at all - a secret field, or an
    accessor that reads one out of the secret store. Such a type is not
    offered to export or label templates as a subject."""
    from core.secret_fields import model_holds_secret

    return model_holds_secret(model)


def _objects_for(template, tenant, user=None):
    """The rows a template may loop over: the type's rows in the tenant,
    narrowed to what ``user`` may view - the same row/site restriction a
    list request applies, so a site-scoped user renders their site, not the
    tenant (#193). No user = nothing (a render is always on someone's
    behalf)."""
    from auth_api import rbac
    from auth_api.object_types import model_for

    model = model_for(template.object_type)
    if model is None:
        return None
    if has_secret_fields(model):
        raise ValueError(f"{template.object_type} carries credentials and cannot be exported by template.")
    qs = model.objects.all()
    if any(f.name == "tenant" for f in model._meta.concrete_fields):
        qs = qs.filter(tenant=tenant)
    if user is None:
        return []
    qs = rbac.restrict_queryset(qs, user, tenant, template.object_type, "view")
    return list(qs)


def render_export_template(template, tenant, user=None) -> str:
    """Render the template against its object type, over the rows ``user``
    may view. Raises ``ValueError`` on a bad object type and
    ``jinja2.TemplateError`` on a template problem."""
    objects = _objects_for(template, tenant, user)
    if objects is None:
        raise ValueError(f"Unknown object type: {template.object_type}")

    tmpl = _env().from_string(template.template_code or "")
    return tmpl.render(objects=objects, queryset=objects, count=len(objects))


# Output types a render may be served as. Anything else (text/html above
# all) goes out as plain text: the body is template-authored, so an active
# type would let a template author run script on the app's origin for whoever
# opens the render (#195).
INERT_MIME_TYPES = frozenset({
    "text/plain", "text/csv", "text/tab-separated-values", "text/markdown",
    "text/xml", "application/xml", "application/json",
    "application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml",
})


def safe_mime_type(declared: str | None) -> str:
    base = (declared or "").split(";")[0].strip().lower()
    return base if base in INERT_MIME_TYPES else "text/plain"


def link_peer_of(iface) -> dict | None:
    """The far end of ``iface``'s cable, as a template may read it.

    ``{"device", "interface", "description", "custom_fields"}`` - the peer's
    name, its port, and its own fields (a ``frr_name`` custom field, say), or
    ``None`` when the port is uncabled or the cable ends off-device. Read-only
    by construction: it is a plain dict, so a template cannot reach the peer
    row or anything hanging off it.
    """
    for term in iface.terminations.all():
        for other in term.cable.terminations.all():
            if other.pk == term.pk:
                continue
            peer = other.interface
            if peer is None:
                return None
            return {
                "device": peer.device.name,
                "interface": peer.name,
                "description": peer.description or "",
                "custom_fields": dict(peer.custom_fields or {}),
            }
    return None


#: What ``link_peer_of`` reads, so a device's ports cost one query, not one
#: per port.
LINK_PEER_PREFETCH = "terminations__cable__terminations__interface__device"


def device_render_interfaces(device) -> list:
    """The device's interfaces with ``link_peer`` attached to each."""
    rows = list(device.interfaces.prefetch_related(LINK_PEER_PREFETCH))
    for iface in rows:
        iface.link_peer = link_peer_of(iface)
    return rows


def render_device_config(template, device, tenant) -> str:
    """Render an export template for a single device - the per-device
    intended-config generator. Context: ``device``, its merged ``config_context``,
    ``interfaces`` (each with ``link_peer``, the cable's far end),
    ``ip_addresses`` (and ``objects``/``count`` for parity), plus every
    registered provider's key (``routing``)."""
    from .config_context import render_config_context

    tmpl = _env().from_string(template.template_code or "")
    return tmpl.render(
        device=device,
        config_context=render_config_context(device)["rendered"],
        interfaces=device_render_interfaces(device),
        ip_addresses=list(device.ip_addresses.all()),
        objects=[device],
        count=1,
        **provider_context(device),
    )


def render_vm_config(template, vm, tenant) -> str:
    """Render an export template for a single virtual machine - the per-VM
    generator behind the Terraform-for-VMs flow (the template author writes
    tfvars/HCL). Context mirrors the device renderer: ``vm`` (also exposed as
    ``device`` for template parity), merged ``config_context``, ``interfaces``,
    ``ip_addresses``."""
    from .config_context import render_config_context

    tmpl = _env().from_string(template.template_code or "")
    return tmpl.render(
        vm=vm,
        device=vm,  # parity: templates can use the same `device.*` accessor
        config_context=render_config_context(vm)["rendered"],
        interfaces=list(vm.interfaces.all()),
        ip_addresses=list(vm.ip_addresses.all()),
        objects=[vm],
        count=1,
        **provider_context(vm),
    )
