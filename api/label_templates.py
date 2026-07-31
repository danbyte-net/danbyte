"""Label rendering — per-object Jinja2 in a sandbox.

Renders one :class:`~api.models.LabelTemplate` against a single object into a
sized HTML label. Uses Jinja's ``SandboxedEnvironment`` (like
:mod:`api.export_templates`) so a template can't reach code-exec/mutating
attributes, and — unlike export configs — with **autoescape on** so a field value
containing markup is escaped, not injected. The rendered HTML is still shown
inside a scriptless ``<iframe sandbox>`` on the frontend as defence in depth.
"""
from __future__ import annotations

# object_type slug (model_name) → frontend detail route prefix, so `{{ url }}`
# and the default QR resolve to the object's page. Only the labelable types need
# an entry; anything else falls back to the origin.
FRONTEND_ROUTES = {
    "device": "/devices",
    "rack": "/racks",
    "ipaddress": "/ip-addresses",
    "interface": "/interfaces",
    "cable": "/cables",
    "inventoryitem": "/inventory-items",
    "site": "/sites",
    "location": "/locations",
    "powerfeed": "/power-feeds",
    "powerpanel": "/power-panels",
    "circuit": "/circuits",
    "virtualmachine": "/virtual-machines",
    "prefix": "/prefixes",
}

# Relations worth exposing to a label template when the object has them.
_RELATIONS = (
    "site", "rack", "location", "tenant", "role", "status", "platform",
    "device_type", "manufacturer", "primary_ip", "primary_ip4", "primary_ip6",
    "device", "interfaces", "ip_addresses",
)


def available_fields(object_type) -> dict | None:
    """The token tree offered to the label editor for ``object_type``.

    Returns ``{"object", "tokens", "special"}`` where ``tokens`` are
    ``{{ device.name }}``-style references the author can click to insert — the
    object's own fields, a few curated one-hop relations, and any custom fields.
    Derived from the model so it tracks the schema instead of a hard-coded list.
    """
    from auth_api.object_types import model_for

    model = model_for(object_type)
    if model is None:
        return None
    name = model._meta.model_name
    tokens: list[str] = []
    for f in model._meta.concrete_fields:
        # FK → offer the common `.name`/`.address` sub-attr, not the raw id.
        if f.is_relation:
            tokens.append(f"{name}.{f.name}.name")
        else:
            tokens.append(f"{name}.{f.name}")
    # Curated one-hop relations that aren't concrete FKs on the row.
    for rel in ("primary_ip", "site", "rack", "tenant", "role", "status"):
        if hasattr(model, rel):
            tokens.append(f"{name}.{rel}.name")
    # Custom fields live under a dict accessor on most models.
    if hasattr(model, "custom_fields"):
        tokens.append(f"{name}.custom_fields")
    return {
        "object": name,
        "tokens": sorted(set(tokens)),
        # Always in the render context regardless of object type.
        "special": ["url", "qr", "obj"],
    }


def detail_path(obj) -> str:
    """Frontend detail path for an object, e.g. ``/devices/<id>`` (or "")."""
    prefix = FRONTEND_ROUTES.get(obj._meta.model_name)
    return f"{prefix}/{obj.pk}" if prefix else ""


def _context(obj, url: str) -> dict:
    """Template context: the object under its type name, plus `obj`, `url`, and
    common relations (managers materialised to lists)."""
    ctx = {obj._meta.model_name: obj, "obj": obj, "url": url}
    for attr in _RELATIONS:
        if attr in ctx or not hasattr(obj, attr):
            continue
        try:
            val = getattr(obj, attr)
        except Exception:  # noqa: BLE001 — a missing FK etc. just isn't exposed
            continue
        if hasattr(val, "all"):  # a related manager
            try:
                val = list(val.all())
            except Exception:  # noqa: BLE001
                continue
        ctx[attr] = val
    return ctx


def render_label(template, obj, *, base_url: str = "") -> dict:
    """Render ``template`` against ``obj``. Returns ``{"html", "qr"}``.

    ``base_url`` (scheme+host) is prepended to the object's detail path for
    ``{{ url }}`` and for the default QR. Raises ``jinja2.TemplateError`` on a
    template problem.
    """
    from jinja2.sandbox import SandboxedEnvironment

    url = f"{base_url}{detail_path(obj)}" if base_url else detail_path(obj)
    ctx = _context(obj, url)

    # HTML body: autoescape ON so a field value with markup is escaped, not
    # injected into the label.
    html_env = SandboxedEnvironment(
        trim_blocks=True, lstrip_blocks=True, autoescape=True
    )
    html = html_env.from_string(template.template_html or "").render(**ctx)

    if template.qr_content:
        # The QR payload is a scannable string, NOT HTML — render it with
        # autoescape OFF so e.g. a name with `<`/`&` encodes verbatim in the QR
        # instead of as `&lt;`/`&amp;`.
        qr_env = SandboxedEnvironment(autoescape=False)
        qr = qr_env.from_string(template.qr_content).render(**ctx)
    else:
        qr = url  # default: the object's own URL
    return {"html": html, "qr": qr}
