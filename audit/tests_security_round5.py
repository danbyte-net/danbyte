from __future__ import annotations

import uuid

from django.contrib.auth.models import User
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import (
    DeploymentSettings,
    Organization,
    Tenant,
    TenantSettings,
)

from .models import ChangeLogEntry, JournalEntry
from .site_capture import UNKNOWN_SITE


class AuditSiteBackfillMigrationTests(TransactionTestCase):
    migrate_from = ("audit", "0006_scrub_webhook_headers")
    migrate_to = ("audit", "0007_backfill_audit_site_scope")

    def setUp(self):
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        old_apps = executor.loader.project_state([self.migrate_from]).apps

        org = Organization.objects.create(name="Migration Org", slug="migration-org")
        self.tenant = Tenant.objects.create(
            org=org, name="Migration Tenant", slug="migration-tenant"
        )
        self.site = Site.objects.create(tenant=self.tenant, name="Migration Site")
        DeploymentSettings.objects.update_or_create(
            pk=1, defaults={"enhanced_site_separation": False}
        )
        TenantSettings.objects.create(
            tenant=self.tenant,
            override_separation=True,
            enhanced_site_separation=True,
        )
        device_type = DeviceType.objects.create(
            tenant=self.tenant,
            name="Local catalog",
            owning_site=self.site,
        )

        OldChange = old_apps.get_model("audit", "ChangeLogEntry")
        OldJournal = old_apps.get_model("audit", "JournalEntry")
        OldChange.objects.all().delete()
        OldJournal.objects.all().delete()

        deleted_id = uuid.uuid4()
        self.deleted_change_id = OldChange.objects.create(
            tenant_id=self.tenant.id,
            action="delete",
            object_type="api.device",
            object_label="Device",
            object_id=str(deleted_id),
            object_repr="deleted device",
            changes={},
        ).pk
        self.catalog_change_id = OldChange.objects.create(
            tenant_id=self.tenant.id,
            action="create",
            object_type="api.devicetype",
            object_label="Device Type",
            object_id=str(device_type.id),
            object_repr=str(device_type),
            changes={},
        ).pk
        self.deleted_journal_id = OldJournal.objects.create(
            tenant_id=self.tenant.id,
            object_type="api.device",
            object_id=str(deleted_id),
            comments="legacy deleted target",
        ).pk
        self.catalog_journal_id = OldJournal.objects.create(
            tenant_id=self.tenant.id,
            object_type="api.devicetype",
            object_id=str(device_type.id),
            comments="legacy local catalog",
        ).pk

        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_to])

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def test_forward_migration_fails_closed_and_backfills_local_catalogs(self):
        self.assertEqual(
            ChangeLogEntry.objects.get(pk=self.deleted_change_id).object_site_id,
            UNKNOWN_SITE,
        )
        self.assertEqual(
            JournalEntry.objects.get(pk=self.deleted_journal_id).object_site_id,
            UNKNOWN_SITE,
        )
        self.assertEqual(
            ChangeLogEntry.objects.get(pk=self.catalog_change_id).object_site_id,
            self.site.id,
        )
        self.assertEqual(
            JournalEntry.objects.get(pk=self.catalog_journal_id).object_site_id,
            self.site.id,
        )


class AuditGrantCompositionTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Grant Org", slug="grant-org")
        self.tenant = Tenant.objects.create(org=org, name="Grant Tenant", slug="grant")
        self.site_a = Site.objects.create(tenant=self.tenant, name="Grant Site A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Grant Site B")
        self.user = User.objects.create_user("audit-grants", password="x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(
            self.tenant
        )

    def _grant(self, name, *, site, constraints=None):
        permission = ObjectPermission.objects.create(
            name=name,
            object_types=["device"],
            actions=["view"],
            constraints=constraints,
        )
        permission.users.add(self.user)
        permission.tenants.add(self.tenant)
        permission.sites.add(site)

    def _login(self):
        self.client.force_login(self.user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def test_constraints_remain_paired_with_each_grants_site_scope(self):
        allowed_a = Device.objects.create(
            tenant=self.tenant, site=self.site_a, name="allowed-a"
        )
        denied_a = Device.objects.create(
            tenant=self.tenant, site=self.site_a, name="denied-a"
        )
        allowed_b = Device.objects.create(
            tenant=self.tenant, site=self.site_b, name="allowed-b"
        )
        denied_b = Device.objects.create(
            tenant=self.tenant, site=self.site_b, name="denied-b"
        )
        self._grant(
            "constrained site A",
            site=self.site_a,
            constraints={"name__startswith": "allowed"},
        )
        self._grant("unconstrained site B", site=self.site_b)
        self._login()

        response = self.client.get(
            "/api/changelog/?object_type=api.device&page_size=200"
        )
        self.assertEqual(response.status_code, 200)
        object_ids = {row["object_id"] for row in response.json()["results"]}
        self.assertIn(str(allowed_a.id), object_ids)
        self.assertNotIn(str(denied_a.id), object_ids)
        self.assertIn(str(allowed_b.id), object_ids)
        self.assertIn(str(denied_b.id), object_ids)


class AuditTenantBoundaryTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Tenant Org", slug="tenant-org")
        self.tenant_a = Tenant.objects.create(
            org=org, name="Tenant A", slug="tenant-a"
        )
        self.tenant_b = Tenant.objects.create(
            org=org, name="Tenant B", slug="tenant-b"
        )
        self.user = User.objects.create_user("tenant-auditor", password="x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(
            self.tenant_a
        )
        permission = ObjectPermission.objects.create(
            name="constrained tenant view",
            object_types=["tenant"],
            actions=["view"],
            constraints={"name__startswith": "Tenant"},
        )
        permission.users.add(self.user)
        permission.tenants.add(self.tenant_a)
        self._login(self.user)

    def _login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant_a.id)
        session.save()

    def _history(self, tenant):
        response = self.client.get(
            "/api/changelog/",
            {
                "object_type": "core.tenant",
                "object_id": str(tenant.id),
                "page_size": 200,
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["results"]

    def test_constrained_tenant_history_is_clamped_to_active_tenant(self):
        self.assertTrue(self._history(self.tenant_a))
        self.assertEqual(self._history(self.tenant_b), [])

    def test_superuser_tenant_history_is_clamped_to_active_tenant(self):
        superuser = User.objects.create_superuser("audit-root", password="x")
        self._login(superuser)
        self.assertTrue(self._history(self.tenant_a))
        self.assertEqual(self._history(self.tenant_b), [])

    def test_foreign_tenant_cannot_be_targeted_by_journal_create(self):
        foreign = self.client.post(
            "/api/journal/",
            {
                "object_type": "core.tenant",
                "object_id": str(self.tenant_b.id),
                "kind": "info",
                "comments": "foreign",
            },
            format="json",
        )
        self.assertEqual(foreign.status_code, 403)

        current = self.client.post(
            "/api/journal/",
            {
                "object_type": "core.tenant",
                "object_id": str(self.tenant_a.id),
                "kind": "info",
                "comments": "current",
            },
            format="json",
        )
        self.assertEqual(current.status_code, 201, current.content)
