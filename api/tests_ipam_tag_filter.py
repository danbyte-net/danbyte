"""``/api/ips/`` and ``/api/prefixes/`` take ``?tag=<slug>`` and
``?tag_id=<id>``, each repeatable, all of them required (as on devices)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tag, Tenant

from .models import IPAddress, Prefix

User = get_user_model()


class IpamTagFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.gw = Tag.objects.create(tenant=self.tenant, name="anycast-gw", slug="anycast-gw")
        self.pod = Tag.objects.create(tenant=self.tenant, name="pod-1", slug="pod-1")
        theirs = Tag.objects.create(tenant=other, name="anycast-gw", slug="anycast-gw")
        self.p1 = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.p2 = Prefix.objects.create(tenant=self.tenant, cidr="10.0.1.0/24")
        self.p1.tags.add(self.gw, self.pod)
        self.p2.tags.add(self.pod)
        self.a = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.1",
                                          prefix=self.p1)
        self.b = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.2",
                                          prefix=self.p1)
        self.c = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.1.1",
                                          prefix=self.p2)
        self.a.tags.add(self.gw, self.pod)
        self.b.tags.add(self.pod)
        op = Prefix.objects.create(tenant=other, cidr="10.0.0.0/24")
        x = IPAddress.objects.create(tenant=other, ip_address="10.0.0.9", prefix=op)
        x.tags.add(theirs)

    def ids(self, path):
        r = self.client.get(path)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        rows = body["results"] if isinstance(body, dict) else body
        return {row["id"] for row in rows}

    def test_ips(self):
        a, b, c = str(self.a.id), str(self.b.id), str(self.c.id)
        self.assertEqual(self.ids("/api/ips/"), {a, b, c})
        self.assertEqual(self.ids("/api/ips/?tag=anycast-gw"), {a})
        self.assertEqual(self.ids("/api/ips/?tag=pod-1"), {a, b})
        self.assertEqual(self.ids("/api/ips/?tag=pod-1&tag=anycast-gw"), {a})
        self.assertEqual(self.ids(f"/api/ips/?tag_id={self.pod.id}"), {a, b})
        self.assertEqual(self.ids(f"/api/ips/?tag=anycast-gw&tag_id={self.pod.id}"), {a})
        self.assertEqual(self.ids("/api/ips/?tag=nope"), set())
        self.assertEqual(self.client.get("/api/ips/?tag_id=x").status_code, 400)

    def test_prefixes(self):
        p1, p2 = str(self.p1.id), str(self.p2.id)
        self.assertEqual(self.ids("/api/prefixes/"), {p1, p2})
        self.assertEqual(self.ids("/api/prefixes/?tag=anycast-gw"), {p1})
        self.assertEqual(self.ids("/api/prefixes/?tag=pod-1"), {p1, p2})
        self.assertEqual(self.ids(f"/api/prefixes/?tag_id={self.gw.id}"), {p1})
        self.assertEqual(self.ids("/api/prefixes/?tag=pod-1&search=10.0.1"), {p2})
