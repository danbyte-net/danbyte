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
# statement. An IPAddress row carries a bare address; its length is its
# prefix's, so the filters accept the row as well as a string.

def _iface_of(value):
    """``ipaddress.ip_interface`` from a string ("10.0.0.1/24", "10.0.0.1")
    or an IPAddress row (address + its prefix's length, /32 or /128 when it
    sits in no prefix)."""
    if isinstance(value, (ipaddress.IPv4Interface, ipaddress.IPv6Interface)):
        return value
    addr = getattr(value, "ip_address", None)
    if addr is not None:
        prefix = getattr(value, "prefix", None) if getattr(value, "prefix_id", None) else None
        length = str(prefix.cidr).split("/")[-1] if prefix is not None else None
        return ipaddress.ip_interface(f"{addr}/{length}" if length else addr)
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


def _env():
    from jinja2.sandbox import SandboxedEnvironment

    env = SandboxedEnvironment(
        trim_blocks=True, lstrip_blocks=True, autoescape=False
    )
    env.filters.update(FILTERS)
    env.tests.update(TESTS)
    return env


def _objects_for(template, tenant):
    from auth_api.object_types import model_for

    model = model_for(template.object_type)
    if model is None:
        return None
    qs = model.objects.all()
    if any(f.name == "tenant" for f in model._meta.concrete_fields):
        qs = qs.filter(tenant=tenant)
    return list(qs)


def render_export_template(template, tenant) -> str:
    """Render the template against its object type. Raises ``ValueError`` on a
    bad object type and ``jinja2.TemplateError`` on a template problem."""
    objects = _objects_for(template, tenant)
    if objects is None:
        raise ValueError(f"Unknown object type: {template.object_type}")

    tmpl = _env().from_string(template.template_code or "")
    return tmpl.render(objects=objects, queryset=objects, count=len(objects))


def render_device_config(template, device, tenant) -> str:
    """Render an export template for a single device - the per-device
    intended-config generator. Context: ``device``, its merged ``config_context``,
    ``interfaces``, ``ip_addresses`` (and ``objects``/``count`` for parity),
    plus every registered provider's key (``routing``)."""
    from .config_context import render_config_context

    tmpl = _env().from_string(template.template_code or "")
    return tmpl.render(
        device=device,
        config_context=render_config_context(device)["rendered"],
        interfaces=list(device.interfaces.all()),
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
