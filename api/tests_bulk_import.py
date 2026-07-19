"""Bulk-import tests — coercion, FK resolution, errors, dry-run."""
from __future__ import annotations

from django.test import TestCase

from api.bulk_import import import_rows, parse_rows
from api.models import Region, Site
from core.models import Organization, Tenant


class BulkImportTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.eu = Region.objects.create(tenant=self.tenant, name="EU", slug="eu")

    def test_csv_parse_and_create_with_fk(self):
        rows = parse_rows("name,region\nDC-AMS,eu\nDC-FRA,eu", "csv")
        res = import_rows(Site, self.tenant, rows)
        self.assertEqual(res["created"], 2)
        self.assertEqual(res["errors"], [])
        self.assertEqual(
            Site.objects.get(tenant=self.tenant, name="DC-AMS").region, self.eu
        )

    def test_dry_run_writes_nothing(self):
        rows = parse_rows("name\nDC-X", "csv")
        res = import_rows(Site, self.tenant, rows, dry_run=True)
        self.assertEqual(res["created"], 1)
        self.assertTrue(res["dry_run"])
        self.assertFalse(Site.objects.filter(name="DC-X").exists())

    def test_unresolvable_fk_is_a_clean_row_error(self):
        rows = [{"name": "Bad", "region": "nope"}]
        res = import_rows(Site, self.tenant, rows)
        self.assertEqual(res["created"], 0)
        self.assertEqual(res["errors"][0]["row"], 1)
        self.assertIn("no region matching", res["errors"][0]["error"])

    def test_bad_row_does_not_sink_batch(self):
        rows = [
            {"name": "Good"},
            {"name": ""},  # name required → fails validation
            {"name": "Good2"},
        ]
        res = import_rows(Site, self.tenant, rows)
        self.assertEqual(res["created"], 2)
        self.assertEqual(len(res["errors"]), 1)
        self.assertEqual(res["errors"][0]["row"], 2)

    def test_json_parse(self):
        rows = parse_rows('[{"name": "A"}, {"name": "B"}]', "json")
        self.assertEqual(len(rows), 2)
