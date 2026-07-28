"""Contact assignments: the ``?role=`` read filter behind the contact-role
detail page's Assignments tab, and its tenant scoping."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Contact, ContactAssignment, ContactRole, Site

User = get_user_model()


class ContactAssignmentFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Beta", slug="beta")
        admin = User.objects.create_superuser("ca-admin", "a@b.c", "pw")
        self.client.force_login(admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

        self.site = Site.objects.create(tenant=self.tenant, name="AMS")
        self.contact = Contact.objects.create(tenant=self.tenant, name="Ada")
        self.tech = ContactRole.objects.create(
            tenant=self.tenant, name="Technical", slug="technical"
        )
        self.billing = ContactRole.objects.create(
            tenant=self.tenant, name="Billing", slug="billing"
        )

    def _assign(self, role, tenant=None, contact=None, obj=None):
        return ContactAssignment.objects.create(
            tenant=tenant or self.tenant,
            contact=contact or self.contact,
            role=role,
            object_type="api.site",
            object_id=str((obj or self.site).id),
        )

    def test_filters_assignments_by_role(self):
        kept = self._assign(self.tech)
        self._assign(self.billing)
        body = self.client.get(f"/api/contact-assignments/?role={self.tech.id}").json()
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["results"][0]["id"], str(kept.id))
        self.assertEqual(body["results"][0]["role"]["name"], "Technical")

    def test_role_filter_narrows_the_tenant_scoped_set(self):
        """A foreign role id must return nothing — the filter is applied after
        the tenant restriction, so it can never widen the visible rows."""
        foreign_site = Site.objects.create(tenant=self.other, name="LON")
        foreign_contact = Contact.objects.create(tenant=self.other, name="Grace")
        foreign_role = ContactRole.objects.create(
            tenant=self.other, name="Technical", slug="technical"
        )
        self._assign(
            foreign_role,
            tenant=self.other,
            contact=foreign_contact,
            obj=foreign_site,
        )
        body = self.client.get(
            f"/api/contact-assignments/?role={foreign_role.id}"
        ).json()
        self.assertEqual(body["count"], 0)

    def test_unfiltered_list_stays_tenant_scoped(self):
        self._assign(self.tech)
        foreign_site = Site.objects.create(tenant=self.other, name="LON")
        foreign_contact = Contact.objects.create(tenant=self.other, name="Grace")
        self._assign(
            None, tenant=self.other, contact=foreign_contact, obj=foreign_site
        )
        body = self.client.get("/api/contact-assignments/").json()
        self.assertEqual(body["count"], 1)
