"""The provision event's audit trail.

Provisioning changes no Danbyte row, so no model signal would log it. The
request is written to the change log on the VM, as a reveal or a terminal
session is: who asked for which VM to be built, through which runner.
"""
from __future__ import annotations


def audit_provision(request, vm, target, run, *, retry_of=None) -> None:
    from audit.context import current_request_id, current_via
    from audit.models import ChangeAction, ChangeLogEntry
    from audit.site_capture import entry_site_id

    user = getattr(request, "user", None)
    authed = bool(user and user.is_authenticated)
    changes = {"target": target.name, "run": str(run.id), "event": run.event}
    if retry_of is not None:
        changes["retry_of"] = str(retry_of.id)
    ChangeLogEntry.objects.create(
        tenant_id=vm.tenant_id,
        user=user if authed else None,
        user_name=user.get_username() if authed else "",
        action=ChangeAction.PROVISION,
        object_type=vm._meta.label_lower,
        object_label=vm._meta.verbose_name.title(),
        object_id=str(vm.pk),
        object_repr=str(vm),
        object_site_id=entry_site_id(vm),
        changes=changes,
        request_id=current_request_id(),
        via=current_via() or "system",
    )
