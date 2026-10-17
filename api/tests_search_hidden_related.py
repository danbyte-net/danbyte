"""Global search never answers through the name of a related row the caller
may not view (#413): a shared address bound to another site's device is not
found by that device's name, while the device a caller can see still finds
its addresses."""
from django.contrib.auth.models import User

from api.models import Device, Interface, IPAddress
from api.test_utils import status_for
from api.tests_site_scope_gaps import SiteBIpFixture
from auth_api.api import assemble_site_role


class SearchHiddenRelatedNameTests(SiteBIpFixture):
    def setUp(self):
        super().setUp()
        self.ip_shared.assigned_interface = self.eth0
        self.ip_shared.save()
        self.ip_shared.refresh_from_db()
        assert self.ip_shared.assigned_device_id == self.dev_b.id
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()

    def _hits(self, q):
        r = self.client.get("/api/search/", {"q": q})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _ids(self, q):
        return {h["id"] for h in self._hits(q)["hits"]}

    def test_hidden_device_name_does_not_find_shared_ip(self):
        body = self._hits("b-payroll-srv")
        self.assertNotIn(str(self.ip_shared.id), {h["id"] for h in body["hits"]})
        self.assertEqual(body["total"], len(body["hits"]))

    def test_partial_hidden_name_does_not_find_it_either(self):
        self.assertNotIn(str(self.ip_shared.id), self._ids("payroll-srv"))

    def test_interface_and_device_of_other_site_stay_out(self):
        ids = self._ids("b-payroll-srv")
        self.assertNotIn(str(self.dev_b.id), ids)
        self.assertNotIn(str(self.eth0.id), ids)

    def test_own_address_still_finds_it(self):
        self.assertIn(str(self.ip_shared.id), self._ids("10.250.0.9"))

    def test_own_text_still_finds_it(self):
        self.ip_shared.description = "uplink of b-payroll-srv"
        self.ip_shared.save()
        self.assertIn(str(self.ip_shared.id), self._ids("b-payroll-srv"))

    def test_visible_device_name_finds_its_address(self):
        dev_a = Device.objects.create(tenant=self.tenant, name="a-ledger-srv", site=self.site_a)
        eth = Interface.objects.create(device=dev_a, name="eth1")
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.250.0.44", prefix=self.pfx_shared,
            status=status_for(self.tenant), assigned_interface=eth,
        )
        self.assertIn(str(ip.id), self._ids("a-ledger-srv"))

    def test_superuser_finds_it_by_device_name(self):
        admin = User.objects.create_superuser("root", password="x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.assertIn(str(self.ip_shared.id), self._ids("b-payroll-srv"))


class SearchInterfaceOfHiddenDeviceTests(SiteBIpFixture):
    """An interface grant wider than the device grant: the interface is
    readable, its device is not, so the device's name finds nothing."""

    def setUp(self):
        super().setUp()
        self._grant(["interface"], sites=[])
        self._grant(["device"])
        self._login()

    def test_device_name_does_not_find_its_interface(self):
        r = self.client.get("/api/search/", {"q": "b-payroll-srv"})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(str(self.eth0.id), {h["id"] for h in r.json()["hits"]})

    def test_interface_name_still_finds_it(self):
        r = self.client.get("/api/search/", {"q": "eth0"})
        self.assertIn(str(self.eth0.id), {h["id"] for h in r.json()["hits"]})
