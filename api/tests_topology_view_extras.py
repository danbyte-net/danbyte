"""``api.topology_view_extras``: the saved-view keys for the Diagram's
virtual chassis stacks and a band's cable sides, alone and through the
topology views API."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework import serializers
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .topology_view_extras import validate_view_extras

User = get_user_model()

VC = "7c1d5e92-3b6f-4a0d-8e47-1b9c2d5f6e05"
VC2 = "9e4b0a7d-5c1e-4d83-b2f6-8a3d7c1e9f06"


class ValidatorTests(SimpleTestCase):
    def ok(self, state):
        return validate_view_extras(state)

    def bad(self, state, needle):
        with self.assertRaises(serializers.ValidationError) as ctx:
            validate_view_extras(state)
        self.assertIn(needle, str(ctx.exception.detail))

    def test_well_formed_keys_pass(self):
        state = {
            "chassis": {VC: {"orient": "h"}, VC2: {"off": True}},
            "filters": {"chassis": [VC, VC2, VC], "diagram": {"chassis": "v"}},
            "zones_by_style": {
                "diagram": [{"id": "r", "exits": "v"}, {"id": "s", "exits": "h"}]
            },
        }
        out = self.ok(state)
        self.assertEqual(out["filters"]["chassis"], [VC, VC2])

    def test_absent_keys_pass(self):
        self.ok({})
        self.ok({"filters": {"devices": []}, "zones_by_style": {"hierarchy": []}})
        self.ok({"filters": {"chassis": None, "diagram": {"mode": "simple"}}})

    def test_chassis_settings(self):
        self.bad({"chassis": []}, "chassis must be an object")
        self.bad({"chassis": {"nope": {}}}, "not a virtual chassis id")
        self.bad({"chassis": {VC: "v"}}, f"chassis.{VC} must be an object")
        self.bad({"chassis": {VC: {"orient": "x"}}}, "orient must be one of v, h")
        self.bad({"chassis": {VC: {"off": 1}}}, "off must be true or false")
        self.bad({"chassis": {VC: {"color": "red"}}}, "unknown key(s) color")

    def test_the_caps(self):
        many = {f"00000000-0000-4000-8000-{i:012d}": {} for i in range(10_001)}
        self.bad({"chassis": many}, "at most 10,000")
        placed = [f"00000000-0000-4000-8000-{i:012d}" for i in range(1_001)]
        self.bad({"filters": {"chassis": placed}}, "at most 1,000")

    def test_placed_chassis(self):
        self.bad({"filters": {"chassis": "x"}}, "filters.chassis must be a list")
        self.bad({"filters": {"chassis": ["x"]}}, "filters.chassis must be a list")

    def test_stacking_and_exits(self):
        self.bad(
            {"filters": {"diagram": {"chassis": "yes"}}},
            "filters.diagram.chassis must be one of off, v, h",
        )
        self.bad(
            {"zones_by_style": {"diagram": [{"id": "r", "exits": "up"}]}},
            "zones_by_style.diagram[0].exits must be one of v, h",
        )


class ThroughTheApiTests(APITestCase):
    """Wired into ``TopologyViewSerializer.validate_state``."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.client.force_login(
            User.objects.create_superuser("admin", "a@example.com", "x")
        )
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _save(self, state):
        return self.client.post(
            "/api/topology-views/", {"name": "v", "state": state}, format="json"
        )

    def test_the_keys_round_trip(self):
        state = {
            "chassis": {VC: {"orient": "h"}},
            "filters": {"devices": [], "chassis": [VC, VC],
                        "diagram": {"chassis": "v"}},
            "zones_by_style": {"diagram": [
                {"id": "r", "kind": "band", "orient": "h", "label": "Access",
                 "x": 0, "y": 0, "w": 800, "h": 200, "color": None,
                 "exits": "h"},
            ]},
            "positions_by_style": {"diagram": {f"vc:{VC}": [10, 20]}},
        }
        r = self._save(state)
        self.assertEqual(r.status_code, 201, r.content)
        got = self.client.get(f"/api/topology-views/{r.json()['id']}/").json()
        self.assertEqual(got["state"]["chassis"], {VC: {"orient": "h"}})
        self.assertEqual(got["state"]["filters"]["chassis"], [VC])
        self.assertEqual(got["state"]["zones_by_style"]["diagram"][0]["exits"], "h")

    def test_a_bad_key_is_a_400(self):
        r = self._save({"filters": {"diagram": {"chassis": "sideways"}}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("filters.diagram.chassis", str(r.content))
