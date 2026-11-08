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

import contextvars
import ipaddress
import re
from collections.abc import Callable
from functools import cache

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

# Rows a template never walks: accounts, groups, grants and the rest of the
# access machinery, the change log, and the organisation and tenant rows
# that lead to every other tenant. Reached through a relation, a few of them
# still show a name (_OPEN_ATTRS) - what the API shows next to the row that
# links them.
_CLOSED_APPS = frozenset({"auth", "auth_api", "audit", "contenttypes", "sessions", "admin"})
_CLOSED_MODELS = frozenset({
    "core.organization", "core.tenant", "core.tenantgroup", "core.tenantsettings",
    "core.deploymentsettings", "core.bookmark", "core.bookmarkfolder",
    # An SLA's stored figures and rule snapshots carry its service credit
    # and every member's figure; the SLA API cuts them per viewer, which a
    # template walking the rows cannot.
    "monitoring.slaperiodresult", "monitoring.slaagreementrevision",
})
_OPEN_ATTRS = {
    "auth.user": frozenset({"id", "pk", "username", "first_name", "last_name"}),
    "auth.group": frozenset({"id", "pk", "name"}),
    "core.tenant": frozenset({"id", "pk", "name", "slug"}),
}
# What a template may do with a set of rows. Lookups are checked on the call:
# one field of that model, never a path through a relation.
_QUERYSET_ATTRS = frozenset({
    "all", "count", "exists", "first", "last", "filter", "exclude", "get",
    "order_by", "reverse", "distinct", "none",
})
_LOOKUP_METHODS = frozenset({"filter", "exclude", "get", "order_by"})


def _closed(model) -> bool:
    meta = model._meta
    return meta.app_label in _CLOSED_APPS or meta.label_lower in _CLOSED_MODELS


@cache
def _tenant_path(model, depth: int = 0) -> str | None:
    """The lookup from ``model`` to the tenant that owns its rows: its own
    ``tenant``, else the first parent that has one (an interface's device, a
    termination's cable). ``None`` for a model that belongs to no tenant."""
    fields = model._meta.concrete_fields
    if any(f.name == "tenant" and f.is_relation for f in fields):
        return "tenant"
    if depth >= 2:
        return None
    for f in fields:
        rel = f.related_model if f.is_relation and f.many_to_one else None
        if rel is None or rel is model or isinstance(rel, str):
            continue
        sub = _tenant_path(rel, depth + 1)
        if sub is not None:
            return f"{f.name}__{sub}"
    return None


def _template_environment_class():
    from django.db.models import Manager, Q, QuerySet
    from jinja2.sandbox import SandboxedEnvironment, SecurityError

    class _Environment(SandboxedEnvironment):
        """The sandbox plus what a template must never reach on a model row
        (#193): a secret-bearing field (``core.secret_fields`` - the same
        rule the audit trail and exports apply, so an encrypted webhook
        secret or an Authorization header cannot be printed), the PSK
        accessors, and the escape hatches from one row to every row - a
        manager's or queryset's ``model`` and any attribute of a model
        class, which would reach ``Model.objects`` across tenants.

        Accounts, groups, grants, the organisation and the tenant rows show
        a name at most, however they are reached. With a ``tenant`` the
        sandbox is fenced to it: a row of another tenant reads as nothing,
        and every set of rows a relation hands out is cut to the tenant -
        and, with a ``user``, to the rows that user may view. A lookup or an
        ordering names one field of the row, never a path through a
        relation, so a filter cannot test a row the fence hides."""

        def __init__(self, *args, tenant=None, user=None, **kwargs):
            super().__init__(*args, **kwargs)
            self._tenant = tenant
            self._tenant_id = getattr(tenant, "pk", tenant)
            self._user = user
            self._row_filters: dict = {}
            # The fields the API hides from this user (contract cost, SLA
            # credits, an address's device at another site), read from the
            # same table the serializers and the change log read. A render
            # nobody started (no user) is not narrowed, as in the API.
            self._gate = None
            if user is not None:
                from core.hidden_fields import RowFieldGate

                self._gate = RowFieldGate(user, tenant)

        # ── rows ───────────────────────────────────────────────────────
        def _row_open(self, obj, attr) -> bool:
            label = obj._meta.label_lower
            if _closed(type(obj)):
                if attr not in _OPEN_ATTRS.get(label, ()):
                    return False
                if label == "core.tenant" and self._tenant_id is not None:
                    return obj.pk == self._tenant_id
                return True
            if self._tenant_id is not None:
                tid = getattr(obj, "tenant_id", None)
                if tid is not None and tid != self._tenant_id:
                    return False
            return True

        def _value_open(self, value) -> bool:
            if isinstance(value, (Manager, QuerySet)):
                return not _closed(value.model)
            meta = getattr(value, "_meta", None)
            if meta is not None and hasattr(meta, "get_field") and not isinstance(value, type):
                return not _closed(type(value)) or meta.label_lower in _OPEN_ATTRS
            return True

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
            if isinstance(obj, (Manager, QuerySet)):
                return attr in _QUERYSET_ATTRS and not _closed(obj.model)
            meta = getattr(obj, "_meta", None)
            if meta is not None and hasattr(meta, "get_field"):
                if not self._row_open(obj, attr) or not self._value_open(value):
                    return False
                if self._gate is not None and self._gate.hides(obj, attr):
                    return False
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
            return self._value_open(value)

        # ── sets of rows ───────────────────────────────────────────────
        def _fence(self, value):
            """Cut a relation's rows to the tenant and to what the user may
            view. Idempotent, so a chained ``.filter()`` re-applies it."""
            if isinstance(value, Manager):
                value = value.all()
            if not isinstance(value, QuerySet):
                return value
            model = value.model
            if _closed(model):
                return value.none()
            if self._tenant_id is not None:
                path = _tenant_path(model)
                if path is not None:
                    value = value.filter(
                        Q(**{path: self._tenant_id}) | Q(**{f"{path}__isnull": True})
                    )
            user = self._user
            if user is not None and not getattr(user, "is_superuser", False):
                from auth_api import rbac
                from auth_api.object_types import is_registered

                slug = model._meta.model_name
                if is_registered(slug):
                    if slug not in self._row_filters:
                        self._row_filters[slug] = rbac.row_filter(
                            user, self._tenant, slug, "view"
                        )
                    q = self._row_filters[slug]
                    if q is None:
                        return value.none()
                    if q is not True:
                        value = value.filter(q)
            if self._gate is not None:
                value = self._gate.narrow(value)
            return value

        def _check_lookups(self, model, method, args, kwargs):
            """One field of ``model`` per lookup, plus that field's own
            lookups and transforms (``name__startswith``, ``site__in``) -
            never ``site__name``, which walks into another table."""
            from django.core.exceptions import FieldDoesNotExist

            from core.secret_fields import is_secret_field

            # Jinja adds its own scope to a call made inside a loop or a
            # block; Context.call takes them off before the method sees them.
            kwargs = {k: v for k, v in kwargs.items()
                      if k not in ("_loop_vars", "_block_vars")}
            if method == "order_by":
                if kwargs:
                    raise SecurityError("order_by() takes field names only.")
                keys = [str(a).lstrip("-") for a in args]
            else:
                if args:
                    raise SecurityError(f"{method}() takes field=value lookups only.")
                keys = list(kwargs)
            for key in keys:
                head, *rest = key.split("__")
                if head == "pk":
                    field = model._meta.pk
                else:
                    try:
                        field = model._meta.get_field(head)
                    except FieldDoesNotExist:
                        field = next(
                            (f for f in model._meta.concrete_fields if f.attname == head),
                            None,
                        )
                if field is None or not getattr(field, "concrete", False):
                    raise SecurityError(f"'{key}' is not a field of this row.")
                if is_secret_field(model, field) or (
                    self._gate is not None and self._gate.refuses_lookup(model, field.name)
                ):
                    raise SecurityError(f"'{key}' cannot be read.")
                if method == "order_by" and rest:
                    raise SecurityError(f"order_by('{key}') walks a relation.")
                for part in rest:
                    if field.get_lookup(part) is None and field.get_transform(part) is None:
                        raise SecurityError(f"'{key}' walks a relation.")

        def call(__self, __context, __obj, *args, **kwargs):  # noqa: N805
            target = getattr(__obj, "__self__", None)
            if isinstance(target, (Manager, QuerySet)) and (
                getattr(__obj, "__name__", "") in _LOOKUP_METHODS
            ):
                __self._check_lookups(target.model, __obj.__name__, args, kwargs)
            return __self._fence(super().call(__context, __obj, *args, **kwargs))

        def getattr(self, obj, attribute):
            return self._fence(super().getattr(obj, attribute))

        def getitem(self, obj, argument):
            return self._fence(super().getitem(obj, argument))

    return _Environment


# ─── Several files from one template ─────────────────────────────────────────
# A device template whose target path ends in ``/`` is a directory: its
# output is the files its ``{% file "name" %}…{% endfile %}`` blocks write,
# each landing at ``<target path><name>`` (one systemd ``.link`` per NIC,
# one WireGuard config per tunnel). The blocks go to a sink set for the
# length of one render; a render without one (a single-file template, a
# list export) refuses a file block.

#: Longest name one file block may carry, and most files one render may write.
MAX_FILE_NAME = 128
MAX_FILES = 256
#: The path a file is keyed by is stored in a 255-character column.
MAX_FILE_PATH = 255

_FILE_SINK: contextvars.ContextVar = contextvars.ContextVar("danbyte_file_sink", default=None)


def _file_block_error(message: str):
    from jinja2 import TemplateRuntimeError

    return TemplateRuntimeError(message)


def is_directory_target(template) -> bool:
    """Whether ``template`` renders a directory of files (its target path
    ends in ``/``) rather than one file."""
    return (getattr(template, "target_path", "") or "").endswith("/")


def check_file_name(name) -> str:
    """The plain file name a ``{% file %}`` block names, or a
    ``TemplateRuntimeError`` saying why not. A push tool writes these paths
    to disk, so nothing that leaves the directory gets through: no ``/`` or
    backslash, no ``.`` or ``..``, no control characters (NUL above all), no
    leading or trailing space."""
    if isinstance(name, bool) or not isinstance(name, (str, int)):
        raise _file_block_error("A file block's name must be text.")
    name = str(name)
    shown = repr(name[:60])
    if not name:
        raise _file_block_error("A file block's name is empty.")
    if name in (".", ".."):
        raise _file_block_error(f"{shown} is not a file name.")
    if "/" in name or "\\" in name:
        raise _file_block_error(
            f"File name {shown} has a path separator; a file block names a file in "
            "the template's directory, not a path."
        )
    if any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise _file_block_error(f"File name {shown} has a control character.")
    if name != name.strip():
        raise _file_block_error(f"File name {shown} starts or ends with a space.")
    if len(name) > MAX_FILE_NAME:
        raise _file_block_error(
            f"File name {shown} is longer than {MAX_FILE_NAME} characters."
        )
    return name


class _FileSink:
    """The files one directory render writes, in the order it writes them."""

    def __init__(self, directory: str):
        self.directory = directory
        self.files: dict[str, str] = {}
        self.open = False

    def add(self, name, caller) -> None:
        if self.open:
            raise _file_block_error("A file block cannot sit inside another.")
        name = check_file_name(name)
        if name in self.files:
            raise _file_block_error(f"Two file blocks are both named {name!r}.")
        if len(self.files) >= MAX_FILES:
            raise _file_block_error(f"More than {MAX_FILES} file blocks in one render.")
        if len(self.directory) + len(name) > MAX_FILE_PATH:
            raise _file_block_error(
                f"{self.directory}{name} is longer than {MAX_FILE_PATH} characters."
            )
        self.open = True
        try:
            self.files[name] = str(caller())
        finally:
            self.open = False


@cache
def _file_extension_class():
    from jinja2 import nodes
    from jinja2.ext import Extension

    class FileBlockExtension(Extension):
        """``{% file "11-gi1.link" %}…{% endfile %}``: the body is one file
        of a directory template, named by the expression."""

        tags = {"file"}

        def parse(self, parser):
            lineno = next(parser.stream).lineno
            name = parser.parse_expression()
            body = parser.parse_statements(("name:endfile",), drop_needle=True)
            self.environment.file_blocks = True
            return nodes.CallBlock(
                self.call_method("_file", [name]), [], [], body
            ).set_lineno(lineno)

        def _file(self, name, caller):
            sink = _FILE_SINK.get()
            if sink is None:
                raise _file_block_error(
                    "A file block needs a device template whose target path ends "
                    "in / (a directory)."
                )
            sink.add(name, caller)
            return ""

    return FileBlockExtension


def _env(tenant=None, user=None):
    """The sandbox for rendering. ``tenant`` fences every row a template
    reaches to that tenant; ``user`` further cuts each relation to the rows
    that user may view. Compiling a template (no render) needs neither.
    After compiling, ``env.file_blocks`` says whether the source used a
    ``{% file %}`` block."""
    env = _template_environment_class()(
        trim_blocks=True, lstrip_blocks=True, autoescape=False,
        tenant=tenant, user=user, extensions=[_file_extension_class()],
    )
    env.file_blocks = False
    env.filters.update(FILTERS)
    env.tests.update(TESTS)
    return env


def template_subject_allowed(model) -> bool:
    """Accounts, groups, grants and the organisation's rows are not a
    template's subject: the sandbox shows them by name at most. A tenant is,
    as the one the render runs in."""
    if model is None:
        return False
    return not _closed(model) or model._meta.label_lower == "core.tenant"


def has_secret_fields(model) -> bool:
    """Whether ``model`` carries a credential at all - a secret field, or an
    accessor that reads one out of the secret store. Such a type is not
    offered to export or label templates as a subject."""
    from core.secret_fields import model_holds_secret

    return model_holds_secret(model)


#: Rows one render may loop over - the same bound the XLSX export has. Past
#: it the render is refused with the count, rather than loading the table
#: into a web worker and building the whole output as one string (#224).
MAX_TEMPLATE_ROWS = 50000
#: The editor's preview renders at most this many rows; ``count`` still says
#: how many the real render would see.
PREVIEW_ROWS = 200


def _objects_for(template, tenant, user=None, *, limit=None):
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
    if not template_subject_allowed(model):
        raise ValueError(f"{template.object_type} cannot be exported by template.")
    qs = model.objects.all()
    if any(f.name == "tenant" for f in model._meta.concrete_fields):
        qs = qs.filter(tenant=tenant)
    elif model._meta.label_lower == "core.tenant":
        qs = qs.filter(pk=getattr(tenant, "pk", None))
    if user is None:
        return []
    qs = rbac.restrict_queryset(qs, user, tenant, template.object_type, "view")
    # A row whose text names a relation the user may not view is left out,
    # as the sandbox leaves it out of every relation (core.hidden_fields).
    from core.hidden_fields import RowFieldGate

    qs = RowFieldGate(user, tenant).narrow(qs)
    total = qs.count()
    if limit is None and total > MAX_TEMPLATE_ROWS:
        raise ValueError(
            f"{total} {model._meta.verbose_name_plural} is more than one render "
            f"can take ({MAX_TEMPLATE_ROWS}). Use the list export for the whole "
            f"table, or a template on a narrower type."
        )
    # Every to-one relation joined in one go: a template that prints
    # {{ obj.site.name }} otherwise costs a query per row.
    fks = [
        f.name for f in model._meta.concrete_fields
        if f.is_relation and f.many_to_one
    ]
    qs = qs.select_related(*fks)
    if limit is not None:
        qs = qs[:limit]
    rows = list(qs.iterator(chunk_size=500)) if limit is None else list(qs)
    return _Rows(rows, total)


class _Rows(list):
    """The rows a template loops over, plus the true total when the list was
    cut short (a preview), so ``count`` never lies."""

    def __init__(self, rows, total):
        super().__init__(rows)
        self.total = total


def render_export_template(template, tenant, user=None, *, preview=False) -> str:
    """Render the template against its object type, over the rows ``user``
    may view. Raises ``ValueError`` on a bad object type or too many rows,
    and ``jinja2.TemplateError`` on a template problem. ``preview`` renders
    the first ``PREVIEW_ROWS`` only - the editor refreshes on every change."""
    objects = _objects_for(
        template, tenant, user, limit=PREVIEW_ROWS if preview else None
    )
    if objects is None:
        raise ValueError(f"Unknown object type: {template.object_type}")

    total = getattr(objects, "total", len(objects))
    env = _env(tenant, user)
    if env._gate is not None:
        env._gate.prime(objects)
    tmpl = env.from_string(template.template_code or "")
    return tmpl.render(objects=objects, queryset=objects, count=total)


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


def link_peer_of(iface, visible=None) -> dict | None:
    """The far end of ``iface``'s cable, as a template may read it.

    ``{"device", "interface", "description", "mac_address", "mtu",
    "custom_fields"}`` - the peer's name, its port, the port's MAC and MTU,
    and its own fields (a ``frr_name`` custom field, say), or
    ``None`` when the port is uncabled or the cable ends off-device. Read-only
    by construction: it is a plain dict, so a template cannot reach the peer
    row or anything hanging off it. ``visible`` is the device ids the reader
    may view (None = all): a peer outside it names nothing and carries
    ``hidden`` (#473).
    """
    for term in iface.terminations.all():
        for other in term.cable.terminations.all():
            if other.pk == term.pk:
                continue
            peer = other.interface
            if peer is None:
                return None
            if visible is not None and peer.device_id not in visible:
                return {
                    "device": "", "interface": "", "description": "",
                    "mac_address": "", "mtu": None, "custom_fields": {}, "hidden": True,
                }
            return {
                "device": peer.device.name,
                "interface": peer.name,
                "description": peer.description or "",
                "mac_address": peer.mac_address or "",
                "mtu": peer.mtu,
                "custom_fields": dict(peer.custom_fields or {}),
            }
    return None


#: What ``link_peer_of`` reads, so a device's ports cost one query, not one
#: per port.
LINK_PEER_PREFETCH = "terminations__cable__terminations__interface__device"


def device_render_interfaces(device, tenant=None, user=None) -> list:
    """The device's interfaces with ``link_peer`` attached to each; for a
    render run by ``user``, a peer they may not view is hidden."""
    visible = None
    if user is not None:
        from .port_state import visible_device_ids

        visible = visible_device_ids(user, tenant or device.tenant)
    rows = list(device.interfaces.prefetch_related(LINK_PEER_PREFETCH))
    for iface in rows:
        iface.link_peer = link_peer_of(iface, visible)
    return rows


def _render_ips(obj, tenant, user) -> list:
    """The object's addresses for a render: those ``user`` may view, when the
    render runs for someone; every one in the tenant for a system render."""
    ips = obj.ip_addresses.filter(tenant=tenant)
    if user is None:
        return list(ips)
    from auth_api import rbac

    return list(rbac.restrict_queryset(ips, user, tenant, "ipaddress", "view"))


def _backing_vm(device, tenant, user):
    """The build spec of the VM ``device`` runs as (``api.vm_build``), when
    there is one the reader may view; else ``None``."""
    from .models import VirtualMachine
    from .vm_build import vm_build_spec

    qs = VirtualMachine.objects.filter(represents_device=device, tenant=tenant)
    if user is not None:
        from auth_api import rbac

        qs = rbac.restrict_queryset(qs, user, tenant, "virtualmachine", "view")
    vm = qs.select_related("cluster", "device", "represents_device").first()
    return vm_build_spec(vm, user, tenant) if vm is not None else None


def render_device_config(template, device, tenant, user=None) -> str:
    """One device's render of a single-file template, as text. A directory
    template (target path ending in ``/``) writes several files: render it
    with :func:`render_device_files` instead."""
    if is_directory_target(template):
        raise ValueError(
            f"{template.name} renders a directory of files (its target path ends "
            "in /); render it per file."
        )
    return _render_device(template, device, tenant, user)


def render_device_files(template, device, tenant, user=None) -> list[tuple[str, str]]:
    """The files a directory template writes for one device, as ``(name,
    text)`` in the order its blocks ran. Text outside every file block is an
    error unless it is only whitespace: it would otherwise vanish without a
    word, and is most often a forgotten ``{% file %}``. No file blocks at all
    is an empty list - a device with nothing to write."""
    if not is_directory_target(template):
        raise ValueError(f"{template.name} renders one file, not a directory.")
    sink = _FileSink(template.target_path)
    token = _FILE_SINK.set(sink)
    try:
        rest = _render_device(template, device, tenant, user)
    finally:
        _FILE_SINK.reset(token)
    stray = (rest or "").strip()
    if stray:
        raise _file_block_error(
            f"Text outside a file block: {stray[:40]!r}. In a directory template "
            "everything goes inside {% file %} … {% endfile %}."
        )
    return list(sink.files.items())


def _render_device(template, device, tenant, user=None) -> str:
    """Render an export template for a single device - the per-device
    intended-config generator. Context: ``device``, its merged ``config_context``,
    ``interfaces`` (each with ``link_peer``, the cable's far end),
    ``ip_addresses`` (and ``objects``/``count`` for parity), ``backing_vm``
    (the build spec of the VM the device runs as, or ``None``), plus every
    registered provider's key (``routing``).

    ``user`` is who the render is for: relations a template walks hold only
    the rows they may view, as in an export. Leave it out only for a render
    nobody started."""
    from .config_context import render_config_context

    tenant = tenant or device.tenant
    tmpl = _env(tenant, user).from_string(template.template_code or "")
    return tmpl.render(
        device=device,
        config_context=render_config_context(device)["rendered"],
        interfaces=device_render_interfaces(device, tenant, user),
        ip_addresses=_render_ips(device, tenant, user),
        backing_vm=_backing_vm(device, tenant, user),
        objects=[device],
        count=1,
        **provider_context(device),
    )


def render_vm_config(template, vm, tenant, user=None) -> str:
    """Render an export template for a single virtual machine - the per-VM
    generator behind the Terraform-for-VMs flow (the template author writes
    tfvars/HCL). Context mirrors the device renderer: ``vm`` (also exposed as
    ``device`` for template parity), merged ``config_context``, ``interfaces``
    (in slot order), ``disks``, ``ip_addresses``, ``represents_device``
    (``{id, name}`` or ``None``) and ``build``, the plain build spec a
    provision sends (``api.vm_build``). ``user`` limits what the template
    sees, as for devices."""
    from .config_context import render_config_context
    from .vm_build import _iface_order, vm_build_spec

    tenant = tenant or vm.tenant
    tmpl = _env(tenant, user).from_string(template.template_code or "")
    build = vm_build_spec(vm, user, tenant)
    return tmpl.render(
        vm=vm,
        device=vm,  # parity: templates can use the same `device.*` accessor
        config_context=render_config_context(vm)["rendered"],
        interfaces=sorted(vm.interfaces.all(), key=_iface_order),
        disks=list(vm.disks.all()),
        ip_addresses=_render_ips(vm, tenant, user),
        represents_device=build["represents_device"],
        build=build,
        objects=[vm],
        count=1,
        **provider_context(vm),
    )


# ─── Per-object render for any template type (C1) ────────────────────────────
# A list render loops over every row of the type; these render one object.
# Device and VM keep their own renderers above; any other type gets the
# object under its type name plus whatever context hook the type registers.

def _restricted(qs, user, tenant, slug):
    """``qs`` narrowed to what ``user`` may view (``None`` = a system
    render, unnarrowed)."""
    if user is None:
        return qs
    from auth_api import rbac

    return rbac.restrict_queryset(qs, user, tenant, slug, "view")


def _cluster_context(cluster, tenant, user) -> dict:
    """``hosts`` (devices in the cluster, and hosts its VMs run on),
    ``virtual_machines``, ``vm_groups``: each only the rows ``user`` may view."""
    from django.db.models import Q

    from .models import Device, VirtualMachine, VirtualMachineGroup

    vms = list(
        _restricted(
            VirtualMachine.objects.filter(tenant=tenant, cluster=cluster),
            user, tenant, "virtualmachine",
        ).select_related("device", "group", "role", "platform", "status", "primary_ip")
        .order_by("name")
    )
    hosts = list(
        _restricted(
            Device.objects.filter(tenant=tenant).filter(
                Q(cluster=cluster) | Q(virtual_machines__cluster=cluster)
            ).distinct(),
            user, tenant, "device",
        ).select_related("role", "platform", "status", "primary_ip")
        .order_by("name")
    )
    groups = list(
        _restricted(
            VirtualMachineGroup.objects.filter(tenant=tenant, cluster=cluster),
            user, tenant, "virtualmachinegroup",
        ).order_by("name")
    )
    return {"hosts": hosts, "virtual_machines": vms, "vm_groups": groups}


#: object_type slug -> fn(obj, tenant, user) -> extra render context. A
#: plugin may add its own with :func:`register_object_context`.
_OBJECT_CONTEXTS = {"cluster": _cluster_context}


def register_object_context(slug: str, fn) -> None:
    _OBJECT_CONTEXTS[slug] = fn


def object_for(template, tenant, user, object_id):
    """The one row of the template's type that ``object_id`` names, when
    ``user`` may view it - the same tenant, row, site and field gates a list
    render applies. ``None`` when it is unknown or out of reach; a
    ``ValueError`` when the type cannot be a template's subject."""
    import uuid

    from auth_api.object_types import model_for

    model = model_for(template.object_type)
    if model is None:
        raise ValueError(f"Unknown object type: {template.object_type}")
    if has_secret_fields(model):
        raise ValueError(
            f"{template.object_type} carries credentials and cannot be exported by template."
        )
    if not template_subject_allowed(model):
        raise ValueError(f"{template.object_type} cannot be exported by template.")
    try:
        pk = uuid.UUID(str(object_id))
    except (TypeError, ValueError):
        return None
    if user is None:
        return None
    qs = model.objects.filter(pk=pk)
    if any(f.name == "tenant" for f in model._meta.concrete_fields):
        qs = qs.filter(tenant=tenant)
    elif model._meta.label_lower == "core.tenant":
        qs = qs.filter(pk=getattr(tenant, "pk", None))
    else:
        # A type with no tenant of its own has no per-object render: there
        # is no fence to hold it to the caller's tenant.
        return None
    from auth_api import rbac
    from core.hidden_fields import RowFieldGate

    qs = rbac.restrict_queryset(qs, user, tenant, template.object_type, "view")
    qs = RowFieldGate(user, tenant).narrow(qs)
    return qs.first()


def render_object_config(template, obj, tenant, user=None) -> str:
    """Render ``template`` for the one object ``obj``. Devices and VMs use
    their own renderers; any other type sees ``obj`` under its type name
    (``cluster``) and as ``object``, ``objects=[obj]``, ``count=1``, and the
    keys its context hook adds."""
    slug = template.object_type
    if slug == "device":
        return render_device_config(template, obj, tenant, user)
    if slug == "virtualmachine":
        return render_vm_config(template, obj, tenant, user)
    env = _env(tenant, user)
    if env._gate is not None:
        env._gate.prime([obj])
    extra = {}
    hook = _OBJECT_CONTEXTS.get(slug)
    if hook is not None:
        extra = hook(obj, tenant, user)
    tmpl = env.from_string(template.template_code or "")
    return tmpl.render(
        **{slug: obj}, object=obj, objects=[obj], queryset=[obj], count=1, **extra,
    )
