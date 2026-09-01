"""Link aggregation: the aggregate is an interface of type "lag" carrying the
bundle's protocol; members point `lag` at it."""
from __future__ import annotations

import importlib

from django.apps import apps
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, Interface, VirtualChassis
from core.models import Organization, Tenant


class _LagBase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.dev = Device.objects.create(tenant=self.tenant, name="sw1")
        self.other = Device.objects.create(tenant=self.tenant, name="sw2")
        self.po = Interface.objects.create(device=self.dev, name="Po1", type="lag")
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _post(self, **body):
        body.setdefault("device_id", str(self.dev.id))
        return self.client.post("/api/interfaces/", body, format="json")


class LagRulesTests(_LagBase):
    def test_type_lag_implies_virtual(self):
        r = self._post(name="Po2", type="lag", virtual=False)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(r.json()["virtual"])

    def test_member_requires_lag_typed_aggregate(self):
        eth = Interface.objects.create(device=self.dev, name="eth9", type="1000base-t")
        r = self._post(name="eth1", lag_id=str(eth.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("type LAG", r.json()["lag_id"][0])

    def test_legacy_member_edit_without_lag_in_payload_saves(self):
        # An aggregate typed as physical media (pre-rule data) keeps its
        # members editable - only re-picking the LAG asks for the fix.
        legacy = Interface.objects.create(device=self.dev, name="ae9", type="1000base-t")
        member = Interface.objects.create(device=self.dev, name="eth2", lag=legacy)
        r = self.client.patch(
            f"/api/interfaces/{member.id}/", {"description": "uplink"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(
            f"/api/interfaces/{member.id}/", {"lag_id": str(legacy.id)}, format="json"
        )
        self.assertEqual(r.status_code, 400)

    def test_aggregate_cannot_be_member(self):
        r = self._post(name="Po2", type="lag", lag_id=str(self.po.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("aggregate", r.json()["lag_id"][0])

    def test_type_change_with_members_rejected(self):
        Interface.objects.create(device=self.dev, name="eth1", lag=self.po)
        r = self.client.patch(
            f"/api/interfaces/{self.po.id}/", {"type": "virtual"}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("LAG members", r.json()["type"][0])

    def test_bundle_fields_on_non_lag_rejected(self):
        r = self._post(name="eth1", lag_protocol="lacp")
        self.assertEqual(r.status_code, 400)
        self.assertIn("type LAG", r.json()["lag_protocol"][0])

    def test_lacp_fields_cleared_when_static(self):
        r = self.client.patch(
            f"/api/interfaces/{self.po.id}/",
            {"lag_protocol": "", "lacp_mode": "active", "lacp_rate": "fast"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["lacp_mode"], "")
        self.assertEqual(r.json()["lacp_rate"], "")
        # Model-level too (shell/import paths).
        self.po.lag_protocol, self.po.lacp_mode = "", "passive"
        self.po.save()
        self.po.refresh_from_db()
        self.assertEqual(self.po.lacp_mode, "")

    def test_lacp_settings_round_trip(self):
        r = self.client.patch(
            f"/api/interfaces/{self.po.id}/",
            {"lag_protocol": "lacp", "lacp_mode": "active", "lacp_rate": "fast",
             "lag_min_links": 2},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["lag_protocol_display"], "LACP (802.3ad)")
        self.assertEqual((body["lacp_mode"], body["lacp_rate"], body["lag_min_links"]),
                         ("active", "fast", 2))

    def test_min_links_zero_rejected(self):
        r = self.client.patch(
            f"/api/interfaces/{self.po.id}/", {"lag_min_links": 0}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("lag_min_links", r.json())

    def test_lag_mini_carries_protocol(self):
        self.po.lag_protocol, self.po.lacp_mode = "lacp", "active"
        self.po.save()
        r = self._post(name="eth1", lag_id=str(self.po.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["lag"]["lag_protocol"], "lacp")
        self.assertEqual(r.json()["lag"]["lacp_mode"], "active")

    def test_cross_vc_member_still_ok(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(id__in=[self.dev.id, self.other.id]).update(virtual_chassis=vc)
        r = self._post(device_id=str(self.other.id), name="eth1", lag_id=str(self.po.id))
        self.assertEqual(r.status_code, 201, r.content)


class LagFilterAndBulkTests(_LagBase):
    def test_filters_type_and_lag(self):
        Interface.objects.create(device=self.dev, name="eth1", lag=self.po)
        Interface.objects.create(device=self.dev, name="eth2")
        typed = self.client.get("/api/interfaces/?type=lag").json()["results"]
        self.assertEqual([i["name"] for i in typed], ["Po1"])
        members = self.client.get(f"/api/interfaces/?lag={self.po.id}").json()["results"]
        self.assertEqual([i["name"] for i in members], ["eth1"])

    def test_bulk_update_normalises(self):
        po2 = Interface.objects.create(
            device=self.dev, name="Po2", type="lag", lag_protocol="lacp", lacp_mode="active"
        )
        r = self.client.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(po2.id)], "fields": {"lag_protocol": ""}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        po2.refresh_from_db()
        self.assertEqual(po2.lacp_mode, "")
        eth = Interface.objects.create(device=self.dev, name="eth1")
        r = self.client.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(eth.id)], "fields": {"type": "lag"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        eth.refresh_from_db()
        self.assertTrue(eth.virtual)

    def test_choices_endpoint_has_lag_vocab(self):
        body = self.client.get("/api/dcim/choices/").json()
        self.assertEqual([c["value"] for c in body["lag_protocols"]], ["lacp", "pagp"])
        self.assertEqual([c["value"] for c in body["lacp_modes"]], ["active", "passive"])
        self.assertEqual([c["value"] for c in body["lacp_rates"]], ["slow", "fast"])


class LagBackfillTests(_LagBase):
    def test_backfill_promotes_untyped_aggregates(self):
        mig = importlib.import_module("api.migrations.0153_interface_lag_protocol")
        untyped = Interface.objects.create(device=self.dev, name="ae1", type="")
        virt = Interface.objects.create(device=self.dev, name="ae2", type="virtual")
        physical = Interface.objects.create(device=self.dev, name="ae3", type="1000base-t")
        lonely = Interface.objects.create(device=self.dev, name="ae4", type="")
        for agg in (untyped, virt, physical):
            Interface.objects.create(device=self.dev, name=f"m-{agg.name}", lag=agg)
        mig.promote_untyped_aggregates(apps, None)
        for agg, expect in ((untyped, "lag"), (virt, "lag"), (physical, "1000base-t"),
                            (lonely, "")):
            agg.refresh_from_db()
            self.assertEqual(agg.type, expect, agg.name)
        self.assertTrue(Interface.objects.get(pk=untyped.pk).virtual)


class LagSummaryTests(_LagBase):
    """`GET /api/interfaces/<id>/lag/` - members, capacity, peers, min links."""

    def _cable(self, a, b):
        from api.models import Cable, CableTermination

        cab = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cab, end="A", interface=a)
        CableTermination.objects.create(cable=cab, end="B", interface=b)
        return cab

    def _members(self, *speeds):
        return [
            Interface.objects.create(
                device=self.dev, name=f"eth{i}", lag=self.po, speed=s
            )
            for i, s in enumerate(speeds, start=1)
        ]

    def test_capacity_and_single_peer(self):
        m1, m2 = self._members("10G", "10 Gbps")
        po10 = Interface.objects.create(device=self.other, name="Po10", type="lag")
        for n, m in enumerate((m1, m2), start=1):
            far = Interface.objects.create(device=self.other, name=f"eth{n}", lag=po10)
            self._cable(m, far)
        body = self.client.get(f"/api/interfaces/{self.po.id}/lag/").json()
        self.assertEqual(body["count"], 2)
        self.assertEqual([r["name"] for r in body["results"]], ["eth1", "eth2"])
        self.assertEqual((body["capacity_mbps"], body["capacity"]), (20000, "20 Gbps"))
        self.assertEqual(body["unparsed_speeds"], 0)
        self.assertEqual(
            [(p["name"], p["device"]["name"], p["members"]) for p in body["peers"]],
            [("Po10", "sw2", 2)],
        )
        self.assertEqual(body["unpaired"], [])
        self.assertFalse(body["mixed_peers"])

    def test_mixed_peers_and_unpaired(self):
        m1, m2, m3 = self._members("10G", "", "10G")
        core2 = Device.objects.create(tenant=self.tenant, name="core2")
        po_a = Interface.objects.create(device=self.other, name="Po10", type="lag")
        po_b = Interface.objects.create(device=core2, name="Po10", type="lag")
        self._cable(m1, Interface.objects.create(device=self.other, name="e1", lag=po_a))
        self._cable(m2, Interface.objects.create(device=core2, name="e1", lag=po_b))
        # m3: cabled to a port that is in no bundle.
        self._cable(m3, Interface.objects.create(device=core2, name="e2"))
        body = self.client.get(f"/api/interfaces/{self.po.id}/lag/").json()
        self.assertTrue(body["mixed_peers"])
        self.assertEqual({p["device"]["name"] for p in body["peers"]}, {"sw2", "core2"})
        self.assertEqual(body["unpaired"], ["eth3"])
        self.assertEqual(body["unparsed_speeds"], 1)
        self.assertEqual(body["capacity"], "20 Gbps")

    def test_min_links_verdict(self):
        self._members("1G")
        self.po.lag_min_links = 2
        self.po.save()
        body = self.client.get(f"/api/interfaces/{self.po.id}/lag/").json()
        self.assertEqual(body["min_links"], 2)
        self.assertTrue(body["degraded"])
        self.assertEqual(body["unpaired"], ["eth1"])

    def test_non_aggregate_answers_empty(self):
        eth = Interface.objects.create(device=self.dev, name="eth9")
        body = self.client.get(f"/api/interfaces/{eth.id}/lag/").json()
        self.assertEqual(body["count"], 0)
        self.assertIsNone(body["capacity_mbps"])
        self.assertFalse(body["degraded"])
