"""Plugin discovery + version gating — runs at settings-import time.

Deliberately **Django-app-registry-free**: this module is imported from
``danbyte/settings.py`` *before* Django builds the application registry, so it
must not touch ``django.apps.apps`` or any model. It only reads plain class
attributes off each plugin's ``AppConfig`` subclass (metadata), which is safe
this early.

Contract for a plugin package (documented in ``docs/architecture/plugins.md``):

* It is an importable Python package listed in the ``PLUGINS`` setting.
* Its ``apps.py`` defines exactly one ``plugins.base.DanbytePluginConfig``
  subclass (or the package ``__init__`` exposes it as ``config``).
* The package and its ``apps.py`` are **import-safe** — no model imports at
  module top level (the same rule Django already imposes on ``apps.py``).

One broken or incompatible plugin never aborts boot: it is recorded in the load
report with a ``state`` of ``error`` / ``incompatible`` and simply left out of
``INSTALLED_APPS`` — mirroring the "unknown kind degrades, never crashes"
philosophy used by the monitoring check engine.
"""
from __future__ import annotations

import importlib
import inspect
from dataclasses import dataclass, field

from packaging.version import InvalidVersion, Version


@dataclass
class PluginStatus:
    """One plugin's discovery outcome — surfaced verbatim by ``/api/plugins/``."""

    module: str
    slug: str = ""
    name: str = ""
    version: str = ""
    author: str = ""
    description: str = ""
    state: str = "loaded"  # loaded | incompatible | error
    error: str = ""
    min_version: str | None = None
    max_version: str | None = None


@dataclass
class LoadResult:
    # Dotted ``AppConfig`` paths to append to INSTALLED_APPS (loaded plugins).
    enabled: list[str] = field(default_factory=list)
    # Every plugin's outcome (loaded/incompatible/error), for the report API.
    report: list[PluginStatus] = field(default_factory=list)


def _find_config_class(module_name: str):
    """Locate a plugin's ``DanbytePluginConfig`` subclass.

    Prefers ``<pkg>.config`` (NetBox-style), else scans ``<pkg>.apps`` for the
    single ``DanbytePluginConfig`` subclass. Importing ``plugins.base`` here is
    safe — it only defines a class deriving from ``django.apps.AppConfig``.
    """
    from plugins.base import DanbytePluginConfig

    pkg = importlib.import_module(module_name)
    explicit = getattr(pkg, "config", None)
    if inspect.isclass(explicit) and issubclass(explicit, DanbytePluginConfig):
        return explicit

    apps_mod = importlib.import_module(f"{module_name}.apps")
    candidates = [
        obj
        for _, obj in inspect.getmembers(apps_mod, inspect.isclass)
        if issubclass(obj, DanbytePluginConfig)
        and obj is not DanbytePluginConfig
        and obj.__module__ == apps_mod.__name__
    ]
    if not candidates:
        raise LookupError(
            f"{module_name}: no DanbytePluginConfig subclass in {module_name}.apps"
        )
    if len(candidates) > 1:
        raise LookupError(
            f"{module_name}: multiple DanbytePluginConfig subclasses "
            f"({', '.join(c.__name__ for c in candidates)}) — expected one"
        )
    return candidates[0]


def _compatible(current: str, minimum: str | None, maximum: str | None) -> tuple[bool, str]:
    """Is ``current`` within the plugin's [min, max] Danbyte version window?"""
    try:
        cur = Version(current)
        if minimum is not None and cur < Version(minimum):
            return False, f"requires Danbyte >= {minimum} (running {current})"
        if maximum is not None and cur > Version(maximum):
            return False, f"requires Danbyte <= {maximum} (running {current})"
    except InvalidVersion as exc:
        return False, f"unparseable version bound: {exc}"
    return True, ""


def discover(plugin_modules: list[str], danbyte_version: str) -> LoadResult:
    """Resolve the ``PLUGINS`` list into loadable apps + a status report.

    Called once from ``danbyte/settings.py``. Never raises for a single bad
    plugin — failures land in the report and are excluded from ``enabled``.
    """
    result = LoadResult()
    seen: set[str] = set()

    for raw in plugin_modules:
        module = (raw or "").strip()
        if not module or module in seen:
            continue
        seen.add(module)

        try:
            config = _find_config_class(module)
        except Exception as exc:  # noqa: BLE001 — one bad plugin must not kill boot
            result.report.append(
                PluginStatus(module=module, state="error", error=str(exc))
            )
            continue

        slug = getattr(config, "slug", None) or getattr(config, "label", "") or module
        status = PluginStatus(
            module=module,
            slug=slug,
            name=getattr(config, "verbose_name", "") or slug,
            version=str(getattr(config, "version", "") or ""),
            author=getattr(config, "author", "") or "",
            description=getattr(config, "description", "") or "",
            min_version=getattr(config, "min_version", None),
            max_version=getattr(config, "max_version", None),
        )

        ok, why = _compatible(danbyte_version, status.min_version, status.max_version)
        if not ok:
            status.state = "incompatible"
            status.error = why
            result.report.append(status)
            continue

        result.enabled.append(f"{config.__module__}.{config.__qualname__}")
        result.report.append(status)

    return result
