"""``FastJSONRenderer`` writes the same bytes as DRF's ``JSONRenderer`` (#488).

With ``orjson`` absent (it is not a requirement yet) the renderer is DRF's own;
the comparisons that need ``orjson`` skip. Run them with it on the path to
check a candidate version before it is added to requirements.txt.
"""
from __future__ import annotations

import datetime
import decimal
import ipaddress
import unittest
import uuid

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from django.utils.translation import gettext_lazy
from rest_framework.renderers import JSONRenderer
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from . import renderers
from .models import Device, Interface, IPAddress, Prefix, Site

needs_orjson = unittest.skipUnless(renderers.orjson_available(), "orjson is not installed")


def both(data, media_type="application/json"):
    return (JSONRenderer().render(data, media_type, {}),
            renderers.FastJSONRenderer().render(data, media_type, {}))


class RendererSeamTests(SimpleTestCase):
    def test_the_api_renders_through_the_seam(self):
        from django.conf import settings

        self.assertEqual(settings.REST_FRAMEWORK["DEFAULT_RENDERER_CLASSES"][0],
                         "api.renderers.FastJSONRenderer")

    def test_none_renders_empty(self):
        self.assertEqual(renderers.FastJSONRenderer().render(None), b"")


@needs_orjson
class ScalarParityTests(SimpleTestCase):
    def test_values_drf_formats_itself(self):
        utc = datetime.UTC
        data = {
            "aware": datetime.datetime(2026, 11, 6, 8, 30, 1, 123456, tzinfo=utc),
            "aware_whole": datetime.datetime(2026, 11, 6, 8, 30, tzinfo=utc),
            "offset": datetime.datetime(
                2026, 11, 6, 8, 30, tzinfo=datetime.timezone(datetime.timedelta(hours=2))),
            "naive": datetime.datetime(2026, 11, 6, 8, 30),
            "date": datetime.date(2026, 11, 6),
            "time": datetime.time(8, 30, 1, 5),
            "delta": datetime.timedelta(hours=1, seconds=3),
            "decimal": decimal.Decimal("12.50"),
            "uuid": uuid.UUID("12345678-1234-5678-1234-567812345678"),
            "ip": ipaddress.ip_address("10.0.0.1"),
            "net": ipaddress.ip_network("2001:db8::/32"),
            "iface": ipaddress.ip_interface("10.0.0.1/24"),
            "lazy": gettext_lazy("Name"),
            "bytes": b"raw",
            "set": {1},
            "tuple": (1, 2),
            "keys": {1: "a", None: "b", 1.5: "d"},
            "text": 'quote " backslash \\ ctrl \x01     é 😀 </script>',
            "floats": [0.1, 1.0, -0.0, 123456789.123, 2.5e-3],
            "big": 2**63 - 1,
            "nested": [{"a": [None, True, False]}],
        }
        drf, fast = both(data)
        self.assertEqual(fast, drf)

    def test_what_orjson_refuses_falls_back(self):
        drf, fast = both({"huge": 2**70})
        self.assertEqual(fast, drf)

    def test_indent_falls_back(self):
        drf, fast = both({"a": [1, 2]}, "application/json; indent=2")
        self.assertEqual(fast, drf)
        self.assertIn(b"\n", fast)

    def test_unencodable_still_raises(self):
        with self.assertRaises(TypeError):
            renderers.FastJSONRenderer().render({"x": object()})


@needs_orjson
class PayloadParityTests(APITestCase):
    """Real list and detail payloads, rendered both ways."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = get_user_model().objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        site = Site.objects.create(tenant=self.tenant, name="HQ – Ærø")
        for n in range(3):
            d = Device.objects.create(tenant=self.tenant, name=f"sw-{n}", site=site)
            Interface.objects.create(device=d, name="Gi0/1", mtu=9000)
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.5", prefix=pfx)

    def test_lists_and_details_render_identically(self):
        for url in ("/api/devices/", "/api/interfaces/", "/api/prefixes/",
                    "/api/ips/", "/api/sites/",
                    f"/api/devices/{Device.objects.first().pk}/"):
            with self.subTest(url):
                r = self.client.get(url)
                self.assertEqual(r.status_code, 200, r.content)
                drf, fast = both(r.data)
                self.assertEqual(fast, drf)
                self.assertEqual(r.content, drf)
