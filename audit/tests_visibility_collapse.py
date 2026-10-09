"""The change-log visibility filter puts every type a grant shows in full into
one ``object_type IN (...)`` and keeps per-grant branches only for the rest
(#342). The rows a user can see must not change: each test compares the
filter against the per-grant composition it replaced, for users with
different mixes of grants."""
from __future__ import annotations

import re
import uuid
from types import SimpleNamespace
from unittest import mock

from django.contrib.auth.models import User
from django.db.models import CharField, Q
from django.db.models.functions import Cast
from rest_framework.test import APITestCase

from api.models import Device, Prefix, Site
from audit.api import _tenant_gate, _visibility_q
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


def _reference_visibility_q(user, tenant):
    """The filter as built before #342: one OR branch per type and granting
    permission. Kept here as the oracle for the collapsed form."""
    from django.core.exceptions import FieldError

    from auth_api import rbac
    from auth_api.object_types import grant_covers, model_for
    from auth_api.site_paths import site_path_for

    if user.is_superuser:
        return ~Q(object_type="core.tenant") | Q(
            object_type="core.tenant", object_id=str(tenant.pk)
        )
    acts = rbac.effective_actions(user, tenant)
    applicable = list(rbac.applicable_permissions(user, tenant))
    q = Q()
    matched = False
    for slug, actions in acts.items():
        if "view" not in actions:
            continue
        model = model_for(slug)
        if model is None:
            continue
        label = model._meta.label_lower
        site_path = site_path_for(slug, tenant)
        granting = [
            p for p in applicable
            if "view" in (p.actions or []) and grant_covers(p.object_types, slug)
        ]
        for permission in granting:
            if permission.constraints:
                base = model._default_manager.all()
                if label == "core.tenant":
                    base = base.filter(pk=tenant.pk)
                elif any(f.name == "tenant" for f in model._meta.fields):
                    base = base.filter(tenant=tenant)
                try:
                    row_q = rbac._perm_q(permission, site_path, "view")
                    live_ids = (
                        base.filter(row_q).order_by()
                        .annotate(audit_object_id=Cast("pk", output_field=CharField()))
                        .values("audit_object_id")
                    )
                except (FieldError, TypeError, ValueError):
                    continue
                part = Q(object_type=label, object_id__in=live_ids)
            else:
                site_ids = {site.pk for site in permission.sites.all()}
                if site_path and site_ids:
                    scope_q = Q(object_site_id__in=site_ids)
                    if site_path != "id":
                        scope_q |= Q(object_site_id__isnull=True)
                    part = Q(object_type=label) & scope_q
                else:
                    part = Q(object_type=label)
            if label == "core.tenant":
                part &= Q(object_id=str(tenant.pk))
            q |= part
            matched = True
    return q if matched else Q(pk__in=[])


class ChangeLogVisibilityCollapseTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.other = Tenant.objects.create(org=org, name="Two", slug="two")
        self.s1 = Site.objects.create(tenant=self.tenant, name="S1")
        self.s2 = Site.objects.create(tenant=self.tenant, name="S2")
        foreign_site = Site.objects.create(tenant=self.other, name="F1")
        self.d1 = Device.objects.create(tenant=self.tenant, name="d1", site=self.s1)
        self.d2 = Device.objects.create(tenant=self.tenant, name="d2", site=self.s2)
        self.p1 = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", site=self.s1)
        self.p0 = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24")

        rows = []

        def entry(tenant, otype, oid, site):
            rows.append(ChangeLogEntry(
                tenant=tenant, action="update", object_type=otype,
                object_id=str(oid), object_repr=otype, object_site_id=site,
            ))

        for t in (self.tenant, self.other):
            for otype in ("api.device", "api.prefix", "api.ipaddress", "api.vlan",
                          "api.site", "api.rack", "core.tag"):
                for site in (self.s1.pk, self.s2.pk, foreign_site.pk, None):
                    entry(t, otype, uuid.uuid4(), site)
        # Live objects (constrained grants read these) and a deleted device
        # whose stored site survives.
        entry(self.tenant, "api.device", self.d1.pk, self.s1.pk)
        entry(self.tenant, "api.device", self.d2.pk, self.s2.pk)
        entry(self.tenant, "api.prefix", self.p1.pk, self.s1.pk)
        entry(self.tenant, "api.prefix", self.p0.pk, None)
        entry(self.tenant, "api.site", self.s1.pk, self.s1.pk)
        entry(self.tenant, "api.site", self.s2.pk, self.s2.pk)
        # Tenant-less component rows and the global Tenant rows.
        entry(None, "api.interface", uuid.uuid4(), self.s1.pk)
        entry(None, "api.interface", uuid.uuid4(), self.s2.pk)
        entry(None, "core.tenant", self.tenant.pk, None)
        entry(None, "core.tenant", self.other.pk, None)
        ChangeLogEntry.objects.bulk_create(rows)

    def _member(self, name, *grants):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for types, actions, sites, constraints in grants:
            perm = ObjectPermission.objects.create(
                name=f"{name} {types}", object_types=types, actions=actions,
                constraints=constraints,
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            if sites:
                perm.sites.add(*sites)
        return user

    def _visible(self, user, build):
        user = User.objects.get(pk=user.pk)
        gate = _tenant_gate(self.tenant)
        return set(
            ChangeLogEntry.objects.filter(gate).filter(build(user)).values_list("pk", flat=True)
        )

    def _assert_same(self, user):
        with mock.patch("audit.api._get_active_tenant", return_value=self.tenant):
            new = self._visible(user, lambda u: _visibility_q(SimpleNamespace(user=u)))
        old = self._visible(user, lambda u: _reference_visibility_q(u, self.tenant))
        self.assertEqual(new, old, user.username)
        return new

    def test_superuser(self):
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        seen = self._assert_same(admin)
        self.assertTrue(seen)

    def test_read_all_plus_site_grant(self):
        user = self._member(
            "site1",
            (["*"], ["view"], (), None),
            (["*"], ["view", "add", "change", "delete"], (self.s1,), None),
        )
        seen = self._assert_same(user)
        self.assertTrue(seen)
        with mock.patch("audit.api._get_active_tenant", return_value=self.tenant):
            q = _visibility_q(SimpleNamespace(user=User.objects.get(pk=user.pk)))
        # The type-wide grant covers every type the site grant does, so no
        # site branch is left in the filter.
        where = str(ChangeLogEntry.objects.filter(q).query).split(" WHERE ", 1)[1]
        self.assertNotIn("object_site_id", where)
        self.assertEqual(len(re.findall(r"= core\.tenant\b(?!group)", where)), 1)

    def test_site_only_grant(self):
        user = self._member("siteonly", (["*"], ["view"], (self.s1,), None))
        seen = self._assert_same(user)
        self.assertTrue(seen)

    def test_constrained_grants(self):
        user = self._member(
            "constrained",
            (["device"], ["view"], (), {"name": "d1"}),
            (["prefix"], ["view"], (), None),
            (["prefix"], ["view"], (self.s1,), [{"cidr": "10.0.0.0/24"}]),
            (["site"], ["view"], (self.s2,), None),
            (["tenant"], ["view"], (), None),
        )
        seen = self._assert_same(user)
        self.assertTrue(seen)

    def test_constrained_and_site_grants_on_one_type(self):
        user = self._member(
            "mixed",
            (["device"], ["view"], (), {"name": "d2"}),
            (["device"], ["view"], (self.s1,), None),
            (["tenant"], ["view"], (), {"slug": "one"}),
        )
        seen = self._assert_same(user)
        self.assertTrue(seen)

    def test_no_grant(self):
        user = self._member("nogrant")
        self.assertEqual(self._assert_same(user), set())

    def test_endpoint_agrees(self):
        user = self._member(
            "site1",
            (["*"], ["view"], (), None),
            (["*"], ["view", "add", "change", "delete"], (self.s1,), None),
        )
        expected = self._assert_same(user)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client.get("/api/changelog/?page_size=1000")
        self.assertEqual(r.status_code, 200, r.content)
        # The tenant-wide list reads the active tenant's own rows.
        own = set(
            ChangeLogEntry.objects.filter(pk__in=expected, tenant=self.tenant)
            .values_list("pk", flat=True)
        )
        listed = {uuid.UUID(row["id"]) for row in r.json()["results"]}
        self.assertEqual(listed, own)
        self.assertEqual(r.json()["count"], len(own))
