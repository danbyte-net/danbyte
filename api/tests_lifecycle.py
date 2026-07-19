"""Hardware/OS lifecycle management (EoS / EoL) — LifecycleMixin on
DeviceType + Platform, the derived lifecycle_state, and the ?lifecycle=
filter buckets."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APIClient

from api.models import DeviceType, Platform
from core.models import Organization, Tenant


def days(n: int):
    return timezone.localdate() + timedelta(days=n)


class LifecycleStateTests:
    """Mixed into both model test classes below."""

    model: type
    kwargs: dict

    def make(self, **kw):
        return self.model.objects.create(tenant=self.tenant, **self.kwargs, **kw)

    def test_no_dates_is_blank(self):
        self.assertEqual(self.make(name="a").lifecycle_state, "")

    def test_future_dates_are_supported(self):
        obj = self.make(name="b", end_of_support=days(365))
        self.assertEqual(obj.lifecycle_state, "supported")

    def test_release_date_alone_is_supported(self):
        self.assertEqual(
            self.make(name="c", release_date=days(-100)).lifecycle_state,
            "supported",
        )

    def test_most_severe_passed_milestone_wins(self):
        obj = self.make(
            name="d",
            end_of_sale=days(-300),
            end_of_security_updates=days(-30),
            end_of_support=days(90),
        )
        self.assertEqual(obj.lifecycle_state, "security_ended")
        obj.end_of_support = days(-1)
        self.assertEqual(obj.lifecycle_state, "eol")

    def test_past_sale_only_is_eos(self):
        obj = self.make(name="e", end_of_sale=days(-1), end_of_support=days(400))
        self.assertEqual(obj.lifecycle_state, "eos")


from django.test import TestCase  # noqa: E402


class BaseCase(TestCase):
    list_url: str

    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.admin = User.objects.create_superuser("lc-admin", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()


class DeviceTypeLifecycleTests(LifecycleStateTests, BaseCase):
    model = DeviceType
    kwargs = {}
    list_url = "/api/device-types/"

    def test_filter_buckets(self):
        self.make(name="fresh", end_of_support=days(500))
        self.make(name="sold-out", end_of_sale=days(-10), end_of_support=days(500))
        self.make(name="dead", end_of_support=days(-10))
        self.make(name="undated")

        def names(bucket):
            r = self.client_api.get(self.list_url, {"lifecycle": bucket})
            self.assertEqual(r.status_code, 200, r.content)
            rows = r.json()["results"] if "results" in r.json() else r.json()
            return sorted(x["name"] for x in rows)

        self.assertEqual(names("eol"), ["dead"])
        self.assertEqual(names("eos"), ["sold-out"])
        self.assertEqual(names("supported"), ["fresh"])
        self.assertEqual(names("none"), ["undated"])

    def test_dates_roundtrip_and_state_exposed(self):
        r = self.client_api.post(self.list_url, {
            "name": "C9300",
            "end_of_sale": str(days(-5)),
            "end_of_support": str(days(600)),
            "lifecycle_url": "https://vendor.example.com/eol/c9300",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["lifecycle_state"], "eos")
        self.assertEqual(body["lifecycle_url"],
                         "https://vendor.example.com/eol/c9300")


class PlatformLifecycleTests(LifecycleStateTests, BaseCase):
    model = Platform
    list_url = "/api/platforms/"

    @property
    def kwargs(self):
        return {"slug": f"p{Platform.objects.count()}"}

    def test_filter_buckets(self):
        self.make(name="ios-new", end_of_support=days(500))
        self.make(name="ios-eol", end_of_support=days(-10))

        r = self.client_api.get(self.list_url, {"lifecycle": "eol"})
        rows = r.json()["results"] if "results" in r.json() else r.json()
        self.assertEqual([x["name"] for x in rows], ["ios-eol"])
        self.assertEqual(rows[0]["lifecycle_state"], "eol")
