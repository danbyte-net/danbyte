"""Re-encrypt every stored credential under the newest MONITORING_SECRET_KEY (#493).

With ``MONITORING_SECRET_KEY=new,old`` every value still decrypts, and new
writes use ``new``. This command walks every ``EncryptedJSONField`` column of
every installed model and re-encrypts the values that are not yet under
``new`` (``MultiFernet.rotate``), so ``old`` can then be removed.

* ``--dry-run`` counts, per model and field, what would change and what is
  already current; nothing is written.
* ``--check`` verifies every value decrypts under the first key - the go-ahead
  for removing the old one. Exits non-zero when any does not.

Rows are rewritten with raw SQL in keyset-ordered batches, one transaction per
batch (rows locked ``FOR UPDATE``), so a run can be stopped and re-run: values
already under the newest key are skipped. The per-row writes bypass model
signals on purpose - thousands of ciphertext-only "updates" would bury the
change log - and the run records one change-log entry with the counts instead.

A value no configured key opens is left alone and named by model and primary
key only (never its content), and the command exits non-zero.
"""
from __future__ import annotations

import getpass

from cryptography.fernet import InvalidToken
from django.apps import apps
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from monitoring.secrets import EncryptedJSONField, get_secrets_backend


def encrypted_columns() -> list[tuple[type, object]]:
    """Every (model, field) that stores an ``EncryptedJSONField`` column."""
    out = []
    for model in apps.get_models():
        opts = model._meta
        if opts.proxy or not opts.managed:
            continue
        for field in opts.local_concrete_fields:
            if isinstance(field, EncryptedJSONField):
                out.append((model, field))
    return sorted(out, key=lambda mf: (mf[0]._meta.label, mf[1].name))


class Command(BaseCommand):
    help = "Re-encrypt stored credentials under the newest MONITORING_SECRET_KEY."

    def add_arguments(self, parser):
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be re-encrypted, per model and field; write nothing.",
        )
        mode.add_argument(
            "--check",
            action="store_true",
            help="Verify every value decrypts under the first key (safe to drop the rest).",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=500,
            help="Rows per transaction (default 500).",
        )

    def handle(self, *args, **opts):
        backend = get_secrets_backend()
        if not (hasattr(backend, "rotate") and hasattr(backend, "is_current")):
            raise CommandError(
                "The configured MONITORING_SECRETS_BACKEND does not support key rotation."
            )
        batch = opts["batch_size"]
        if batch < 1:
            raise CommandError("--batch-size must be at least 1.")
        dry, check = opts["dry_run"], opts["check"]
        write = not (dry or check)

        totals = {"rotated": 0, "current": 0, "unreadable": 0}
        unreadable: list[str] = []
        per_field: dict[str, dict[str, int]] = {}
        for model, field in encrypted_columns():
            label = f"{model._meta.label}.{field.name}"
            counts, bad = self._walk(backend, model, field, batch, write)
            per_field[label] = counts
            for k in totals:
                totals[k] += counts[k]
            unreadable += [f"{model._meta.label} pk={pk}" for pk in bad]
            if any(counts.values()):
                self.stdout.write(self._line(label, counts, dry, check))

        keys = getattr(backend, "key_count", None)
        self.stdout.write(self._line("Total", totals, dry, check))
        if write:
            self._audit(totals, keys)
        for row in unreadable:
            self.stderr.write(f"cannot decrypt with any configured key: {row}")
        if unreadable:
            raise CommandError(f"{len(unreadable)} value(s) could not be decrypted with any key.")
        if check and totals["rotated"]:
            raise CommandError(
                f"{totals['rotated']} value(s) are still under an older key - "
                "run rotate_monitoring_key before removing it."
            )
        if check:
            self.stdout.write(self.style.SUCCESS("Every value decrypts under the first key."))

    @staticmethod
    def _line(label: str, counts: dict[str, int], dry: bool, check: bool) -> str:
        verb = "on an older key" if check else ("would rotate" if dry else "rotated")
        return (
            f"{label}: {counts['rotated']} {verb}, {counts['current']} current, "
            f"{counts['unreadable']} unreadable"
        )

    def _walk(self, backend, model, field, batch: int, write: bool):
        """Scan one column in pk order; re-encrypt stale values when ``write``."""
        qn = connection.ops.quote_name
        table, col, pkcol = qn(model._meta.db_table), qn(field.column), qn(model._meta.pk.column)
        base = f"SELECT {pkcol}, {col} FROM {table} WHERE {col} IS NOT NULL AND {col} <> ''"
        update = f"UPDATE {table} SET {col} = %s WHERE {pkcol} = %s"
        counts = {"rotated": 0, "current": 0, "unreadable": 0}
        bad: list = []
        last = None
        while True:
            with transaction.atomic():
                with connection.cursor() as cur:
                    where = "" if last is None else f" AND {pkcol} > %s"
                    params = ([] if last is None else [last]) + [batch]
                    lock = " FOR UPDATE" if write else ""
                    cur.execute(f"{base}{where} ORDER BY {pkcol} LIMIT %s{lock}", params)
                    rows = cur.fetchall()
                    for pk, raw in rows:
                        token = raw.encode()
                        if backend.is_current(token):
                            counts["current"] += 1
                            continue
                        try:
                            fresh = backend.rotate(token)
                        except (InvalidToken, ValueError, TypeError):
                            counts["unreadable"] += 1
                            bad.append(pk)
                            continue
                        counts["rotated"] += 1
                        if write:
                            cur.execute(update, [fresh.decode(), pk])
            if len(rows) < batch:
                return counts, bad
            last = rows[-1][0]

    @staticmethod
    def _audit(totals: dict[str, int], keys: int | None) -> None:
        from audit.models import ChangeAction, ChangeLogEntry

        try:
            who = getpass.getuser()
        except (KeyError, OSError):
            who = ""
        ChangeLogEntry.objects.create(
            tenant=None,
            user=None,
            user_name=who[:255],
            action=ChangeAction.UPDATE,
            object_type="monitoring.secretkey",
            object_label="Monitoring secret key",
            object_id="MONITORING_SECRET_KEY",
            object_repr="Key rotation",
            changes={
                "rotated": totals["rotated"],
                "already_current": totals["current"],
                "unreadable": totals["unreadable"],
                "keys_configured": keys,
            },
            via="system",
            cause="manage.py rotate_monitoring_key",
        )
