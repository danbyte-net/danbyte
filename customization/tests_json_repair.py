"""customization 0007 puts back the JSON lists and objects an older
spreadsheet re-import stored as "" or {} (#354)."""
from __future__ import annotations

import importlib

from django.apps import apps
from django.db import connection
from django.test import TestCase

from api.models import Cable, Contact, Provider
from auth_api.models import ObjectPermission
from core.models import Organization, Tenant
from customization.models import CustomField

mig = importlib.import_module("customization.migrations.0007_repair_blank_json_fields")


def _repair():
    with connection.schema_editor() as editor:
        mig.repair(apps, editor)


class RepairBlankJsonTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def test_every_list_and_object_column_is_covered(self):
        cols = {(m._meta.label, f.name) for m, f, _ in mig.json_columns(apps)}
        for want in (
            ("customization.CustomField", "choices"),
            ("customization.CustomField", "scope_rules"),
            ("customization.CustomField", "applies_to"),
            ("api.Cable", "strands"),
            ("api.Provider", "business_hours"),
            ("api.Contact", "business_hours"),
            ("auth_api.ObjectPermission", "actions"),
            ("monitoring.SlaAgreement", "burn_alerts"),
        ):
            self.assertIn(want, cols)
        # Nullable columns keep their None; it is not a bug artifact.
        self.assertNotIn(("auth_api.ObjectPermission", "constraints"), cols)

    def test_blank_strings_go_back_to_the_default(self):
        cf = CustomField.objects.create(
            tenant=self.tenant, key="t", label="T", type="select",
            applies_to=["site"], choices=["a"],
        )
        CustomField.objects.filter(pk=cf.pk).update(choices="", scope_rules="", applies_to="")
        cable = Cable.objects.create(tenant=self.tenant, type="cat6", label="c")
        Cable.objects.filter(pk=cable.pk).update(strands="")
        prov = Provider.objects.create(tenant=self.tenant, name="p", slug="p")
        Provider.objects.filter(pk=prov.pk).update(business_hours="")
        contact = Contact.objects.create(tenant=self.tenant, name="c")
        Contact.objects.filter(pk=contact.pk).update(business_hours="")

        _repair()

        cf.refresh_from_db()
        cable.refresh_from_db()
        prov.refresh_from_db()
        contact.refresh_from_db()
        self.assertEqual((cf.choices, cf.scope_rules, cf.applies_to), ([], {}, []))
        self.assertEqual(cable.strands, {})
        self.assertEqual((prov.business_hours, contact.business_hours), ({}, {}))

    def test_empty_object_in_a_required_list_goes_back_to_a_list(self):
        perm = ObjectPermission.objects.create(
            name="p", object_types=["api.site"], actions=["view"]
        )
        ObjectPermission.objects.filter(pk=perm.pk).update(actions={})
        _repair()
        perm.refresh_from_db()
        self.assertEqual(perm.actions, [])
        self.assertEqual(perm.object_types, ["api.site"])
        self.assertIsNone(perm.constraints)

    def test_good_values_are_left_alone_and_rerun_changes_nothing(self):
        cf = CustomField.objects.create(
            tenant=self.tenant, key="t", label="T", type="select", applies_to=["site"],
            choices=["a", ""], scope_rules={"site": {"mode": "any"}},
        )
        cable = Cable.objects.create(
            tenant=self.tenant, type="smf", label="c", strands={"1": {"label": "x"}}
        )
        prov = Provider.objects.create(tenant=self.tenant, name="p", slug="p")
        Provider.objects.filter(pk=prov.pk).update(business_hours="")

        _repair()
        prov.refresh_from_db()
        self.assertEqual(prov.business_hours, {})
        _repair()

        cf.refresh_from_db()
        cable.refresh_from_db()
        prov.refresh_from_db()
        self.assertEqual(cf.choices, ["a", ""])
        self.assertEqual(cf.scope_rules, {"site": {"mode": "any"}})
        self.assertEqual(cf.applies_to, ["site"])
        self.assertEqual(cable.strands, {"1": {"label": "x"}})
        self.assertEqual(prov.business_hours, {})
