"""Model signals that keep load-bearing constraints satisfiable.

Nothing here implements product behaviour - each receiver exists because a
constraint the schema deliberately enforces would otherwise make an ordinary
operation impossible.
"""

import logging

from django.db.models.signals import post_delete, pre_delete
from django.dispatch import receiver

log = logging.getLogger(__name__)


@receiver(pre_delete, sender="api.Interface", dispatch_uid="api.release_macs")
def release_macs_before_interface_delete(sender, instance, **kwargs):
    """Keep an interface's MACs from colliding as they are orphaned.

    ``MACAddress.assigned_interface`` is ``SET_NULL`` so a MAC outlives the
    port that bore it - it's a first-class object with its own tags and
    history. But ``uniq_macaddress_tenant_addr_iface`` spans
    ``(tenant, mac_address, assigned_interface)`` with ``nulls_distinct=False``,
    so NULL counts as a value: at most one *unassigned* row per address per
    tenant. Orphaning a MAC that already exists unassigned - routine once
    discovery has seen the same address twice - violates it, and the delete
    fails with a 409 that no amount of retrying fixes.

    So decide per MAC, before the cascade's own UPDATE runs:

    * an unassigned twin already exists → drop this row, the address is
      already on file unassigned;
    * otherwise → unassign it here, so it becomes that twin.

    Unassigning eagerly (rather than leaving it to the cascade) is what makes
    a batch safe: when two interfaces in one delete bear the same MAC, the
    second receiver call sees the first one's now-unassigned row and drops its
    duplicate instead of racing it to NULL. The cascade's later UPDATE then
    either re-NULLs a row that is already NULL or matches nothing - both
    no-ops.

    Instance-level ``delete()``/``save()`` are deliberate: they keep the audit
    trail honest about a MAC that was dropped or unassigned.
    """
    from .models import MACAddress

    for mac in instance.mac_addresses.all():
        twin_exists = (
            MACAddress.objects.filter(
                tenant_id=mac.tenant_id,
                mac_address=mac.mac_address,
                assigned_interface__isnull=True,
            )
            .exclude(pk=mac.pk)
            .exists()
        )
        if twin_exists:
            log.info(
                "Dropping MAC %s from deleted interface %s - already on file "
                "unassigned for this tenant.",
                mac.mac_address,
                instance.pk,
            )
            mac.delete()
        else:
            mac.assigned_interface = None
            mac.save(update_fields=["assigned_interface", "updated_at"])


@receiver(post_delete, sender="api.CableTermination", dispatch_uid="api.no_half_cables")
def delete_cable_left_with_an_empty_end(sender, instance, origin=None, **kwargs):
    """A cable whose port went away with its device, module or the port
    itself goes too, when that was the last port on its end (#378): a cable
    with one end is not a cable. A breakout that loses one leg keeps the rest.

    Not when the delete started at the cable or its terminations (an update
    replacing an end deletes the old terminations first), nor at a tenant or
    organization, whose delete removes the cables itself. Instance-level
    ``delete()`` so the change log records the cable going."""
    from core.models import Organization, Tenant

    from .models import Cable, CableTermination

    origin_model = getattr(origin, "model", None) or type(origin)
    if origin is None or origin_model in (Cable, CableTermination, Tenant, Organization):
        return
    if CableTermination.objects.filter(cable_id=instance.cable_id, end=instance.end).exists():
        return
    cable = Cable.objects.filter(pk=instance.cable_id).first()
    if cable is not None:
        cable.delete()


@receiver(post_delete, sender="api.FloorPlanDrawing", dispatch_uid="api.drawing_files")
def delete_drawing_files(sender, instance, **kwargs):
    """A plan's CAD drawing takes its files with it - whether it was removed
    on its own or with its plan, location or tenant. After commit, so a
    rolled-back delete keeps them."""
    from django.db import transaction

    from .cad_render import delete_folder

    plan_id = instance.floor_plan_id
    transaction.on_commit(lambda: delete_folder(plan_id))
