"""The inventory-item list's stock filters (docs/dcim/stock.md).

* ``home=stock|device|port`` (comma-separated) - where the item is.
* ``location=<uuid>`` - its stock location, or its device's location.
* ``status=<uuid>`` (comma-separated) - its status.
* ``fits=<interface type>`` - transceivers that fit a port of that type:
  their part (set by hand, else by part number, ``api.port_plugs``) lists the
  type in ``fits``. An item whose part is unknown stays: nothing says it
  doesn't fit.
* ``near_site=<uuid>`` - that site's items first (the Set transceiver
  dialog's From stock list), then the rest by site name.
"""
from __future__ import annotations

import uuid

from django.db.models import Case, F, Func, IntegerField, Q, Value, When
from django.db.models.functions import Trim, Upper
from rest_framework.exceptions import ValidationError

from .natural import natural

HOMES = ("stock", "device", "port")


def _uuid(raw: str, name: str):
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise ValidationError({name: "A valid UUID."}) from None


def _list(raw: str | None) -> list[str]:
    return [v.strip() for v in (raw or "").split(",") if v.strip()]


def home_q(home: str) -> Q:
    if home == "stock":
        return Q(device__isnull=True)
    if home == "port":
        return Q(device__isnull=False, interface__isnull=False)
    return Q(device__isnull=False, interface__isnull=True)


def stock_filters(qs, params, tenant):
    homes = _list(params.get("home"))
    if homes:
        bad = [h for h in homes if h not in HOMES]
        if bad:
            raise ValidationError({"home": f"One of {', '.join(HOMES)}."})
        q = Q(pk__in=[])
        for h in homes:
            q |= home_q(h)
        qs = qs.filter(q)
    if raw := params.get("location"):
        loc = _uuid(raw, "location")
        qs = qs.filter(Q(location_id=loc) | Q(device__location_id=loc))
    statuses = _list(params.get("status"))
    if statuses:
        qs = qs.filter(status_id__in=[_uuid(s, "status") for s in statuses])
    if fits := (params.get("fits") or "").strip():
        qs = _fits(qs, fits, tenant)
    if raw := params.get("near_site"):
        site = _uuid(raw, "near_site")
        qs = qs.annotate(_near=Case(
            When(Q(site_id=site) | Q(device__site_id=site), then=Value(0)),
            default=Value(1), output_field=IntegerField(),
        )).order_by("_near", natural("site__name"), natural("device__name"),
                    natural("name"), "pk")
    return qs


def _fits(qs, port_type: str, tenant):
    from .models import AccessoryType
    from .port_plugs import part_key

    parts = list(AccessoryType.objects.filter(tenant=tenant, kind="transceiver")
                 .only("id", "fits", "parts"))
    fit_ids = [a.pk for a in parts if port_type in (a.fits or [])]
    fit_keys, known_keys = set(), set()
    for a in parts:
        for p in a.parts or []:
            known_keys.add(part_key(str(p)))
            if port_type in (a.fits or []):
                fit_keys.add(part_key(str(p)))
    key = Upper(Trim(Func(Trim(F("part_id")), Value("="), function="RTRIM")))
    qs = qs.annotate(_part_key=key)
    by_hand = Q(accessory_type__isnull=False)
    return qs.filter(
        (by_hand & Q(accessory_type_id__in=fit_ids))
        | (~by_hand & Q(_part_key__in=fit_keys))
        | (~by_hand & ~Q(_part_key__in=known_keys))
    )
