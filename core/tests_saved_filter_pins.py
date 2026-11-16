"""A pinned saved view is its list's default (#523): yours, else the tenant's."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import UserProfile
from core.models import Organization, SavedFilterDefault, Tenant


class SavedFilterPinTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Rival", slug="rival")
        self.alice = self._user("alice", self.tenant)
        self.bob = self._user("bob", self.tenant)
        self.mallory = self._user("mallory", self.other)
        self.admin = self._user("root", self.tenant)
        self.admin.is_superuser = True
        self.admin.save()

    def _user(self, name, tenant):
        user = User.objects.create_user(name, f"{name}@x.com", "pw")
        profile, _ = UserProfile.objects.get_or_create(user=user)
        profile.tenants.add(tenant)
        return user

    def _as(self, user, tenant=None):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str((tenant or self.tenant).id)
        session.save()

    def _create(self, **over):
        body = {
            "object_type": "device",
            "name": "Aarhus switches",
            "query": {"q": "sw", "facets": {"site": ["abc"]}},
        }
        body.update(over)
        response = self.client.post("/api/saved-filters/", body, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def _pin(self, view_id, scope=None):
        body = {"scope": scope} if scope else {}
        return self.client.post(f"/api/saved-filters/{view_id}/pin/", body, format="json")

    def _unpin(self, view_id, scope=None):
        suffix = f"?scope={scope}" if scope else ""
        return self.client.delete(f"/api/saved-filters/{view_id}/pin/{suffix}")

    def _flags(self, object_type="device"):
        rows = self.client.get(f"/api/saved-filters/?object_type={object_type}").json()
        return {r["name"]: (r["is_default"], r["is_tenant_default"]) for r in rows["results"]}

    def _log(self):
        return ChangeLogEntry.objects.filter(object_type="core.savedfilterdefault")

    def test_one_pin_per_list_and_pinning_another_moves_it(self):
        self._as(self.alice)
        a = self._create(name="A")
        b = self._create(name="B")
        prefixes = self._create(name="P", object_type="prefix")
        self.assertEqual(self._pin(a["id"]).status_code, 200)
        self.assertEqual(self._pin(prefixes["id"]).status_code, 200)
        self.assertEqual(self._flags(), {"A": (True, False), "B": (False, False)})
        self.assertTrue(self._pin(b["id"]).json()["is_default"])
        self.assertEqual(self._flags(), {"A": (False, False), "B": (True, False)})
        # Another list keeps its own pin.
        self.assertEqual(self._flags("prefix"), {"P": (True, False)})
        self.assertEqual(self._unpin(b["id"]).status_code, 200)
        self.assertEqual(self._flags(), {"A": (False, False), "B": (False, False)})
        # Personal pins are preferences: not change-logged.
        self.assertFalse(self._log().exists())

    def test_unpinning_a_view_that_is_not_pinned_leaves_the_pin(self):
        self._as(self.alice)
        a = self._create(name="A")
        b = self._create(name="B")
        self._pin(a["id"])
        self._unpin(b["id"])
        self.assertEqual(self._flags(), {"A": (True, False), "B": (False, False)})

    def test_pins_are_personal(self):
        self._as(self.alice)
        shared = self._create(shared=True)
        self._pin(shared["id"])
        self._as(self.bob)
        self.assertEqual(self._flags(), {"Aarhus switches": (False, False)})
        # Anyone may pin a shared view they can open, for themselves.
        self.assertEqual(self._pin(shared["id"]).status_code, 200)
        self.assertEqual(self._flags(), {"Aarhus switches": (True, False)})

    def test_someone_elses_private_view_cannot_be_pinned(self):
        self._as(self.alice)
        private = self._create()
        self._as(self.bob)
        self.assertEqual(self._pin(private["id"]).status_code, 404)
        self._as(self.mallory, self.other)
        self.assertEqual(self._pin(private["id"]).status_code, 404)
        self.assertFalse(SavedFilterDefault.objects.exists())

    def test_pinning_for_everyone_needs_an_administrator(self):
        self._as(self.alice)
        shared = self._create(shared=True)
        self.assertEqual(self._pin(shared["id"], "tenant").status_code, 403)
        self._as(self.admin)
        response = self._pin(shared["id"], "tenant")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json()["is_tenant_default"])
        self._as(self.bob)
        self.assertEqual(self._flags(), {"Aarhus switches": (False, True)})
        # A reader cannot take it down either.
        self.assertEqual(self._unpin(shared["id"], "tenant").status_code, 403)
        entry = self._log().get()
        self.assertEqual(entry.action, "create")
        self.assertEqual(entry.changes["saved_filter"]["new"], "Aarhus switches")
        self.assertEqual(entry.tenant_id, self.tenant.id)
        self.assertEqual(entry.user_name, "root")

    def test_moving_and_removing_the_tenant_pin_is_logged(self):
        self._as(self.alice)
        a = self._create(name="A", shared=True)
        b = self._create(name="B", shared=True)
        self._as(self.admin)
        self._pin(a["id"], "tenant")
        self._pin(a["id"], "tenant")  # no change, no entry
        self._pin(b["id"], "tenant")
        self._unpin(b["id"], "tenant")
        rows = list(self._log().order_by("timestamp").values_list("action", "changes"))
        self.assertEqual([r[0] for r in rows], ["create", "update", "delete"])
        self.assertEqual(rows[1][1]["saved_filter"], {"old": "A", "new": "B"})

    def test_only_a_shared_view_can_be_pinned_for_everyone(self):
        self._as(self.admin)
        private = self._create()
        self.assertEqual(self._pin(private["id"], "tenant").status_code, 400)

    def test_an_unknown_scope_is_refused(self):
        self._as(self.alice)
        view = self._create()
        self.assertEqual(self._pin(view["id"], "everyone").status_code, 400)

    def test_unsharing_drops_the_pins_of_others(self):
        self._as(self.alice)
        shared = self._create(shared=True)
        self._pin(shared["id"])
        self._as(self.admin)
        self._pin(shared["id"], "tenant")
        self._as(self.bob)
        self._pin(shared["id"])
        self._as(self.alice)
        self.client.patch(f"/api/saved-filters/{shared['id']}/", {"shared": False}, format="json")
        # Alice keeps her own pin; Bob's and the tenant's go.
        self.assertEqual(self._flags(), {"Aarhus switches": (True, False)})
        self._as(self.bob)
        self.assertEqual(self._flags(), {})
        self.assertEqual(
            list(self._log().order_by("timestamp").values_list("action", flat=True)),
            ["create", "delete"],
        )

    def test_deleting_a_view_takes_its_pins_and_logs_the_tenants(self):
        self._as(self.alice)
        shared = self._create(shared=True)
        self._pin(shared["id"])
        self._as(self.admin)
        self._pin(shared["id"], "tenant")
        self._as(self.alice)
        self.assertEqual(self.client.delete(f"/api/saved-filters/{shared['id']}/").status_code, 204)
        self.assertFalse(SavedFilterDefault.objects.exists())
        self.assertEqual(
            list(self._log().order_by("timestamp").values_list("action", flat=True)),
            ["create", "delete"],
        )

    def test_pins_do_not_cross_the_tenant_boundary(self):
        self._as(self.admin)
        shared = self._create(shared=True)
        self._pin(shared["id"], "tenant")
        self.mallory.is_superuser = True
        self.mallory.save()
        self._as(self.mallory, self.other)
        self.assertEqual(self._flags(), {})
        self.assertEqual(self._pin(shared["id"], "tenant").status_code, 404)
        self.assertFalse(SavedFilterDefault.objects.filter(tenant=self.other).exists())
