"""The indexes behind the device and VM lists' natural order (#480) and prefix
containment (#484) exist, and the planner can serve the list queries from
them. The plans are asked for with sequential scans (and, for the order,
sorts) turned off: a test table is too small to prefer an index on cost, so
the question is whether the index matches the query at all."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import RIR, Aggregate, Cluster, ClusterType, Device, Prefix, VirtualMachine

User = get_user_model()


def _indexdef(table: str, name: str) -> str:
    with connection.cursor() as c:
        c.execute(
            "SELECT indexdef FROM pg_indexes WHERE tablename = %s AND indexname = %s",
            [table, name],
        )
        row = c.fetchone()
    return row[0] if row else ""


def _plan(sql: str, *, no_sort: bool = False) -> str:
    with connection.cursor() as cur:
        cur.execute("SET LOCAL enable_seqscan = off")
        if no_sort:
            cur.execute("SET LOCAL enable_sort = off")
        cur.execute("EXPLAIN " + sql)
        plan = "\n".join(row[0] for row in cur.fetchall())
        cur.execute("RESET enable_seqscan")
        cur.execute("RESET enable_sort")
    return plan


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _list_sql(self, url: str, table: str) -> tuple[list, str]:
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        sql = next(
            q["sql"] for q in ctx.captured_queries
            if q["sql"].startswith("SELECT") and f'FROM "{table}"' in q["sql"]
            and "LIMIT" in q["sql"]
        )
        return r.json()["results"], sql


class NaturalNameIndexTests(_Base):
    """Devices and VMs: a page is read off the tenant's natural-name index,
    not sorted out of the whole tenant (#480)."""

    def test_the_indexes_are_the_list_order(self):
        for table, name in (
            ("api_device", "device_tenant_natname_idx"),
            ("api_virtualmachine", "vm_tenant_natname_idx"),
        ):
            self.assertEqual(
                _indexdef(table, name),
                f"CREATE INDEX {name} ON public.{table} "
                "USING btree (tenant_id, name COLLATE natural_sort)",
            )

    def _assert_page_reads_the_index(self, url, table, index):
        rows, sql = self._list_sql(url, table)
        self.assertEqual([r["name"] for r in rows], ["sw1", "sw2"])
        plan = _plan(sql, no_sort=True)
        self.assertIn(index, plan)
        self.assertNotIn(f"Sort Key: {table}.name COLLATE natural_sort", plan)

    def test_device_page_reads_the_index_in_order(self):
        for n in ("sw10", "sw2", "sw1", "sw20"):
            Device.objects.create(tenant=self.tenant, name=n)
        self._assert_page_reads_the_index(
            "/api/devices/?page_size=2", "api_device", "device_tenant_natname_idx")

    def test_vm_page_reads_the_index_in_order(self):
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        cl = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        for n in ("sw10", "sw2", "sw1", "sw20"):
            VirtualMachine.objects.create(tenant=self.tenant, cluster=cl, name=n)
        self._assert_page_reads_the_index(
            "/api/virtual-machines/?page_size=2", "api_virtualmachine",
            "vm_tenant_natname_idx")


class PrefixInetIndexTests(_Base):
    def _plan_inet(self, sql: str) -> str:
        """Plan with the other prefix indexes dropped inside the test's
        transaction: on a three-row table the tenant index can win on cost
        depending on the statistics earlier tests left, which is not what
        these tests ask."""
        with connection.cursor() as cur:
            cur.execute("SET CONSTRAINTS ALL IMMEDIATE")
            cur.execute(
                "SELECT conname FROM pg_constraint"
                " WHERE conrelid = 'api_prefix'::regclass AND contype = 'u'"
            )
            for (name,) in cur.fetchall():
                cur.execute(f'ALTER TABLE api_prefix DROP CONSTRAINT "{name}"')
            cur.execute(
                "SELECT indexname FROM pg_indexes WHERE tablename = 'api_prefix'"
                " AND indexname NOT IN ('prefix_cidr_inet_gist', 'api_prefix_pkey')"
            )
            for (name,) in cur.fetchall():
                cur.execute(f'DROP INDEX "{name}"')
        return _plan(sql)

    def test_the_index_is_the_queries_cast(self):
        self.assertEqual(
            _indexdef("api_prefix", "prefix_cidr_inet_gist"),
            "CREATE INDEX prefix_cidr_inet_gist ON public.api_prefix "
            "USING gist (((cidr)::inet) inet_ops)",
        )

    def test_contained_in_uses_the_index(self):
        for c in ("10.1.0.0/16", "10.1.2.0/24", "10.2.0.0/24"):
            Prefix.objects.create(tenant=self.tenant, cidr=c)
        rows, sql = self._list_sql("/api/prefixes/?contained_in=10.1.0.0/16", "api_prefix")
        self.assertEqual([r["cidr"] for r in rows], ["10.1.0.0/16", "10.1.2.0/24"])
        self.assertIn("prefix_cidr_inet_gist", self._plan_inet(sql))

    def test_aggregate_coverage_uses_the_index(self):
        rir = RIR.objects.create(tenant=self.tenant, name="RFC1918", slug="rfc1918")
        Aggregate.objects.create(tenant=self.tenant, prefix="10.0.0.0/8", rir=rir)
        for c in ("10.1.0.0/16", "10.1.2.0/24", "10.2.0.0/24"):
            Prefix.objects.create(tenant=self.tenant, cidr=c)
        rows, sql = self._list_sql("/api/aggregates/?page_size=5", "api_aggregate")
        self.assertEqual(len(rows), 1)
        self.assertIn("prefix_cidr_inet_gist", self._plan_inet(sql))
