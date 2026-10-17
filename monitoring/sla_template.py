"""SLA templates: compare an agreement with its template, and sync it.

A sync copies the template's rules into the agreement. When that changes a
rule, the agreement gets a new revision exactly as an edit would: the
running period follows the new rules at once, and closed and frozen periods
keep the revision they ran under (monitoring.sla.rules_for).
"""
from __future__ import annotations

from django.db import transaction

#: The template fields that are money.
CREDIT_FIELDS = ("credit_tiers", "period_fee", "currency")


def differs(agreement, template) -> list[str]:
    """The template fields whose value on the agreement is not the template's."""
    return [f for f in template.FIELDS if getattr(agreement, f) != getattr(template, f)]


def apply_values(agreement, template, fields=None) -> None:
    for f in fields if fields is not None else template.FIELDS:
        setattr(agreement, f, getattr(template, f))


def sync(agreement, template, user=None) -> bool:
    """Copy the template into the agreement. True when a rule changed and a
    revision was written."""
    from .models import SlaAgreement, SlaAgreementRevision

    with transaction.atomic():
        a = SlaAgreement.objects.select_for_update().get(pk=agreement.pk)
        changed = differs(a, template)
        if not changed:
            return False
        before = a.rules()
        apply_values(a, template, changed)
        revised = a.rules() != before
        if revised:
            a.revision += 1
        a.save()
        if revised:
            SlaAgreementRevision.objects.create(
                agreement=a, number=a.revision, rules=a.rules(), created_by=user)
    agreement.refresh_from_db()
    return True
