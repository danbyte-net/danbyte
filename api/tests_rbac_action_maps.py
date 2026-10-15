"""A viewset's ``rbac_action_map`` keeps its mixins' entries.

An override that leaves a mixin's key out sends that action to the default
for a mutating @action, ``change`` - so bulk-clone on interfaces needed only
``change`` instead of ``add``, and bulk-delete on watched endpoints only
``change`` instead of ``delete``.
"""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import SimpleTestCase
from django.urls import get_resolver
from rest_framework.test import APITestCase

from api.models import Device, Interface, Site
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from monitoring.models import WatchedEndpoint


def _routed_viewsets():
    out = set()

    def walk(patterns):
        for p in patterns:
            if hasattr(p, "url_patterns"):
                walk(p.url_patterns)
            elif getattr(p.callback, "cls", None) is not None:
                out.add(p.callback.cls)

    walk(get_resolver().url_patterns)
    return out


class ActionMapInheritanceTests(SimpleTestCase):
    def test_every_override_keeps_its_mixins_entries(self):
        dropped = []
        for cls in _routed_viewsets():
            effective = getattr(cls, "rbac_action_map", None) or {}
            for base in cls.__mro__[1:]:
                for key, verb in (base.__dict__.get("rbac_action_map") or {}).items():
                    # An action switched off with ``name = None`` needs no entry.
                    if getattr(cls, key, "") is None:
                        continue
                    if effective.get(key) != verb:
                        dropped.append(
                            f"{cls.__module__}.{cls.__name__}: {base.__name__}"
                            f"[{key}]={verb} -> {effective.get(key)}"
                        )
        self.assertEqual(sorted(set(dropped)), [])

    def test_bulk_deletes_need_delete(self):
        wrong = []
        for cls in _routed_viewsets():
            if not hasattr(cls, "get_extra_actions"):
                continue
            effective = getattr(cls, "rbac_action_map", None) or {}
            for act in cls.get_extra_actions():
                if act.__name__ == "bulk_delete" and effective.get("bulk_delete") != "delete":
                    wrong.append(f"{cls.__module__}.{cls.__name__}")
        self.assertEqual(sorted(set(wrong)), [])


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="A")

    def member(self, name, types, actions):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=name, object_types=list(types), actions=list(actions)
        )
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        return user


class InterfaceBulkCloneTests(_Base):
    def setUp(self):
        super().setUp()
        self.device = Device.objects.create(tenant=self.tenant, name="sw1", site=self.site)
        self.iface = Interface.objects.create(device=self.device, name="Gi1/0/1")

    def clone(self):
        return self.client.post(
            "/api/interfaces/bulk-clone/",
            {"ids": [str(self.iface.id)], "find": "1/0/", "replace": "2/0/"},
            format="json",
        )

    def test_change_alone_cannot_clone(self):
        self.member("editor", ["interface", "device"], ["view", "change"])
        self.assertEqual(self.clone().status_code, 403)
        self.assertEqual(Interface.objects.filter(device=self.device).count(), 1)

    def test_add_may_clone(self):
        self.member("adder", ["interface", "device"], ["view", "add"])
        r = self.clone()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(Interface.objects.filter(device=self.device, name="Gi2/0/1").exists())

    def test_bulk_rename_still_needs_change(self):
        self.member("adder", ["interface", "device"], ["view", "add"])
        r = self.client.post(
            "/api/interfaces/bulk-rename/",
            {"ids": [str(self.iface.id)], "find": "Gi", "replace": "Te"},
            format="json",
        )
        self.assertEqual(r.status_code, 403)


class WatchedEndpointBulkDeleteTests(_Base):
    URL = "/api/monitoring/watched-endpoints/bulk-delete/"

    def setUp(self):
        super().setUp()
        self.eps = [
            WatchedEndpoint.objects.create(tenant=self.tenant, host=f"h{i}.example.net")
            for i in range(2)
        ]
        org = Organization.objects.create(name="P", slug="p")
        other = Tenant.objects.create(org=org, name="U", slug="u")
        self.foreign = WatchedEndpoint.objects.create(tenant=other, host="x.example.net")

    def ids(self, *eps):
        return {"ids": [str(e.id) for e in eps]}

    def test_change_alone_cannot_bulk_delete(self):
        self.member("editor", ["watchedendpoint"], ["view", "change"])
        r = self.client.post(self.URL, self.ids(*self.eps), format="json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(WatchedEndpoint.objects.filter(tenant=self.tenant).count(), 2)

    def test_delete_removes_and_logs_each_row(self):
        self.member("deleter", ["watchedendpoint"], ["view", "delete"])
        r = self.client.post(
            self.URL, self.ids(*self.eps, self.foreign), format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 2)
        self.assertFalse(WatchedEndpoint.objects.filter(tenant=self.tenant).exists())
        self.assertTrue(WatchedEndpoint.objects.filter(pk=self.foreign.pk).exists())
        logged = set(
            ChangeLogEntry.objects.filter(action="delete").values_list("object_id", flat=True)
        )
        self.assertEqual(logged, {str(e.id) for e in self.eps})

    def test_dry_run_deletes_nothing(self):
        self.member("deleter", ["watchedendpoint"], ["view", "delete"])
        r = self.client.post(
            self.URL, {**self.ids(*self.eps), "dry_run": True}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 2)
        self.assertEqual(WatchedEndpoint.objects.filter(tenant=self.tenant).count(), 2)
