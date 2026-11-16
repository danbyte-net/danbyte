"""Every record that keeps a managed secret in the secret store, in one place.

A managed secret is one Danbyte files itself under ``<folder>/<row id>`` in the
tenant's namespace of the active store: a device or shared credential's login,
an SSID / IPsec / FHRP / keychain / RPKI-cache key, a CSR's private key, an
ACME account key. The row holds only the reference. :data:`MANAGED_SECRETS`
lists them so deletion, the orphan sweep (``cleanup_secret_store``) and the
store move (``migrate_secret_store``) cover the same set.

Deleting a row takes its secret with it (#509): a ``post_delete`` handler per
model, so a single delete, a bulk delete and a cascade (a device's
credentials, a tenant's everything) all count. The local store is a table in
the same database, so its row goes inside the caller's transaction and comes
back if that rolls back. An external store cannot roll back, so its delete
waits for the commit: a delete that fails or is rolled back (a bulk-delete dry
run) never removes a secret that is still referenced.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial

from django.apps import apps
from django.db import transaction
from django.db.models.signals import post_delete

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ManagedSecret:
    """One model whose rows file a managed secret."""

    #: ``app_label.ModelName``.
    model: str
    #: The folder refs live under, without the trailing slash.
    folder: str
    #: The field holding the ref.
    ref_field: str
    #: The field stamped with the provider that holds it ("" when none).
    provider_field: str = ""
    #: Field lookups that select the rows whose ref is Danbyte's own.
    managed_filter: tuple[tuple[str, object], ...] = ()
    #: The ref for a row whose ref field is blank, when one is implied.
    implied_ref: Callable[[object], str] | None = None

    @property
    def model_class(self):
        return apps.get_model(self.model)

    def is_managed(self, obj) -> bool:
        return all(getattr(obj, name) == value for name, value in self.managed_filter)

    def ref(self, obj) -> str:
        """The managed ref ``obj`` keeps, or "" when it keeps none."""
        if not self.is_managed(obj):
            return ""
        ref = getattr(obj, self.ref_field, "") or ""
        if not ref and self.implied_ref is not None:
            ref = self.implied_ref(obj)
        return ref

    def provider(self, obj) -> str:
        if not self.provider_field:
            return ""
        return (getattr(obj, self.provider_field, "") or "").strip()

    def managed_rows(self):
        """Every row of this model that may keep a managed secret."""
        return self.model_class._default_manager.filter(**dict(self.managed_filter))


def _issuer_ref(issuer) -> str:
    # An account registered before account_ref was stored files its key here.
    return f"issuer/{issuer.id}/account" if issuer.account_uri else ""


MANAGED_SECRETS: tuple[ManagedSecret, ...] = (
    ManagedSecret("monitoring.DeviceCredential", "device-credentials", "secret_path",
                  "secret_provider", (("secret_managed", True),)),
    ManagedSecret("monitoring.SharedCredential", "shared-credentials", "secret_path",
                  "secret_provider", (("secret_managed", True),)),
    ManagedSecret("api.WirelessLAN", "wireless-lans", "psk_secret_path", "psk_secret_provider"),
    ManagedSecret("api.IPSecProfile", "ipsec-profiles", "psk_secret_path", "psk_secret_provider"),
    ManagedSecret("api.FHRPGroup", "fhrp-groups", "psk_secret_path", "psk_secret_provider"),
    ManagedSecret("routing.RoutingKeychain", "routing-keychains", "psk_secret_path",
                  "psk_secret_provider"),
    ManagedSecret("routing.RPKICache", "routing-rpki-caches", "psk_secret_path",
                  "psk_secret_provider"),
    ManagedSecret("monitoring.CertificateRequest", "csr", "key_ref", "key_provider"),
    ManagedSecret("monitoring.Issuer", "issuer", "account_ref", "account_provider",
                  implied_ref=_issuer_ref),
)


def spec_for_ref(ref: str) -> tuple[ManagedSecret, uuid.UUID] | None:
    """The spec and row id a managed ref names, or ``None`` when ``ref`` is
    not one of Danbyte's own (``<folder>/<uuid>``, or ``issuer/<uuid>/account``)."""
    parts = (ref or "").split("/")
    for spec in MANAGED_SECRETS:
        if parts[0] != spec.folder:
            continue
        shape = 3 if spec.folder == "issuer" else 2
        if len(parts) != shape or (shape == 3 and parts[2] != "account"):
            return None
        try:
            return spec, uuid.UUID(parts[1])
        except ValueError:
            return None
    return None


def owner_exists(tenant_id, ref: str) -> bool:
    """True when a row of ``tenant_id`` still keeps ``ref`` as its managed
    secret. Conservative: an unparseable ref counts as owned."""
    hit = spec_for_ref(ref)
    if hit is None:
        return True
    spec, pk = hit
    row = spec.model_class._default_manager.filter(tenant_id=tenant_id, pk=pk).first()
    return row is not None and spec.ref(row) == ref


# ─── removal ─────────────────────────────────────────────────────────────────


def _drop(kind: str, store, tenant_id, ref: str) -> None:
    try:
        store.delete(tenant_id, ref)
    except Exception as exc:  # noqa: BLE001 - best effort; the sweep finds it
        # The ref and the store, never a value.
        log.warning("could not remove secret %s from the %s store: %s", ref, kind, exc)


def discard_secret(tenant_id, ref: str, provider: str = "") -> None:
    """Remove a managed secret that nothing references any more, best effort.

    From the store stamped on the record and from the active one (they differ
    after a switch); from every configured store when nothing was stamped. A
    transactional store (local) deletes now, inside the caller's transaction;
    any other store after the commit. A store that is unreachable leaves the
    secret behind, logged, for ``cleanup_secret_store`` to find."""
    if not ref:
        return
    from .secret_store import stores_to_discard

    try:
        stores = stores_to_discard(provider)
    except Exception as exc:  # noqa: BLE001 - never fail the delete itself
        log.warning("could not resolve the secret store for %s: %s", ref, exc)
        return
    for kind, store in stores:
        if getattr(store, "transactional", False):
            _drop(kind, store, tenant_id, ref)
        else:
            transaction.on_commit(partial(_drop, kind, store, tenant_id, ref))


def discard_copy(kind: str, tenant_id, ref: str) -> None:
    """Remove ``ref`` from the ``kind`` store only - a copy left behind once
    the secret was rewritten to another store. Same timing as
    :func:`discard_secret`."""
    from .secret_store import store_for

    if not ref:
        return
    try:
        store = store_for(kind)
    except Exception as exc:  # noqa: BLE001 - never fail the write itself
        log.warning("could not resolve the %s store for %s: %s", kind, ref, exc)
        return
    if store is None:
        return
    if getattr(store, "transactional", False):
        _drop(kind, store, tenant_id, ref)
    else:
        transaction.on_commit(partial(_drop, kind, store, tenant_id, ref))


def secret_counts() -> dict[str, int]:
    """How many managed secrets each store holds, by the stamp on their
    records; an unstamped one counts toward the active store, where it is
    looked for first. Counts only, deployment-wide."""
    from django.db.models import Count, Q

    from .secret_store import _provider

    active = _provider()
    out: dict[str, int] = {}
    for spec in MANAGED_SECRETS:
        has_ref = ~Q(**{spec.ref_field: ""})
        if spec.implied_ref is not None:
            has_ref |= ~Q(account_uri="")
        rows = spec.managed_rows().filter(has_ref).order_by()
        if spec.provider_field:
            grouped = rows.values_list(spec.provider_field).annotate(n=Count("pk"))
        else:
            grouped = [("", rows.count())]
        for kind, n in grouped:
            key = (kind or "").strip() or active
            if n:
                out[key] = out.get(key, 0) + n
    return out


def _on_delete(sender, instance, spec: ManagedSecret, **kwargs) -> None:
    discard_secret(instance.tenant_id, spec.ref(instance), spec.provider(instance))


def connect() -> None:
    """Take each managed secret with its row, however the row is deleted."""
    for spec in MANAGED_SECRETS:
        post_delete.connect(
            partial(_on_delete, spec=spec),
            sender=spec.model_class,
            weak=False,
            dispatch_uid=f"managed-secret-{spec.model}",
        )
