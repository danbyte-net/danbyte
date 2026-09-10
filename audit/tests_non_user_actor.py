"""An audited write by something that is not a Django user.

A request can be authenticated by a principal with no username and no row in
the user table - an Outpost presents its engine as ``request.user`` so DRF's
``IsAuthenticated`` passes. The audit signal used to call ``get_username()`` on
it and die, which took the whole write with it: the one thing a logger must
never do.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from api.models import Site
from core.models import Organization, Tenant

from .context import clear_context, set_context
from .models import ChangeLogEntry
from .signals import _actor


class _NotAUser:
    is_authenticated = True

    def get_username(self):
        return "outpost:probe-1"


class _Nameless:
    is_authenticated = True

    def __str__(self):
        return "something else"


class ActorTests(TestCase):
    def test_a_real_user_fills_the_foreign_key(self):
        u = get_user_model().objects.create_user("bob", "b@example.com", "pw")
        actor, name = _actor(u)
        self.assertEqual(actor, u)
        self.assertEqual(name, "bob")

    def test_a_non_user_is_named_but_not_linked(self):
        actor, name = _actor(_NotAUser())
        self.assertIsNone(actor)
        self.assertEqual(name, "outpost:probe-1")

    def test_a_principal_with_no_username_still_gets_a_name(self):
        actor, name = _actor(_Nameless())
        self.assertIsNone(actor)
        self.assertEqual(name, "something else")

    def test_nobody_is_blank(self):
        self.assertEqual(_actor(None), (None, ""))


class WriteTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def test_an_outpost_write_is_recorded_rather_than_raising(self):
        set_context(_NotAUser(), "req-1", via="outpost")
        try:
            site = Site.objects.create(tenant=self.tenant, name="AMS-02")
        finally:
            clear_context()
        entry = ChangeLogEntry.objects.filter(object_id=str(site.pk)).first()
        self.assertIsNotNone(entry)
        self.assertIsNone(entry.user_id)
        self.assertEqual(entry.user_name, "outpost:probe-1")
