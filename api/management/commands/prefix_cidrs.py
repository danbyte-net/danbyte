"""List and fix prefixes whose cidr Postgres cannot read as an address (#501).

Migration ``api 0265`` rewrites what the prefix API would accept (spaces,
``10.0.20.0/255.255.255.0``) and stops the upgrade, changing nothing, while
any row is left it cannot rewrite. This command shows the same survey (the
migration's own code) and sets a row's cidr by hand. It uses only raw SQL on
columns every release has, so it runs before the upgrade's migrations have
(``MIGRATE_ON_START=0`` on Docker). Nothing is ever deleted.

    manage.py prefix_cidrs                  # list them and what 0265 does
    manage.py prefix_cidrs --check          # exit 1 while one can't be repaired
    manage.py prefix_cidrs --set ID CIDR    # give one a valid CIDR
"""
from __future__ import annotations

import importlib
import ipaddress

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

M0265 = importlib.import_module("api.migrations.0265_drop_unparseable_prefixes")


class Command(BaseCommand):
    help = "List prefixes whose cidr is not an address, and fix one by hand."

    def add_arguments(self, parser):
        parser.add_argument("--check", action="store_true",
                            help="Exit with an error while a prefix can't be repaired.")
        parser.add_argument("--set", nargs=2, metavar=("ID", "CIDR"),
                            help="Set that prefix's cidr (normalised as the API does).")

    def handle(self, *args, **options):
        if options["set"]:
            self._set(*options["set"])
            return
        rows = M0265.survey(connection)
        if not rows:
            self.stdout.write("Every prefix cidr is an address.")
            return
        stuck = [r for r in rows if r["new"] is None]
        for r in rows:
            if r["new"] is not None:
                self.stdout.write(f"rewrite {M0265.describe(r)} -> {r['new']!r}")
            else:
                self.stdout.write(f"cannot repair {M0265.describe(r)}: {r['why']}")
        self.stdout.write(
            f"{len(rows) - len(stuck)} will be rewritten by migration api.0265, "
            f"{len(stuck)} need a CIDR by hand."
        )
        if stuck:
            if options["check"]:
                raise CommandError(
                    f"{len(stuck)} prefix(es) hold a cidr the upgrade cannot repair; "
                    f"nothing has been changed.\n{M0265.FIX_HINT}"
                )
            self.stdout.write(M0265.FIX_HINT)

    def _set(self, pk: str, value: str) -> None:
        new, why = M0265.normalise(value)
        if new is None:
            raise CommandError(f"{value!r} is not a valid prefix: {why}.")
        with transaction.atomic(), connection.cursor() as cur:
            cur.execute("SELECT tenant_id, vrf_id, cidr FROM api_prefix WHERE id = %s"
                        " FOR UPDATE", [pk])
            row = cur.fetchone()
            if row is None:
                raise CommandError(f"No prefix {pk}.")
            tenant_id, vrf_id, old = row
            cur.execute(M0265._IS_INET)
            cur.execute("SELECT pg_temp.danbyte_is_inet(%s)", [old])
            if cur.fetchone()[0]:
                raise CommandError(
                    f"Prefix {pk} is {old!r}, already an address; edit it in Danbyte.")
            net = ipaddress.ip_network(new)
            cur.execute("SELECT id, cidr FROM api_prefix WHERE tenant_id = %s"
                        " AND vrf_id IS NOT DISTINCT FROM %s AND id <> %s",
                        [tenant_id, vrf_id, pk])
            for other, cidr in cur.fetchall():
                try:
                    same = ipaddress.ip_network(cidr.strip(), strict=False) == net
                except ValueError:
                    same = False
                if same:
                    raise CommandError(
                        f"{new} already exists in this VRF as prefix {other} ({cidr!r}).")
            cur.execute("SELECT count(*) FROM api_ipaddress WHERE prefix_id = %s"
                        " AND NOT (ip_address <<= %s::inet)", [pk, new])
            outside = cur.fetchone()[0]
            if outside:
                raise CommandError(
                    f"{outside} IP address(es) of prefix {pk} are not inside {new}; "
                    "choose a network that holds them.")
            cur.execute("UPDATE api_prefix SET cidr = %s WHERE id = %s", [new, pk])
        self._log(pk, tenant_id, old, new)
        self.stdout.write(f"prefix {pk}: {old!r} -> {new!r}")

    def _log(self, pk, tenant_id, old, new) -> None:
        """The change in the prefix's change log, when this release's audit
        table matches the schema (before the upgrade's migrations it may not)."""
        try:
            from audit.models import ChangeLogEntry

            with transaction.atomic():
                ChangeLogEntry.objects.create(
                    tenant_id=tenant_id, user=None, user_name="manage.py prefix_cidrs",
                    action="update", object_type="api.prefix", object_label="Prefix",
                    object_id=str(pk), object_repr=new[:255],
                    changes={"cidr": {"old": old, "new": new}},
                    via="system", cause="manage.py prefix_cidrs --set (#501)",
                )
        except Exception as exc:  # noqa: BLE001 - the fix itself is done
            self.stderr.write(f"(not written to the change log: {type(exc).__name__})")
