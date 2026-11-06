"""A cable's far end is named only to a caller who may view its device (#473).

A Site A viewer whose port is cabled to a Site B router saw the router's name
and port in ``link_peer``, the faceplate, export templates and the device PDF
report, while the router itself was a 404 for them.
"""
from unittest import mock

from django.contrib.auth.models import User
from django.db import connection
from django.test.utils import CaptureQueriesContext

from api import object_report as rep
from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    DeviceType,
    ExportTemplate,
    Interface,
    Manufacturer,
)
from api.test_utils import status_for
from api.tests_site_scope_gaps import _TwoSites
from auth_api.api import assemble_site_role
from core.models import DeploymentSettings

HIDDEN = {"device": "", "port": "", "port_label": "", "hidden": True}


class LinkPeerScopeTests(_TwoSites):
    def setUp(self):
        super().setUp()
        t = self.tenant
        mfr = Manufacturer.objects.create(tenant=t, name="M", slug="m")
        dtype = DeviceType.objects.create(tenant=t, name="X", manufacturer=mfr)
        role = DeviceRole.objects.create(tenant=t, name="R", slug="r")
        kw = {"tenant": t, "device_type": dtype, "role": role, "status": status_for(t)}
        self.rtr_a1 = Device.objects.create(name="rtr-a1", site=self.site_a, **kw)
        self.rtr_a2 = Device.objects.create(name="rtr-a2", site=self.site_a, **kw)
        self.secret = Device.objects.create(name="SecretRouterB", site=self.site_b, **kw)
        self.e1 = Interface.objects.create(device=self.rtr_a1, name="e1")
        self.e2 = Interface.objects.create(device=self.rtr_a1, name="e2")
        self._cable(self.e1, Interface.objects.create(device=self.secret, name="e1"))
        self._cable(self.e2, Interface.objects.create(device=self.rtr_a2, name="e9"))

    def _cable(self, a, b):
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface=a)
        CableTermination.objects.create(cable=cable, end="B", interface=b)

    def _viewers(self):
        """Yield (label, user) for the site role and an explicit grant, each
        with enhanced separation off and on."""
        for on in (False, True):
            dep = DeploymentSettings.load()
            dep.enhanced_site_separation = on
            dep.save()
            for how in ("role", "grant"):
                User.objects.filter(username="u").delete()
                self.user = User.objects.create_user("u", password="x")
                from auth_api.models import UserProfile

                UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
                if how == "role":
                    assemble_site_role(
                        self.tenant, "viewer", [self.site_a], user_ids=[self.user.id]
                    )
                else:
                    self._grant(["device", "interface", "cable", "site"])
                self._login()
                yield f"{how}/separation={on}"

    def _peers(self):
        r = self.client.get(f"/api/interfaces/?device={self.rtr_a1.id}")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        rows = body["results"] if isinstance(body, dict) else body
        return {row["name"]: row["link_peer"] for row in rows}

    def test_viewer_does_not_see_the_hidden_far_end(self):
        for label in self._viewers():
            with self.subTest(label):
                self.assertEqual(
                    self.client.get(f"/api/devices/{self.secret.id}/").status_code, 404
                )
                peers = self._peers()
                self.assertEqual(peers["e1"], HIDDEN)
                self.assertEqual(peers["e2"]["device"], "rtr-a2")
                detail = self.client.get(f"/api/interfaces/{self.e1.id}/").json()
                self.assertEqual(detail["link_peer"], HIDDEN)
                face = self.client.get(f"/api/devices/{self.rtr_a1.id}/face-ports/")
                self.assertNotIn("SecretRouterB", face.content.decode())

    def test_admin_sees_every_far_end(self):
        self.user = User.objects.create_superuser("root", "r@example.com", "x")
        self._login()
        peers = self._peers()
        self.assertEqual(peers["e1"]["device"], "SecretRouterB")
        self.assertNotIn("hidden", peers["e1"])
        self.assertEqual(peers["e2"]["device"], "rtr-a2")

    def test_query_count_does_not_grow_with_rows(self):
        assemble_site_role(self.tenant, "viewer", [self.site_a], user_ids=[self.user.id])
        self._login()
        self._peers()  # warm caches

        def count():
            with CaptureQueriesContext(connection) as ctx:
                self._peers()
            return len(ctx.captured_queries)

        before = count()
        for i in range(6):
            far = Device.objects.create(
                tenant=self.tenant, name=f"b{i}", site=self.site_b,
                device_type=self.secret.device_type, role=self.secret.role,
                status=self.secret.status,
            )
            self._cable(
                Interface.objects.create(device=self.rtr_a1, name=f"x{i}"),
                Interface.objects.create(device=far, name="p"),
            )
        self.assertEqual(count(), before)

    def test_export_template_hides_the_far_end(self):
        from api.export_templates import render_device_config

        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="peers", object_type="device",
            template_code=(
                "{% for i in interfaces %}{{ i.name }}={{ i.link_peer.device }}"
                "{% if i.link_peer.hidden %}(hidden){% endif %};{% endfor %}"
            ),
        )
        for label in self._viewers():
            with self.subTest(label):
                out = render_device_config(t, self.rtr_a1, self.tenant, self.user)
                self.assertNotIn("SecretRouterB", out)
                self.assertIn("e1=(hidden);", out)
                self.assertIn("e2=rtr-a2;", out)
        admin = User.objects.create_superuser("root", "r@example.com", "x")
        out = render_device_config(t, self.rtr_a1, self.tenant, admin)
        self.assertIn("e1=SecretRouterB;", out)

    def _report_html(self):
        seen = {}

        def fake(**kwargs):
            seen["html"] = kwargs["html"]
            return b"%PDF-1.7 fake"

        with mock.patch.object(rep, "render_with_deadline", side_effect=fake):
            r = self.client.post(
                "/api/devices/report/",
                {"ids": [str(self.rtr_a1.id)], "sections": ["interfaces"],
                 "options": {"per_object": True}},
                format="json",
            )
        self.assertEqual(r.status_code, 200, r.content[:500])
        return seen["html"]

    def test_pdf_report_does_not_print_the_hidden_far_end(self):
        for label in self._viewers():
            with self.subTest(label):
                html = self._report_html()
                self.assertNotIn("SecretRouterB", html)
                self.assertIn("rtr-a2 · e9", html)
        self.user = User.objects.create_superuser("root", "r@example.com", "x")
        self._login()
        self.assertIn("SecretRouterB · e1", self._report_html())
