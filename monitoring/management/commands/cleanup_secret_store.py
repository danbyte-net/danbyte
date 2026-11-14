"""List, and optionally remove, managed secrets whose record is gone (#509).

Before 0.20 a deleted device credential (and a few other records) left its
secret in the store. This finds every secret under one of Danbyte's managed
folders (``monitoring.secret_refs.MANAGED_SECRETS``) whose record no longer
exists in the same tenant, or no longer points at it, in every configured
store.

* Default: a dry run - each orphan is listed by store, tenant and ref (never
  a value), nothing is removed.
* ``--delete`` removes the orphans from the local store.
* ``--delete --remote`` removes them from Vault / Key Vault / plugin stores
  as well. Remote deletes cannot be undone, so they need the extra flag.
* ``--tenant`` limits the sweep to one tenant (slug or id); without it a
  deleted tenant's leftovers are found too.

A store that cannot list its secrets (a plugin without ``managed_refs``) is
skipped and named. Each removal run writes one change-log entry per tenant
and store with the refs removed.
"""
from __future__ import annotations

import getpass
import uuid

from django.core.management.base import BaseCommand, CommandError

from core.models import Tenant
from monitoring.secret_refs import owner_exists
from monitoring.secret_store import SecretStoreError, configured_stores, store_for


def resolve_tenant(value: str) -> Tenant:
    try:
        return Tenant.objects.get(pk=uuid.UUID(value))
    except (ValueError, Tenant.DoesNotExist):
        pass
    tenant = Tenant.objects.filter(slug=value).first()
    if tenant is None:
        raise CommandError(f"No tenant '{value}'.")
    return tenant


def who() -> str:
    try:
        return getpass.getuser()[:255]
    except (KeyError, OSError):
        return ""


class Command(BaseCommand):
    help = "List (and with --delete remove) managed secrets whose record is gone."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", help="Only this tenant (slug or id).")
        parser.add_argument(
            "--store", help="Only this store kind (local, vault, azure, …). Default: every configured one."
        )
        parser.add_argument(
            "--delete", action="store_true", help="Remove the orphans from the local store."
        )
        parser.add_argument(
            "--remote", action="store_true",
            help="With --delete, remove them from external stores too.",
        )

    def handle(self, *args, **opts):
        if opts["remote"] and not opts["delete"]:
            raise CommandError("--remote only applies with --delete.")
        tenant = resolve_tenant(opts["tenant"]) if opts["tenant"] else None
        if opts["store"]:
            store = store_for(opts["store"])
            if store is None:
                raise CommandError(f"The '{opts['store']}' store is not configured.")
            stores = [(opts["store"], store)]
        else:
            stores = configured_stores()

        total = removed = 0
        failed = False
        for kind, store in stores:
            lister = getattr(store, "managed_refs", None)
            if lister is None:
                self.stdout.write(f"{kind}: cannot list its secrets; skipped.")
                continue
            try:
                refs = lister(tenant.id if tenant else None)
            except SecretStoreError as exc:
                self.stderr.write(f"{kind}: {exc}")
                failed = True
                continue
            orphans = [(t, r) for t, r in refs if not owner_exists(t, r)]
            total += len(orphans)
            remove = opts["delete"] and (getattr(store, "transactional", False) or opts["remote"])
            gone: dict[str, list[str]] = {}
            for tenant_id, ref in sorted(orphans):
                if not remove:
                    self.stdout.write(f"{kind}  {tenant_id}  {ref}")
                    continue
                try:
                    store.delete(tenant_id, ref)
                except SecretStoreError as exc:
                    self.stderr.write(f"{kind}  {tenant_id}  {ref}  not removed: {exc}")
                    failed = True
                    continue
                gone.setdefault(tenant_id, []).append(ref)
                self.stdout.write(f"{kind}  {tenant_id}  {ref}  removed")
            for tenant_id, gone_refs in gone.items():
                self._audit(kind, tenant_id, gone_refs)
                removed += len(gone_refs)
            if orphans and opts["delete"] and not remove:
                self.stdout.write(f"{kind}: external store; add --remote to remove these.")
            self.stdout.write(f"{kind}: {len(orphans)} orphaned of {len(refs)} managed.")

        verb = "removed" if opts["delete"] else "found (dry run - nothing removed)"
        self.stdout.write(f"Total: {removed if opts['delete'] else total} {verb}.")
        if failed:
            raise CommandError("Some stores or secrets could not be processed; see above.")

    @staticmethod
    def _audit(kind: str, tenant_id: str, refs: list[str]) -> None:
        from audit.models import ChangeAction, ChangeLogEntry

        exists = Tenant.objects.filter(pk=tenant_id).exists()
        ChangeLogEntry.objects.create(
            tenant_id=tenant_id if exists else None,
            user=None,
            user_name=who(),
            action=ChangeAction.DELETE,
            object_type="monitoring.storedsecret",
            object_label="Secret store",
            object_id=kind[:64],
            object_repr=f"Orphaned secrets removed from the {kind} store"[:255],
            changes={"store": kind, "tenant": tenant_id, "removed": len(refs), "refs": refs},
            via="system",
            cause="manage.py cleanup_secret_store",
        )
