"""api 0184: the NOT NULL columns 0183 added to IP addresses carry a database
default, so a process still on the previous release can insert an address
while an upgrade is in flight."""
from __future__ import annotations

from django.db import connection
from django.test import TestCase

from core.models import Organization, Tenant

COLUMNS = {
    "monitoring_excluded": "false",
    "monitoring_excluded_by": "''",
    "monitoring_excluded_reason": "''",
    "availability_reset_by": "''",
    "availability_reset_reason": "''",
}


class IPAddressDbDefaultTests(TestCase):
    def test_columns_have_a_database_default(self):
        with connection.cursor() as cur:
            cur.execute(
                "SELECT column_name, column_default FROM information_schema.columns "
                "WHERE table_name = 'api_ipaddress' AND column_name = ANY(%s)",
                [list(COLUMNS)],
            )
            found = dict(cur.fetchall())
        self.assertEqual(set(found), set(COLUMNS))
        for column, expected in COLUMNS.items():
            with self.subTest(column=column):
                self.assertIsNotNone(found[column])
                self.assertTrue(found[column].startswith(expected), found[column])

    def test_an_insert_that_does_not_name_them_succeeds(self):
        """What the release before 0183 sends: none of the new columns."""
        from api.models import IPAddress, Prefix
        from api.test_utils import status_for

        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        prefix = Prefix.objects.create(
            tenant=tenant, cidr="192.0.2.0/24", status=status_for(tenant, "active"))
        new_names = set(COLUMNS) | {
            "monitoring_excluded_at", "availability_since", "availability_reset_at"}
        # The row the old ORM would insert: every column it knows about,
        # valued the way it values them, and none of the new ones.
        ip = IPAddress(tenant=tenant, prefix=prefix, ip_address="192.0.2.10/32")
        values: dict[str, object] = {}
        for field in IPAddress._meta.concrete_fields:
            if field.name in new_names:
                continue
            values[field.column] = field.get_db_prep_save(
                field.pre_save(ip, add=True), connection)
        cols = ", ".join(f'"{c}"' for c in values)
        marks = ", ".join(["%s"] * len(values))
        with connection.cursor() as cur:
            cur.execute(f'INSERT INTO "api_ipaddress" ({cols}) VALUES ({marks})', list(values.values()))
        saved = IPAddress.objects.get(pk=ip.pk)
        self.assertFalse(saved.monitoring_excluded)
        self.assertEqual(saved.monitoring_excluded_by, "")
        self.assertEqual(saved.availability_reset_reason, "")
