"""Applications and installed software (#436): cycles and end-of-life
mappings.

An application may name an end-of-life product (``eol_source`` +
``eol_product``). Each install's version then picks the product's release
cycle (``compliance.eol.suggest_cycle``: "16.4" → "16"), unless someone set
the cycle by hand. Installs of one application on one cycle share one
:class:`~compliance.models.EolMapping`, made on first use and filled from
the cached catalog; the daily refresh keeps it current like a platform's.
A mapping no install points at any more is deleted.
"""
from __future__ import annotations

from django.db import transaction


def _product(application):
    """The product the application names - from a source's cached catalog,
    or one of its tenant's custom products - or None."""
    from compliance.eol import find_product

    return find_product(application.eol_source, application.eol_product,
                        application.tenant_id)


def derive_cycle(application, version: str, product=None) -> str:
    """The cycle ``version`` belongs to in the application's product; blank
    without a product, a cached catalog or a match."""
    from compliance.eol import suggest_cycle

    product = product if product is not None else _product(application)
    if product is None or not version:
        return ""
    return suggest_cycle(product, version)


def mapping_for(application, cycle: str, product=None):
    """The (application, cycle) mapping, made and filled on first use. None
    without a product or a cycle."""
    if not (application.eol_source and application.eol_product and cycle):
        return None
    from compliance.eol import fill_mapping
    from compliance.models import EolMapping

    mapping, created = EolMapping.objects.get_or_create(
        application=application, cycle=cycle,
        defaults={"tenant_id": application.tenant_id,
                  "source": application.eol_source,
                  "product": application.eol_product},
    )
    if created or (mapping.source, mapping.product) != (
        application.eol_source, application.eol_product
    ):
        if not created:
            mapping.source = application.eol_source
            mapping.product = application.eol_product
            mapping.synced_at = None
        product = product if product is not None else _product(application)
        fill_mapping(mapping, product)
        mapping.save()
    return mapping


def sync_install(install, product=None) -> None:
    """Set ``install.cycle`` (unless set by hand) and ``install.eol_mapping``
    from its application. Does not save the install."""
    app = install.application
    if product is None:
        product = _product(app)
    if not install.cycle_manual:
        install.cycle = derive_cycle(app, install.version, product)
    install.eol_mapping = mapping_for(app, install.cycle, product)


def drop_unused_mappings(ids=None, application=None) -> int:
    """Delete the application mappings no install points at - among ``ids``,
    or of ``application``. Platform mappings are never touched."""
    from compliance.models import EolMapping

    qs = EolMapping.objects.filter(application__isnull=False, installs__isnull=True)
    if ids is not None:
        qs = qs.filter(pk__in=list(ids))
    if application is not None:
        qs = qs.filter(application=application)
    gone = 0
    for m in qs:  # one by one, so each deletion reaches the change log
        m.delete()
        gone += 1
    return gone


def set_product(application, source: str, product: str) -> None:
    """Point ``application`` at another end-of-life product (blank = none)
    and redo its installs' cycles and mappings."""
    from .models import InstalledSoftware

    with transaction.atomic():
        application.eol_source = source
        application.eol_product = product
        application.save(update_fields=["eol_source", "eol_product", "updated_at"])
        cat = _product(application)
        for install in InstalledSoftware.objects.filter(application=application):
            install.application = application
            sync_install(install, cat)
            InstalledSoftware.objects.filter(pk=install.pk).update(
                cycle=install.cycle, eol_mapping=install.eol_mapping
            )
        drop_unused_mappings(application=application)


def software_end_annotations(parent_field: str) -> dict:
    """Annotations for a Device (``parent_field="device"``) or VM
    (``"virtual_machine"``) queryset, for the lists' Next end of life column:
    the soonest end of its installed software - ``software_end_entered``
    from the dates entered on the installs alone, ``software_end_any`` with
    the synced mappings filling the blanks (read while end-of-life data is
    on). Two correlated subqueries: a page costs no extra query."""
    from django.db.models import Case, DateField, Min, OuterRef, Subquery, When
    from django.db.models.functions import Coalesce

    from .models import InstalledSoftware

    def soonest(expr):
        return Subquery(
            InstalledSoftware.objects.filter(**{parent_field: OuterRef("pk")})
            .order_by().values(parent_field).annotate(v=Min(expr)).values("v")[:1],
            output_field=DateField(),
        )

    mapped = Case(When(eol_mapping__synced_at__isnull=False,
                       then="eol_mapping__eol_date"), output_field=DateField())
    return {
        "software_end_entered": soonest("end_of_support"),
        "software_end_any": soonest(Coalesce("end_of_support", mapped)),
    }


# ─── Application groups ──────────────────────────────────────────────────────
#
# A group is a named set of applications. Assigning it to a device or VM
# records one install per member (``source="group"``, ``group`` set, the
# member's default version); an install of that application already on the
# host is left alone. An install is *untouched* while its version is the
# member's default, it names no service and its cycle was not set by hand;
# anything else counts as edited. Unassigning, or removing a member, deletes
# the untouched installs the group made and keeps the edited ones with their
# group cleared - unless another group on the same host has the application,
# which then takes the install over. Every write is an ORM save or delete,
# one row at a time, so the change log records each install.


def _host(device=None, virtual_machine=None) -> dict:
    if (device is None) == (virtual_machine is None):
        raise ValueError("exactly one of device or virtual_machine")
    if device is not None:
        return {"device": device}
    return {"virtual_machine": virtual_machine}


def _host_of(row) -> dict:
    if row.device_id:
        return {"device_id": row.device_id}
    return {"virtual_machine_id": row.virtual_machine_id}


def is_untouched(install, default_version: str) -> bool:
    """Whether an install still reads as its group member made it."""
    return (install.version == (default_version or "") and install.service_id is None
            and not install.cycle_manual)


def _materialise(member, host: dict):
    """The member's install on one host, made unless the host already runs
    the application. Returns the new install or None."""
    from .models import InstalledSoftware

    if InstalledSoftware.objects.filter(application_id=member.application_id, **host).exists():
        return None
    install = InstalledSoftware(
        tenant_id=member.group.tenant_id, application=member.application,
        version=member.version, source="group", group=member.group, **host,
    )
    install.save()
    return install


def _release(install, default_version: str) -> str:
    """Let go of an install its group no longer wants: another group on the
    host with the application takes it over, else it goes while untouched,
    else it stays with its group cleared. Returns ``moved``, ``removed`` or
    ``kept``."""
    from .models import ApplicationGroupAssignment

    other = (
        ApplicationGroupAssignment.objects.filter(**_host_of(install))
        .exclude(group_id=install.group_id)
        .filter(group__members__application_id=install.application_id)
        .order_by("created_at").values_list("group_id", flat=True).first()
    )
    if other is not None:
        install.group_id = other
        install.save(update_fields=["group", "updated_at"])
        return "moved"
    if is_untouched(install, default_version):
        install.delete()
        return "removed"
    install.group = None
    install.save(update_fields=["group", "updated_at"])
    return "kept"


def assign_group(group, *, device=None, virtual_machine=None):
    """Assign ``group`` to one host and record its members' installs.
    Returns ``(assignment, created installs)``."""
    from .models import ApplicationGroupAssignment

    host = _host(device, virtual_machine)
    created = []
    with transaction.atomic():
        assignment = ApplicationGroupAssignment(tenant_id=group.tenant_id, group=group, **host)
        assignment.save()
        for member in group.members.select_related("application", "group"):
            install = _materialise(member, host)
            if install is not None:
                created.append(install)
    return assignment, created


def unassign_group(assignment) -> dict:
    """Remove an assignment and let go of the installs its group made on
    that host. Returns the counts by outcome."""
    from .models import InstalledSoftware

    counts = {"removed": 0, "kept": 0, "moved": 0}
    with transaction.atomic():
        group = assignment.group
        defaults = dict(group.members.values_list("application_id", "version"))
        host = _host_of(assignment)
        assignment.delete()
        for install in InstalledSoftware.objects.filter(group=group, **host):
            counts[_release(install, defaults.get(install.application_id, ""))] += 1
    return counts


def add_member(group, application, version: str = "", position: int = 0):
    """Add an application to a group and install it on every host the group
    is assigned to."""
    from .models import ApplicationGroupMember

    with transaction.atomic():
        member = ApplicationGroupMember(
            tenant_id=group.tenant_id, group=group, application=application,
            version=version or "", position=position,
        )
        member.save()
        for a in group.assignments.all():
            _materialise(member, _host_of(a))
    return member


def remove_member(member) -> None:
    """Take an application out of a group: the installs it made go (or
    stay, or move) as on unassign."""
    from .models import InstalledSoftware

    with transaction.atomic():
        installs = list(InstalledSoftware.objects.filter(
            group_id=member.group_id, application_id=member.application_id))
        member.delete()
        for install in installs:
            _release(install, member.version)


def set_member_version(member, version: str) -> None:
    """Change a member's default version; the untouched installs it made
    follow, unless the host already records the new version."""
    from .models import InstalledSoftware

    version = version or ""
    if version == member.version:
        return
    with transaction.atomic():
        for install in InstalledSoftware.objects.filter(
            group_id=member.group_id, application_id=member.application_id,
        ):
            if not is_untouched(install, member.version):
                continue
            if InstalledSoftware.objects.filter(
                application_id=install.application_id, version=version,
                **_host_of(install),
            ).exclude(pk=install.pk).exists():
                continue
            install.version = version
            install.save()
        member.version = version
        member.save(update_fields=["version"])


def set_members(group, rows) -> None:
    """Make ``group``'s members ``rows`` - ``[(application, version)]`` in
    order: new ones are added and installed, missing ones removed, changed
    versions and positions saved."""
    with transaction.atomic():
        current = {m.application_id: m for m in group.members.select_related("application")}
        wanted = {app.pk for app, _v in rows}
        for app_id, member in current.items():
            if app_id not in wanted:
                remove_member(member)
        for position, (app, version) in enumerate(rows):
            member = current.get(app.pk)
            if member is None:
                add_member(group, app, version, position)
                continue
            set_member_version(member, version)
            if member.position != position:
                member.position = position
                member.save(update_fields=["position"])


def set_host_groups(groups, *, device=None, virtual_machine=None) -> dict:
    """Make the host's assigned groups exactly ``groups``. Returns the group
    ids ``{"assigned": [...], "unassigned": [...]}``."""
    from .models import ApplicationGroupAssignment

    host = _host(device, virtual_machine)
    wanted = {g.pk: g for g in groups}
    out = {"assigned": [], "unassigned": []}
    with transaction.atomic():
        have = {a.group_id: a for a in ApplicationGroupAssignment.objects
                .filter(**host).select_related("group")}
        for gid, a in have.items():
            if gid not in wanted:
                unassign_group(a)
                out["unassigned"].append(gid)
        for gid, g in wanted.items():
            if gid not in have:
                assign_group(g, **host)
                out["assigned"].append(gid)
    return out


def _install_deleted(sender, instance, **kwargs) -> None:
    """The last install of a cycle takes its mapping along."""
    if instance.eol_mapping_id:
        drop_unused_mappings([instance.eol_mapping_id])


def connect_signals() -> None:
    from django.db.models.signals import post_delete

    from .models import InstalledSoftware

    post_delete.connect(_install_deleted, sender=InstalledSoftware,
                        dispatch_uid="installedsoftware_drop_mapping")
