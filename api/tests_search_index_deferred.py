"""Indexing cost per save (#197): the tag lookup runs once, and a bulk
operation collects its saves and indexes each object once at the end."""
from __future__ import annotations

from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from core.models import Organization, Tag, Tenant

from . import search_index
from .models import Site


class SearchIndexCostTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")

    def test_tags_are_read_once(self):
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        site.tags.add(Tag.objects.create(tenant=self.tenant, name="core", slug="core"))
        site = Site.objects.get(pk=site.pk)
        with CaptureQueriesContext(connection) as ctx:
            values = search_index.entry_values(site)
        tag_queries = [q for q in ctx.captured_queries if "core_tag" in q["sql"]]
        self.assertEqual(len(tag_queries), 1)
        self.assertIn("core", values["facets"]["tag"])

    def test_deferred_indexes_each_object_once_at_the_end(self):
        with patch.object(search_index, "index_object") as index:
            with search_index.deferred():
                site = Site.objects.create(tenant=self.tenant, name="HQ")
                site.description = "a"
                site.save()
                site.description = "b"
                site.save()
                index.assert_not_called()
            index.assert_called_once()
            self.assertEqual(index.call_args.args[0].description, "b")

    def test_a_dry_run_indexes_nothing(self):
        with patch.object(search_index, "index_object") as index:
            with search_index.deferred(flush=False):
                Site.objects.create(tenant=self.tenant, name="HQ")
            index.assert_not_called()
