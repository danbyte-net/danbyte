"""Contact assignments: the ``?role=`` read filter behind the contact-role
detail page's Assignments tab, and its tenant scoping. Plus the ``?parent=``
filter behind the contact-group detail page's Child groups tab."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Contact, ContactAssignment, ContactGroup, ContactRole, Site

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
        """A foreign role id must return nothing - the filter is applied after
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


class ContactGroupParentFilterTests(APITestCase):
    """``/api/contact-groups/?parent=`` - the Child groups tab on a group's
    detail page. ContactGroup self-nests, so the tab needs one hop down."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Beta", slug="beta")
        admin = User.objects.create_superuser("cg-admin", "a@b.c", "pw")
        self.client.force_login(admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

        self.root = ContactGroup.objects.create(
            tenant=self.tenant, name="Networking", slug="networking"
        )
        self.child = ContactGroup.objects.create(
            tenant=self.tenant, name="Peering", slug="peering", parent=self.root
        )
        # A sibling at the top level, to prove the filter is really applied.
        ContactGroup.objects.create(
            tenant=self.tenant, name="Facilities", slug="facilities"
        )

    def test_filters_groups_by_parent(self):
        body = self.client.get(
            f"/api/contact-groups/?parent={self.root.id}"
        ).json()
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["results"][0]["id"], str(self.child.id))
        self.assertEqual(body["results"][0]["parent"]["name"], "Networking")

    def test_parent_filter_narrows_the_tenant_scoped_set(self):
        """A foreign parent id returns nothing - the filter runs after the
        tenant restriction, so it can only narrow an authorised queryset."""
        foreign_root = ContactGroup.objects.create(
            tenant=self.other, name="Networking", slug="networking"
        )
        ContactGroup.objects.create(
            tenant=self.other, name="Transit", slug="transit", parent=foreign_root
        )
        body = self.client.get(
            f"/api/contact-groups/?parent={foreign_root.id}"
        ).json()
        self.assertEqual(body["count"], 0)

    def test_unfiltered_list_stays_tenant_scoped(self):
        ContactGroup.objects.create(
            tenant=self.other, name="Transit", slug="transit"
        )
        body = self.client.get("/api/contact-groups/").json()
        self.assertEqual(body["count"], 3)
        self.assertNotIn("Transit", [g["name"] for g in body["results"]])

    def test_child_count_reports_the_nesting(self):
        body = self.client.get(f"/api/contact-groups/{self.root.id}/").json()
        self.assertEqual(body["child_count"], 1)
        self.assertEqual(body["contact_count"], 0)
