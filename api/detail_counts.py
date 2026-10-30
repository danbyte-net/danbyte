"""Tab counts for the device and VM detail reads, as annotations.

The detail payload carries a ``*_count`` per collection tab (#165). Read one
getter at a time they cost a ``COUNT`` query each - two dozen on a device -
so the detail viewsets annotate them onto the row instead: every figure a
correlated subquery in the one query that reads the object. The serializer
getters prefer ``<field>_annotated`` and keep their own query for a row read
without it (a write's response).

The figures match the getters: every row hanging off the object, as the tabs
list them.
"""
from __future__ import annotations

from django.db.models import CharField, Count, OuterRef, Subquery
from django.db.models.functions import Cast, Coalesce


def count_of(model, fk: str, **extra):
    """``COUNT(*)`` of ``model`` rows pointing at the outer row through
    ``fk``, as a correlated subquery (0 when none) - the shape a list page
    annotates so a figure per row does not become a query per row. ``extra``
    narrows the rows further."""
    return Coalesce(
        Subquery(
            model.objects.filter(**{fk: OuterRef("pk")}, **extra)
            .order_by()
            .values(fk)
            .annotate(n=Count("pk"))
            .values("n")
        ),
        0,
    )


def _labelled(model, label: str, *, text: bool):
    """Rows of a generic ``object_type`` + ``object_id`` model naming the
    outer row. ``text`` when ``object_id`` is a string column."""
    ref = Cast(OuterRef("pk"), CharField()) if text else OuterRef("pk")
    return Coalesce(
        Subquery(
            model.objects.filter(object_type=label, object_id=ref)
            .order_by()
            .values("object_type")
            .annotate(n=Count("pk"))
            .values("n")
        ),
        0,
    )


def _rev(model, *accessors: str):
    """The summed counts of ``model``'s reverse relations ``accessors``."""
    total = None
    for accessor in accessors:
        rel = model._meta.get_field(accessor)
        expr = count_of(rel.related_model, rel.field.name)
        total = expr if total is None else total + expr
    return total


def _routing(model):
    """Static routes, protocol instances and BGP sessions - the Routing tab
    (the VTEP is added for a device)."""
    from routing.models import BGPSession

    owner = model._meta.get_field("bgpinstances").field.name
    return _rev(
        model, "static_routes", "bgpinstances", "ospfinstances", "isisinstances",
        "eigrpinstances",
    ) + count_of(BGPSession, f"instance__{owner}")


def device_annotations() -> dict:
    """``<field>_annotated`` for every detail-only count on DeviceSerializer,
    plus the stack's member count."""
    from monitoring.models import CertificateAssignment

    from .models import ContactAssignment, Device, Document, ImageAttachment

    return {
        "hardware_count_annotated": _rev(
            Device, "device_bays", "module_bays", "modules", "inventory_items", "antennas",
        ),
        "front_port_count_annotated": _rev(Device, "front_ports"),
        "rear_port_count_annotated": _rev(Device, "rear_ports"),
        "console_count_annotated": _rev(Device, "console_ports", "console_server_ports"),
        "power_count_annotated": _rev(Device, "power_ports", "power_outlets"),
        "cooling_count_annotated": _rev(Device, "cooling_intakes", "cooling_outflows"),
        "service_count_annotated": _rev(Device, "services"),
        "routing_count_annotated": _routing(Device) + _rev(Device, "vtep"),
        # By the content type's natural key, so building this costs no query.
        "image_count_annotated": count_of(
            ImageAttachment, "object_id",
            content_type__app_label="api", content_type__model="device",
        ),
        "certificate_count_annotated": (
            _labelled(CertificateAssignment, "api.device", text=True)
            + _rev(Device, "ssh_host_keys")
        ),
        "contact_count_annotated": _labelled(ContactAssignment, "api.device", text=True),
        "document_count_annotated": _labelled(Document, "api.device", text=False),
        "vc_member_count_annotated": Coalesce(
            Subquery(
                Device.objects.filter(virtual_chassis_id=OuterRef("virtual_chassis_id"))
                .order_by()
                .values("virtual_chassis_id")
                .annotate(n=Count("pk"))
                .values("n")
            ),
            0,
        ),
    }


def vm_annotations() -> dict:
    """``<field>_annotated`` for every detail-only count on
    VirtualMachineSerializer."""
    from monitoring.models import CertificateAssignment

    from .models import VirtualMachine

    return {
        "interface_count_annotated": _rev(VirtualMachine, "interfaces"),
        "disk_count_annotated": _rev(VirtualMachine, "disks"),
        "service_count_annotated": _rev(VirtualMachine, "services"),
        "routing_count_annotated": _routing(VirtualMachine),
        "certificate_count_annotated": _labelled(
            CertificateAssignment, "api.virtualmachine", text=True,
        ),
    }


def annotated(obj, field: str):
    """``obj``'s ``<field>_annotated``, or None when the row came without it."""
    return getattr(obj, f"{field}_annotated", None)
