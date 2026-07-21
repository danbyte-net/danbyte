"""Force-delete a tenant and everything it owns.

Structural catalogs (``Status``, ``VRF``, ``Site``, ``Manufacturer``,
``DeviceRole``, …) reference their tenant with ``on_delete=PROTECT`` — a
deliberate guard so a stray click can't wipe a whole tenant. That also means a
plain ``tenant.delete()`` always raises ``ProtectedError`` once the tenant has
any data (even the statuses/roles seeded at creation).

``force_delete_tenant`` performs the *deliberate* teardown: it repeatedly tries
to delete the tenant, and each time a ``ProtectedError`` names the rows blocking
it, deletes those first (which cascades their children), then retries — peeling
the PROTECT graph layer by layer until the tenant itself goes. Everything runs
in one transaction, so a failure leaves the tenant untouched.

Only reachable from the tenant's own PROTECT cascade, so it stays within that
tenant (tenant isolation forbids cross-tenant references).
"""
from __future__ import annotations

import logging
from collections import defaultdict

from django.db import transaction
from django.db.models.deletion import ProtectedError

logger = logging.getLogger("danbyte.tenant")

# Safety bound: the PROTECT graph is shallow (leaf data → catalogs → tenant), so
# this converges in a handful of passes; the cap only stops a pathological loop.
_MAX_PASSES = 500


def force_delete_tenant(tenant) -> int:
    """Delete ``tenant`` and all of its data, cascading through PROTECT.

    Returns the total number of rows deleted. Raises the original
    ``ProtectedError`` if a pass can make no progress (so a genuinely
    un-deletable reference still surfaces rather than looping forever).
    """
    total = 0
    with transaction.atomic():
        for _ in range(_MAX_PASSES):
            try:
                deleted, _ = tenant.delete()
                return total + deleted
            except ProtectedError as exc:
                # Group the blocking rows by model and delete what we can this
                # pass. PROTECT is checked in Django's collector *before* any
                # SQL runs, so a caught ProtectedError leaves the transaction
                # intact and we can keep going.
                by_model: dict = defaultdict(set)
                for obj in exc.protected_objects:
                    by_model[type(obj)].add(obj.pk)

                progressed = False
                for model, pks in by_model.items():
                    try:
                        deleted, _ = model._default_manager.filter(pk__in=pks).delete()
                        if deleted:
                            total += deleted
                            progressed = True
                    except ProtectedError:
                        # Still protected by something else — it'll be peeled on
                        # a later pass once its own protectors are gone.
                        pass

                if not progressed:
                    # Nothing could be removed this pass — surface the real error
                    # instead of spinning.
                    logger.error("force_delete_tenant stalled on %s", tenant.pk)
                    raise
        raise RuntimeError(
            f"Tenant {tenant.pk} deletion did not converge after {_MAX_PASSES} passes."
        )
