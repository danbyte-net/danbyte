"""NAT / port-forward documentation (#151).

The object records what a firewall is doing so the next person can answer
"what is 203.0.113.10:443?" without reading a rule base they may not have
access to. Nothing here is pushed to a device, and these tests say so by
covering the shape of the record and the arithmetic that stops someone
writing down a mapping no firewall could implement.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Device, DeviceRole, DeviceType, IPAddress, Manufacturer, NATRule, Prefix, Site
from .status_registry import seed_builtin_statuses

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        seed_builtin_statuses(self.tenant)
        self.site = Site.objects.create(tenant=self.tenant, name="HQ")
        vendor = Manufacturer.objects.create(
            tenant=self.tenant, name="Acme", slug="acme"
        )
        dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=vendor, model="FW-1"
        )
        role = DeviceRole.objects.create(
            tenant=self.tenant, name="Firewall", slug="firewall"
        )
        self.fw = Device.objects.create(
            tenant=self.tenant, name="fw1", device_type=dtype, role=role,
            site=self.site,
        )
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.10.20.0/24"
        )
        public_net = Prefix.objects.create(
            tenant=self.tenant, cidr="203.0.113.0/24"
        )
        self.public = IPAddress.objects.create(
            tenant=self.tenant, ip_address="203.0.113.10/32", prefix=public_net
        )
        self.private = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.10.20.15/24", prefix=self.prefix
        )
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def post(self, **over):
        body = {
            "name": "CRM HTTPS",
            "kind": "dnat",
            "protocol": "tcp",
            "device_id": str(self.fw.id),
            "external_ip_id": str(self.public.id),
            "external_ports": "443",
            "internal_ip_id": str(self.private.id),
            "internal_ports": "8443",
        }
        body.update(over)
        return self.client.post("/api/nat-rules/", body, format="json")


class NATRuleApiTests(_Base):
    def test_records_the_mapping_from_the_issue(self):
        resp = self.post(description="External access to CRM")
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["kind_display"], "Destination NAT (port forward)")
        self.assertEqual(body["external_ip"]["ip_address"], "203.0.113.10")
        self.assertEqual(body["external_ports"], "443")
        # A /32 is stored bare; a masked address keeps its length.
        self.assertEqual(body["internal_ip"]["ip_address"], "10.10.20.15/24")
        self.assertEqual(body["internal_ports"], "8443")
        self.assertEqual(body["device"]["name"], "fw1")

    def test_both_ends_may_be_blank(self):
        """A masquerade has no external address, and an address you have not
        recorded yet must not stop you writing the rule down."""
        resp = self.post(
            name="Outbound", kind="masquerade", protocol="any",
            external_ip_id=None, external_ports="",
            internal_ip_id=None, internal_ports="",
        )
        self.assertEqual(resp.status_code, 201, resp.content)

    def test_a_source_restriction_can_be_a_prefix(self):
        resp = self.post(source_prefix_id=str(self.prefix.id))
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["source_prefix"]["cidr"], "10.10.20.0/24")

    def test_filters_by_device_and_by_address(self):
        self.post()
        self.post(name="Other", external_ports="80", internal_ports="8080")
        n = len(self.client.get(
            f"/api/nat-rules/?device={self.fw.id}"
        ).json()["results"])
        self.assertEqual(n, 2)
        hits = self.client.get("/api/nat-rules/?search=8443").json()["results"]
        self.assertEqual([h["name"] for h in hits], ["CRM HTTPS"])

    def test_search_finds_it_by_public_address(self):
        self.post()
        hits = self.client.get(
            "/api/nat-rules/?search=203.0.113.10"
        ).json()["results"]
        self.assertEqual([h["name"] for h in hits], ["CRM HTTPS"])

    def test_deleting_the_firewall_keeps_the_rule(self):
        """Replacing the box does not mean the mapping stopped existing."""
        rule_id = self.post().json()["id"]
        self.fw.delete()
        rule = NATRule.objects.get(pk=rule_id)
        self.assertIsNone(rule.device_id)

    def test_scoped_to_the_active_tenant(self):
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        NATRule.objects.create(tenant=other, name="Theirs")
        self.post()
        names = [
            r["name"] for r in self.client.get("/api/nat-rules/").json()["results"]
        ]
        self.assertEqual(names, ["CRM HTTPS"])


class PortSpecTests(_Base):
    def test_accepts_a_port_and_a_range(self):
        self.assertEqual(self.post(external_ports="443").status_code, 201)
        self.assertEqual(
            self.post(name="R", external_ports="8000-8100",
                      internal_ports="9000-9100").status_code,
            201,
        )

    def test_rejects_nonsense(self):
        for ports, expect in (
            ("http", "Use a port"),
            ("99999", "1 to 65535"),
            ("8000-7000", "starts above"),
        ):
            resp = self.post(external_ports=ports)
            self.assertEqual(resp.status_code, 400, ports)
            self.assertIn(expect, str(resp.json()))

    def test_a_portless_protocol_may_not_carry_ports(self):
        resp = self.post(protocol="icmp", external_ports="80")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("carries no ports", str(resp.json()))

    def test_ranges_have_to_line_up(self):
        """8000-8100 → 443 is not a rule any firewall can implement, and a
        record of it would read as the truth."""
        resp = self.post(external_ports="8000-8100", internal_ports="443")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("range of the same size", str(resp.json()))

        resp = self.post(external_ports="8000-8100", internal_ports="9000-9200")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("different number of ports", str(resp.json()))

    def test_an_external_range_may_map_to_no_internal_port(self):
        """Forwarding a range straight through keeps the port numbers."""
        resp = self.post(external_ports="8000-8100", internal_ports="")
        self.assertEqual(resp.status_code, 201, resp.content)


class RegistrationTests(_Base):
    def test_statuses_are_seeded_for_nat_rules(self):
        names = [
            s["name"] for s in self.client.get(
                "/api/statuses/?available_to=natrule&picker=1"
            ).json()["results"]
        ]
        self.assertEqual(sorted(names), ["Active", "Disabled", "Planned"])

    def test_it_is_audited(self):
        from audit.apps import AUDITED_MODELS

        self.assertIn("api.NATRule", AUDITED_MODELS)

    def test_it_is_searchable(self):
        self.post()
        hits = self.client.get("/api/search/?q=CRM").json()["hits"]
        self.assertIn("natrule", [h["type"] for h in hits])
