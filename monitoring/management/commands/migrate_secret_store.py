"""Move every managed secret from one secret store to another (#511).

Each record that keeps a managed secret is stamped with the store it was
written to, and is read from that store while it stays configured, so
switching the active store strands nothing. This command moves them over so
the old store can be retired:

1. read the secret from ``--from``;
2. write it to ``--to`` and read it back to verify;
3. stamp the record with ``--to`` (reads go there from now on);
4. only then delete it from ``--from``.

A dry run (the default) counts what would move. ``--apply`` moves. A run can
be stopped and run again: a record already stamped ``--to`` is skipped, and
if its old copy is still in ``--from`` (the delete failed last time) that copy
is removed once the new one is confirmed. A record without a stamp (written
before stamps existed) is taken from ``--from`` when it is there.

External credentials point at a path you manage; they are counted and left
alone. Values are never printed. Each applied run writes one change-log entry
per tenant with the counts.
"""
from __future__ import annotations

from collections import Counter

from django.core.management.base import BaseCommand, CommandError

from monitoring.management.commands.cleanup_secret_store import resolve_tenant, who
from monitoring.secret_refs import MANAGED_SECRETS
from monitoring.secret_store import SecretStoreError, secret_store_kinds, store_for


class Command(BaseCommand):
    help = "Move managed secrets from one secret store to another (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("--from", dest="source", required=True, help="Store kind to move from.")
        parser.add_argument("--to", dest="target", required=True, help="Store kind to move to.")
        parser.add_argument("--apply", action="store_true", help="Move; without it, only count.")
        parser.add_argument("--tenant", help="Only this tenant (slug or id).")

    def handle(self, *args, **opts):
        source_kind, target_kind = opts["source"].strip(), opts["target"].strip()
        if source_kind == target_kind:
            raise CommandError("--from and --to name the same store.")
        for kind in (source_kind, target_kind):
            if kind not in secret_store_kinds():
                raise CommandError(f"Unknown secret store '{kind}'.")
        source, target = store_for(source_kind), store_for(target_kind)
        if source is None:
            raise CommandError(f"The '{source_kind}' store is not configured; nothing can be read.")
        if target is None:
            raise CommandError(f"The '{target_kind}' store is not configured.")
        tenant = resolve_tenant(opts["tenant"]) if opts["tenant"] else None
        apply = opts["apply"]

        totals: Counter = Counter()
        per_tenant: dict[str, Counter] = {}
        failed = False
        for spec in MANAGED_SECRETS:
            counts: Counter = Counter()
            rows = spec.model_class._default_manager.all()
            if tenant is not None:
                rows = rows.filter(tenant=tenant)
            for row in rows.iterator():
                ref = spec.ref(row)
                if not ref:
                    if not spec.is_managed(row) and spec.provider(row) == source_kind \
                            and getattr(row, spec.ref_field, ""):
                        counts["external"] += 1
                    continue
                stamp = spec.provider(row)
                if stamp == target_kind:
                    if apply:
                        outcome = self._finish(spec, row, ref, source, target, source_kind)
                    else:
                        outcome = "done"
                elif stamp in (source_kind, ""):
                    outcome = (
                        self._move(spec, row, ref, source, target, source_kind, target_kind)
                        if apply else self._would_move(row, ref, source, stamp)
                    )
                else:
                    outcome = "elsewhere"
                counts[outcome] += 1
                if outcome in ("moved", "cleaned"):
                    per_tenant.setdefault(str(row.tenant_id), Counter())[outcome] += 1
                if outcome == "failed":
                    failed = True
            if counts:
                self.stdout.write(f"{spec.model}: " + self._summary(counts, apply))
            totals.update(counts)

        self.stdout.write("Total: " + self._summary(totals, apply))
        if apply:
            for tenant_id, counts in per_tenant.items():
                self._audit(tenant_id, source_kind, target_kind, counts)
        else:
            self.stdout.write("Dry run - nothing moved. Add --apply to move.")
        if failed:
            raise CommandError("Some secrets could not be moved; see above. Run it again to retry.")

    # ─── one record ────────────────────────────────────────────────────
    def _label(self, row, ref):
        return f"{row._meta.label} {row.pk} ({ref})"

    def _would_move(self, row, ref, source, stamp):
        if stamp:
            return "to-move"
        # Unstamped: only ours to move if the source store has it.
        try:
            return "to-move" if source.get(row.tenant_id, ref) is not None else "elsewhere"
        except SecretStoreError as exc:
            self.stderr.write(f"{self._label(row, ref)}: {exc}")
            return "failed"

    def _move(self, spec, row, ref, source, target, source_kind, target_kind):
        try:
            value = source.get(row.tenant_id, ref)
        except SecretStoreError as exc:
            self.stderr.write(f"{self._label(row, ref)}: read from {source_kind} failed: {exc}")
            return "failed"
        if value is None:
            if not spec.provider(row):
                return "elsewhere"  # unstamped and not in the source
            self.stderr.write(f"{self._label(row, ref)}: not in {source_kind}; left as it is.")
            return "missing"
        try:
            target.put(row.tenant_id, ref, value)
            copied = target.get(row.tenant_id, ref)
        except SecretStoreError as exc:
            self.stderr.write(f"{self._label(row, ref)}: write to {target_kind} failed: {exc}")
            return "failed"
        if copied != value:
            self.stderr.write(f"{self._label(row, ref)}: the copy in {target_kind} differs; "
                              "left in " + source_kind)
            return "failed"
        if spec.provider_field:
            type(row)._default_manager.filter(pk=row.pk).update(**{spec.provider_field: target_kind})
        try:
            source.delete(row.tenant_id, ref)
        except SecretStoreError as exc:
            self.stderr.write(f"{self._label(row, ref)}: moved, but the old copy in "
                              f"{source_kind} was not removed: {exc}")
        return "moved"

    def _finish(self, spec, row, ref, source, target, source_kind):
        """A record already moved: drop a copy a previous run left behind."""
        try:
            if source.get(row.tenant_id, ref) is None:
                return "done"
            if target.get(row.tenant_id, ref) is None:
                self.stderr.write(f"{self._label(row, ref)}: stamped with the new store but "
                                  f"only in {source_kind}; left as it is.")
                return "failed"
            source.delete(row.tenant_id, ref)
        except SecretStoreError as exc:
            self.stderr.write(f"{self._label(row, ref)}: {exc}")
            return "failed"
        return "cleaned"

    @staticmethod
    def _summary(counts: Counter, apply: bool) -> str:
        names = (
            ("moved", "moved"), ("to-move", "to move"), ("done", "already moved"),
            ("cleaned", "old copy removed"), ("missing", "missing from the source"),
            ("failed", "failed"), ("elsewhere", "in another store"),
            ("external", "external, left alone"),
        )
        parts = [f"{counts[key]} {label}" for key, label in names if counts.get(key)]
        return ", ".join(parts) or "nothing to do"

    @staticmethod
    def _audit(tenant_id, source_kind, target_kind, counts) -> None:
        from audit.models import ChangeAction, ChangeLogEntry

        ChangeLogEntry.objects.create(
            tenant_id=tenant_id,
            user=None,
            user_name=who(),
            action=ChangeAction.UPDATE,
            object_type="monitoring.storedsecret",
            object_label="Secret store",
            object_id=target_kind[:64],
            object_repr=f"Secrets moved from {source_kind} to {target_kind}"[:255],
            changes={"from": source_kind, "to": target_kind, **dict(counts)},
            via="system",
            cause="manage.py migrate_secret_store",
        )
