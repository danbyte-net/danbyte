"""IP addresses are stored as bare hosts.

PostgreSQL's ``inet`` keeps a mask it is given, and Django checks an address
only in ``full_clean()``. An ORM write that skipped it (a shell, a script)
stored ``192.173.199.250/24``; ``ipaddress.ip_address()`` rejects that value,
and the prefix's address list failed with a 500. The field now drops the mask
on every write, reads one left in the database as the bare host, and api 0185
normalises the rows already stored with one.
"""

from __future__ import annotations

import importlib

from django.apps import apps as global_apps
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import VRF, IPAddress, Prefix
from .test_utils import status_for

User = get_user_model()


def _stored(ip):
    """What the column holds: the host and the mask length, from SQL."""
    with connection.cursor() as cur:
        cur.execute(
            "SELECT host(ip_address), masklen(ip_address) FROM api_ipaddress WHERE id = %s",
            [ip.pk],
        )
        return cur.fetchone()


def _store_raw(ip, value):
    """Write a value the way a pre-0185 ORM write did: straight to inet."""
    with connection.cursor() as cur:
        cur.execute("UPDATE api_ipaddress SET ip_address = %s::inet WHERE id = %s", [value, ip.pk])


class _Fixture:
    def make_tenant(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.active = status_for(self.tenant, "active")
        self.p24 = Prefix.objects.create(
            tenant=self.tenant, cidr="192.0.2.0/24", status=self.active
        )
        self.p48 = Prefix.objects.create(
            tenant=self.tenant, cidr="2001:db8::/48", status=self.active
        )

    def ip(self, address, prefix=None, **kw):
        return IPAddress.objects.create(
            tenant=self.tenant,
            prefix=prefix or self.p24,
            ip_address=address,
            status=self.active,
            **kw,
        )


class InetKeepsAMaskTests(TestCase):
    def test_postgres_stores_the_mask_it_is_given(self):
        """The root of the bug: inet keeps ``/24`` and Django reads it back
        as the text ``ipaddress.ip_address()`` rejects. A full-length mask is
        not shown."""
        with connection.cursor() as cur:
            cur.execute("SELECT '192.173.199.250/24'::inet, '192.0.2.1/32'::inet")
            self.assertEqual(cur.fetchone(), ("192.173.199.250/24", "192.0.2.1"))


class WriteDropsTheMaskTests(_Fixture, TestCase):
    def setUp(self):
        self.make_tenant()

    def test_create_with_the_prefix_length_stores_the_host(self):
        """The dev-DB rows: ``/24`` inside a /24 - no own mask length."""
        ip = self.ip("192.0.2.250/24")
        self.assertEqual(_stored(ip), ("192.0.2.250", 32))
        ip.refresh_from_db()
        self.assertEqual(ip.ip_address, "192.0.2.250")
        self.assertIsNone(ip.mask_length)
        self.assertEqual(ip.cidr, "192.0.2.250/24")

    def test_a_different_length_moves_to_mask_length(self):
        ip = self.ip("192.0.2.1/31")
        self.assertEqual(_stored(ip), ("192.0.2.1", 32))
        ip.refresh_from_db()
        self.assertEqual(ip.mask_length, 31)
        self.assertEqual(ip.cidr, "192.0.2.1/31")

    def test_an_explicit_mask_length_wins(self):
        ip = self.ip("192.0.2.3/31", mask_length=30)
        ip.refresh_from_db()
        self.assertEqual((ip.ip_address, ip.mask_length), ("192.0.2.3", 30))

    def test_ipv6(self):
        ip = self.ip("2001:db8::5/64", prefix=self.p48)
        self.assertEqual(_stored(ip), ("2001:db8::5", 128))
        ip.refresh_from_db()
        self.assertEqual(ip.mask_length, 64)

    def test_scoped_save_keeps_the_length(self):
        ip = self.ip("192.0.2.9")
        ip.ip_address = "192.0.2.9/30"
        ip.save(update_fields=["ip_address"])
        self.assertEqual(_stored(ip), ("192.0.2.9", 32))
        ip.refresh_from_db()
        self.assertEqual(ip.mask_length, 30)

    def test_an_update_takes_the_new_length(self):
        """The mask_length a row was loaded with is not an explicit one: the
        address's length replaces it, as a PATCH with address/length does."""
        ip = self.ip("192.0.2.1/31")
        ip.ip_address = "192.0.2.1/30"
        ip.save()
        ip.refresh_from_db()
        self.assertEqual((ip.ip_address, ip.mask_length), ("192.0.2.1", 30))

    def test_an_update_to_the_prefix_length_clears_it(self):
        ip = self.ip("192.0.2.1/31")
        ip.ip_address = "192.0.2.1/24"
        ip.save(update_fields=["ip_address"])
        ip.refresh_from_db()
        self.assertIsNone(ip.mask_length)
        self.assertEqual(ip.cidr, "192.0.2.1/24")

    def test_an_update_without_a_length_keeps_mask_length(self):
        ip = self.ip("192.0.2.1/31")
        ip.ip_address = "192.0.2.0"
        ip.save()
        ip.refresh_from_db()
        self.assertEqual((ip.ip_address, ip.mask_length), ("192.0.2.0", 31))

    def test_bulk_create_and_update_skip_save_but_not_the_field(self):
        (ip,) = IPAddress.objects.bulk_create(
            [
                IPAddress(
                    tenant=self.tenant,
                    prefix=self.p24,
                    ip_address="192.0.2.20/24",
                    status=self.active,
                )
            ]
        )
        self.assertEqual(_stored(ip), ("192.0.2.20", 32))
        IPAddress.objects.filter(pk=ip.pk).update(ip_address="192.0.2.21/24")
        self.assertEqual(_stored(ip), ("192.0.2.21", 32))

    def test_a_masked_lookup_finds_the_host(self):
        ip = self.ip("192.0.2.30")
        self.assertEqual(IPAddress.objects.get(ip_address="192.0.2.30/24").pk, ip.pk)
        _, created = IPAddress.objects.get_or_create(
            tenant=self.tenant,
            vrf=None,
            ip_address="192.0.2.30/24",
            defaults={"prefix": self.p24, "status": self.active},
        )
        self.assertFalse(created)

    def test_an_invalid_value_is_still_rejected(self):
        from django.db import DataError, transaction

        with self.assertRaises(DataError), transaction.atomic():
            self.ip("192.0.2.1/33")


class MaskedRowReadsAsHostTests(_Fixture, TestCase):
    """A row left masked (0185 reports those it cannot fix) reads as a host."""

    def setUp(self):
        self.make_tenant()

    def test_model_and_values_list(self):
        ip = self.ip("192.0.2.250")
        _store_raw(ip, "192.0.2.250/24")
        self.assertEqual(_stored(ip), ("192.0.2.250", 24))
        self.assertEqual(IPAddress.objects.get(pk=ip.pk).ip_address, "192.0.2.250")
        self.assertEqual(
            list(IPAddress.objects.filter(pk=ip.pk).values_list("ip_address", flat=True)),
            ["192.0.2.250"],
        )


class PrefixIpsEndpointTests(_Fixture, APITestCase):
    def setUp(self):
        self.make_tenant()
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _addresses(self):
        r = self.client.get(f"/api/prefixes/{self.p24.id}/ips/")
        self.assertEqual(r.status_code, 200, r.content)
        return [row["ip_address"] for row in r.json()["results"]]

    def test_sorted_numerically(self):
        for a in ("192.0.2.100", "192.0.2.10", "192.0.2.2"):
            self.ip(a)
        self.assertEqual(self._addresses(), ["192.0.2.2", "192.0.2.10", "192.0.2.100"])

    def test_a_masked_row_does_not_fail_the_list(self):
        self.ip("192.0.2.2")
        masked = self.ip("192.0.2.250")
        _store_raw(masked, "192.0.2.250/24")
        self.assertCountEqual(self._addresses(), ["192.0.2.2", "192.0.2.250"])

    def test_a_masked_duplicate_sorts_beside_its_address(self):
        """0185 leaves a row masked when its host is taken. inet orders on
        the network bits, then the mask, so ORDER BY ip_address would put
        192.0.2.40/24 before every host in the /24."""
        for a in ("192.0.2.100", "192.0.2.40", "192.0.2.10", "192.0.2.2"):
            self.ip(a)
        masked = self.ip("192.0.2.41")
        _store_raw(masked, "192.0.2.40/24")
        self.assertEqual(
            self._addresses(),
            ["192.0.2.2", "192.0.2.10", "192.0.2.40", "192.0.2.40", "192.0.2.100"],
        )

    def test_a_masked_row_is_not_offered_as_free_in_its_range(self):
        """The range's free list skipped an address it could not parse, so a
        masked row's address showed as available."""
        from .models import IPRange

        rng = IPRange.objects.create(
            tenant=self.tenant,
            prefix=self.p24,
            start_address="192.0.2.249",
            end_address="192.0.2.251",
        )
        masked = self.ip("192.0.2.250")
        _store_raw(masked, "192.0.2.250/24")
        r = self.client.get(f"/api/ip-ranges/{rng.id}/available/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["results"], ["192.0.2.249", "192.0.2.251"])


class NormaliseMigrationTests(_Fixture, TestCase):
    def setUp(self):
        self.make_tenant()

    def normalise(self):
        mod = importlib.import_module("api.migrations.0185_ipaddress_host_address")
        mod.normalise(global_apps, None)

    def test_masked_rows_become_hosts(self):
        same = self.ip("192.0.2.250")
        _store_raw(same, "192.0.2.250/24")
        link = self.ip("192.0.2.1")
        _store_raw(link, "192.0.2.1/31")
        kept = self.ip("192.0.2.5", mask_length=30)
        _store_raw(kept, "192.0.2.5/29")
        v6 = self.ip("2001:db8::5", prefix=self.p48)
        _store_raw(v6, "2001:db8::5/64")
        untouched = self.ip("192.0.2.9")

        with self.assertLogs("danbyte.migrations", "INFO") as logs:
            self.normalise()
        self.assertEqual(len(logs.records), 1)
        self.assertIn("Stored 4", logs.output[0])

        expected = (
            (same, ("192.0.2.250", 32), None),
            (link, ("192.0.2.1", 32), 31),
            (kept, ("192.0.2.5", 32), 30),
            (v6, ("2001:db8::5", 128), 64),
        )
        for ip, stored, mask_length in expected:
            with self.subTest(stored=stored):
                self.assertEqual(_stored(ip), stored)
                ip.refresh_from_db()
                self.assertEqual(ip.mask_length, mask_length)
        self.assertEqual(_stored(untouched), ("192.0.2.9", 32))

    def test_running_again_changes_nothing(self):
        ip = self.ip("192.0.2.250")
        _store_raw(ip, "192.0.2.250/24")
        with self.assertLogs("danbyte.migrations", "INFO"):
            self.normalise()
        with self.assertNoLogs("danbyte.migrations"):
            self.normalise()
        self.assertEqual(_stored(ip), ("192.0.2.250", 32))

    def test_a_collision_is_reported_not_merged(self):
        bare = self.ip("192.0.2.40")
        masked = self.ip("192.0.2.41")
        # inet equality includes the mask, so the constraint let both in.
        _store_raw(masked, "192.0.2.40/24")
        with self.assertLogs("danbyte.migrations", "WARNING") as logs:
            self.normalise()
        self.assertEqual(len(logs.records), 1)
        self.assertIn(str(masked.pk), logs.output[0])
        self.assertIn(str(bare.pk), logs.output[0])
        self.assertEqual(_stored(masked), ("192.0.2.40", 24))
        self.assertEqual(_stored(bare), ("192.0.2.40", 32))
        self.assertEqual(IPAddress.objects.count(), 2)

    def test_two_masked_rows_sharing_a_host(self):
        first = self.ip("192.0.2.50")
        _store_raw(first, "192.0.2.50/24")
        second = self.ip("192.0.2.51")
        _store_raw(second, "192.0.2.50/25")
        with self.assertLogs("danbyte.migrations", "INFO") as logs:
            self.normalise()
        self.assertEqual(_stored(first), ("192.0.2.50", 32))
        self.assertEqual(_stored(second), ("192.0.2.50", 25))
        self.assertTrue(any(str(second.pk) in line for line in logs.output))

    def test_the_same_host_in_another_vrf_is_not_a_collision(self):
        vrf = VRF.objects.create(tenant=self.tenant, name="Blue")
        blue = Prefix.objects.create(
            tenant=self.tenant, vrf=vrf, cidr="192.0.2.0/24", status=self.active
        )
        self.ip("192.0.2.60", prefix=blue)
        masked = self.ip("192.0.2.60")
        _store_raw(masked, "192.0.2.60/24")
        with self.assertLogs("danbyte.migrations", "INFO") as logs:
            self.normalise()
        self.assertNotIn("WARNING", " ".join(logs.output))
        self.assertEqual(_stored(masked), ("192.0.2.60", 32))
