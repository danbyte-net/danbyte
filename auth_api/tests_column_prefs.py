"""Per-user table column layouts - /api/prefs/columns/<table_id>/.

A layout is ``order`` + ``hidden``, and since pinned columns an optional
``pinned`` list. Layouts saved before pins existed carry no ``pinned`` key and
must keep loading and saving unchanged.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from auth_api.column_prefs import _validate_payload
from auth_api.models import UserPreference, UserProfile
from core.models import Organization, Tenant


def _body(data) -> bytes:
    import json

    return json.dumps(data).encode()


class ValidatePayloadTests(SimpleTestCase):
    def test_old_layout_without_pins_keeps_its_shape(self):
        out = _validate_payload(_body({"order": ["name"], "hidden": ["x"]}))
        self.assertEqual(out, {"order": ["name"], "hidden": ["x"]})

    def test_pins_are_kept_in_order_without_duplicates(self):
        out = _validate_payload(_body({
            "order": ["name", "site"], "hidden": [],
            "pinned": ["site", "name", "site"],
        }))
        self.assertEqual(out["pinned"], ["site", "name"])

    def test_rejects_malformed_pins(self):
        for bad in ("name", [1], [None], {"name": True}):
            with self.subTest(pinned=bad), self.assertRaises(ValueError):
                _validate_payload(_body({"order": [], "hidden": [], "pinned": bad}))


class ColumnPrefPinsEndpointTests(APITestCase):
    URL = "/api/prefs/columns/devices/"

    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.user = User.objects.create_user("m", password="x")
        prof = UserProfile.objects.create(user=self.user, role="reader")
        prof.tenants.add(self.t)
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()

    def test_pins_round_trip(self):
        layout = {"order": ["name", "site"], "hidden": [], "pinned": ["name"]}
        r = self.client.put(self.URL, layout, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.get(self.URL)
        self.assertEqual(r.json()["data"], layout)

    def test_a_layout_saved_before_pins_still_loads(self):
        UserPreference.objects.create(
            user=self.user, tenant=self.t, table_id="devices",
            data={"order": ["name"], "hidden": ["site"]},
        )
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["data"], {"order": ["name"], "hidden": ["site"]})

    def test_bad_pins_are_refused(self):
        r = self.client.put(
            self.URL, {"order": [], "hidden": [], "pinned": "name"}, format="json"
        )
        self.assertEqual(r.status_code, 400)
