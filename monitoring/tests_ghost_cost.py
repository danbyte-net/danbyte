"""The topology map's ghost links cost the LLDP rows, not the tenant's
cables (#528).

Every call loaded each cable of the tenant with its terminations, ports and
devices as model objects, even when no device had an LLDP neighbour."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Cable, CableTermination, Device, FrontPort, Interface, RearPort, Site
from auth_api.api import assemble_site_role
from auth_api.models import UserProfile
from core.models import Organization, Tenant

from .models import DeviceSnmp
from .snmp_topology import _cabled_pairs

URL = "/api/monitoring/topology/ghosts/"


class GhostCostTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="X", slug="x")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.n = 0
        self.admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _cabled(self, n, site=None):
        """``n`` cabled device pairs, one end on a front port every third."""
        out = []
        for _ in range(n):
            i = self.n
            self.n += 1
            a = Device.objects.create(tenant=self.tenant, name=f"a{i}", site=site or self.site_a)
            b = Device.objects.create(tenant=self.tenant, name=f"b{i}", site=site or self.site_a)
            ia = Interface.objects.create(device=a, name="eth0")
            cable = Cable.objects.create(tenant=self.tenant)
            CableTermination.objects.create(cable=cable, end="A", interface=ia)
            if i % 3:
                CableTermination.objects.create(
                    cable=cable, end="B", interface=Interface.objects.create(device=b, name="eth0"))
            else:
                CableTermination.objects.create(
                    cable=cable, end="B", front_port=FrontPort.objects.create(
                        device=b, name="f1",
                        rear_port=RearPort.objects.create(device=b, name="r1")))
            out.append((a, b))
        return out

    def _snmp(self, device, neighbours):
        DeviceSnmp.objects.update_or_create(
            tenant=self.tenant, device=device,
            defaults={"reachable": True, "polled_at": timezone.now(),
                      "data": {"sys_name": device.name}, "neighbors": neighbours},
        )

    def _queries(self, **params):
        self.client.get(URL, params)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(URL, params)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json()["edges"], [q["sql"] for q in ctx.captured_queries]

    def test_no_neighbours_reads_no_cable(self):
        self._cabled(5)
        n, edges, sql = self._queries()
        self.assertEqual(edges, [])
        self.assertFalse([s for s in sql if "api_cable" in s], "no cable is read")
        self._cabled(20)
        self.assertEqual(self._queries()[0], n)

    def test_cost_is_flat_in_cables_and_cabled_pairs_stay_hidden(self):
        pairs = self._cabled(4)
        (a, b), (c, d) = pairs[0], pairs[1]
        # a-b and c-d are cabled (one on a front port); a-c is not.
        self._snmp(a, [{"local_port": "eth0", "remote_device": b.name, "remote_port": "f1"},
                       {"local_port": "eth1", "remote_device": c.name, "remote_port": "eth1"}])
        self._snmp(c, [{"local_port": "eth0", "remote_device": d.name, "remote_port": "eth0"}])
        n, edges, _ = self._queries()
        self.assertEqual(
            [{e["source"], e["target"]} for e in edges], [{f"dev:{a.id}", f"dev:{c.id}"}])
        self._cabled(30)
        # Another tenant's cables are not read either.
        Cable.objects.create(tenant=self.other)
        n2, edges2, _ = self._queries()
        self.assertEqual(n2, n)
        self.assertEqual(edges2, edges)

    def test_pairs_match_the_cables(self):
        pairs = self._cabled(6)
        ids = {d.id for p in pairs for d in p}
        got = _cabled_pairs(self.tenant, ids)
        self.assertEqual(got, {frozenset((str(a.id), str(b.id))) for a, b in pairs})
        # Only the devices asked about.
        a, b = pairs[0]
        self.assertEqual(_cabled_pairs(self.tenant, {a.id, b.id}),
                         {frozenset((str(a.id), str(b.id)))})

    def test_a_site_viewer_sees_no_other_sites_ghost(self):
        (a, b), = self._cabled(1)
        far = Device.objects.create(tenant=self.tenant, name="far", site=self.site_b)
        self._snmp(a, [{"local_port": "eth9", "remote_device": "far", "remote_port": "x"}])
        self._snmp(far, [{"local_port": "x", "remote_device": a.name, "remote_port": "eth9"}])
        _, edges, _ = self._queries()
        self.assertEqual(len(edges), 1)
        user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[user.id])
        self._login(user)
        _, edges, _ = self._queries()
        self.assertEqual(edges, [])
