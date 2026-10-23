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
    """The cached catalog product the application names, or None."""
    if not (application.eol_source and application.eol_product):
        return None
    from compliance.models import EolProduct

    return EolProduct.objects.filter(
        source=application.eol_source, name=application.eol_product
    ).first()


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


def _install_deleted(sender, instance, **kwargs) -> None:
    """The last install of a cycle takes its mapping along."""
    if instance.eol_mapping_id:
        drop_unused_mappings([instance.eol_mapping_id])


def connect_signals() -> None:
    from django.db.models.signals import post_delete

    from .models import InstalledSoftware

    post_delete.connect(_install_deleted, sender=InstalledSoftware,
                        dispatch_uid="installedsoftware_drop_mapping")
