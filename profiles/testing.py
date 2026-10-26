"""Shared fixtures for the device profile tests."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api import applications as groups
from api.models import (
    Application,
    ApplicationGroup,
    Cluster,
    ClusterType,
    Device,
    Platform,
    Site,
    VirtualMachine,
)
from core.models import Organization, Tag, Tenant
from customization.models import CustomField

from .models import DeviceProfile, DeviceProfileApplicationGroup

PROFILES = "/api/device-profiles/"
ASSIGN = "/api/device-profile-assignments/"


class ProfileBase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        self.dev = Device.objects.create(tenant=self.tenant, name="rds1", site=self.site_a)
        self.dev_b = Device.objects.create(tenant=self.tenant, name="rds2", site=self.site_b)
        ct = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        cl = Cluster.objects.create(tenant=self.tenant, name="C", type=ct)
        self.vm = VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=cl,
                                                site=self.site_a)
        self.rdsh = Application.objects.create(tenant=self.tenant, name="RD Session Host",
                                               slug="rdsh")
        self.office = Application.objects.create(tenant=self.tenant, name="Office",
                                                 slug="office")
        self.group = ApplicationGroup.objects.create(tenant=self.tenant, name="RDS", slug="rds")
        groups.add_member(self.group, self.rdsh, "2022", 0)
        groups.add_member(self.group, self.office, "365", 1)
        self.desk = ApplicationGroup.objects.create(tenant=self.tenant, name="Desk", slug="desk")
        groups.add_member(self.desk, self.office, "365")
        self.tag_rds = Tag.objects.create(tenant=self.tenant, name="rds", slug="rds")
        self.tag_hr = Tag.objects.create(tenant=self.tenant, name="hr", slug="hr")
        self.cf_owner = CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", type="text",
            applies_to=["device", "virtualmachine"])
        self.win = Platform.objects.create(tenant=self.tenant, name="Windows", slug="windows")
        self.linux = Platform.objects.create(tenant=self.tenant, name="Linux", slug="linux")
        self.admin = User.objects.create_superuser("profiles-root", password="x")
        self.login(self.admin)

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None

    def profile(self, name, *, parent=None, groups_=(), tags=(), cf=None, platform=None,
                tenant=None, **kw):
        from django.utils.text import slugify

        p = DeviceProfile.objects.create(
            tenant=tenant or self.tenant, name=name, slug=slugify(name), parent=parent,
            cf_values=cf or {}, platform=platform, **kw)
        for i, g in enumerate(groups_):
            DeviceProfileApplicationGroup.objects.create(
                tenant=p.tenant, profile=p, group=g, position=i)
        if tags:
            p.add_tags.set(tags)
        return p

    def tags_of(self, host) -> set[str]:
        return set(host.tags.values_list("name", flat=True))

    def fresh(self, host):
        host.refresh_from_db()
        return host
