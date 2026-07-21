"""Dynamic audit registration — the one auditing hook a plugin can't self-join.

Change-log signals for the built-in ``AUDITED_MODELS`` are wired in
``AuditConfig.ready()``. A plugin's ``danbyte_plugin`` module runs *after* that
(plugin apps load last), so ``register_audited_model`` connects the signals for
the given model immediately. ``audit.signals.connect`` is idempotent
(``dispatch_uid``), so a double-connect is harmless.
"""
from __future__ import annotations

# Models registered at runtime (by plugins), kept so AuditConfig.ready() also
# picks up any registered before it ran.
_DYNAMIC_AUDITED: list[str] = []


def register_audited_model(model_path: str) -> None:
    """Record ``"app_label.ModelName"``'s mutations in the change log.

    Idempotent. Connects the signals now if the model already resolves (the
    normal case when called from a plugin's ``danbyte_plugin`` module).
    """
    from .apps import AUDITED_MODELS

    if model_path in AUDITED_MODELS or model_path in _DYNAMIC_AUDITED:
        return
    _DYNAMIC_AUDITED.append(model_path)

    from django.apps import apps as django_apps

    try:
        model = django_apps.get_model(*model_path.split("."))
    except (LookupError, ValueError):
        return  # app not ready yet; AuditConfig.ready() will connect it later
    from . import signals

    signals.connect([model])
