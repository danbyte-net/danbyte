"""Milestone 6/8 tests — the monitoring REST slice the IP Monitoring tab uses."""
from __future__ import annotations

import socket

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from .models import CheckAssignment, CheckResult, CheckTemplate


from api.test_utils import status_for


def _open_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(8)
    return s, s.getsockname()[1]


class MonitoringApiTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="127.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="127.0.0.1", prefix=self.prefix
        )
        self.user = get_user_model().objects.create_superuser(
            "admin", "a@b.c", "pw"
        )
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _make_template(self, **body):
        body.setdefault("name", "ping")
        body.setdefault("kind", "icmp")
        body.setdefault("params", {})
        return self.client.post("/api/monitoring/templates/", body, format="json")

    def test_template_param_validation(self):
        r = self.client.post(
            "/api/monitoring/templates/",
            {"name": "bad", "kind": "tcp", "params": {}},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("params", r.json())

    def test_template_crud_and_secret_write_only(self):
        r = self._make_template(
            name="ssh", kind="tcp", params={"port": 22},
            secret_params={"password": "hunter2"},
        )
        self.assertEqual(r.status_code, 201, r.content)
        tid = r.json()["id"]
        self.assertTrue(r.json()["has_secrets"])
        self.assertNotIn("secret_params", r.json())

        got = self.client.get(f"/api/monitoring/templates/{tid}/").json()
        self.assertNotIn("secret_params", got)
        self.assertTrue(got["has_secrets"])

    def test_assignment_requires_one_target(self):
        t = self._make_template().json()
        r = self.client.post(
            "/api/monitoring/assignments/",
            {"template": t["id"], "ip_address": str(self.ip.id), "prefix": str(self.prefix.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_checks_summary_and_check_now_and_history(self):
        listener, port = _open_port()
        try:
            t = self._make_template(name="tcp", kind="tcp", params={"port": port}).json()
            r = self.client.post(
                "/api/monitoring/assignments/",
                {"template": t["id"], "ip_address": str(self.ip.id), "schedule_mode": "custom_on"},
                format="json",
            )
            self.assertEqual(r.status_code, 201, r.content)

            summary = self.client.get(f"/api/monitoring/ips/{self.ip.id}/checks/").json()
            self.assertEqual(len(summary["checks"]), 1)
            self.assertIsNone(summary["checks"][0]["state"])

            run = self.client.post(f"/api/monitoring/ips/{self.ip.id}/check-now/").json()
            self.assertEqual(run["results"][0]["status"], "up")

            hist = self.client.get(f"/api/monitoring/ips/{self.ip.id}/history/").json()
            self.assertEqual(hist["count"], 1)
            self.assertEqual(CheckResult.objects.filter(target_ip=self.ip).count(), 1)
        finally:
            listener.close()

    def test_remove_assignment(self):
        t = self._make_template().json()
        a = self.client.post(
            "/api/monitoring/assignments/",
            {"template": t["id"], "ip_address": str(self.ip.id)},
            format="json",
        ).json()
        r = self.client.delete(f"/api/monitoring/assignments/{a['id']}/")
        self.assertEqual(r.status_code, 204)
        self.assertEqual(CheckAssignment.objects.count(), 0)

    def test_prefix_checks_rollup_and_grid(self):
        listener, port = _open_port()
        try:
            # two more IPs in the prefix so the rollup has a mix
            ip2 = IPAddress.objects.create(
                tenant=self.tenant, ip_address="127.0.0.9", prefix=self.prefix
            )
            # rise=fall=1 so one result is decisive (no hysteresis lag).
            t = self._make_template(
                name="tcp", kind="tcp", params={"port": port}, rise=1, fall=1
            ).json()
            self.client.post(
                "/api/monitoring/assignments/",
                {"template": t["id"], "prefix": str(self.prefix.id)},
                format="json",
            )
            # materialise + run inline so CheckState/rollup populate
            from monitoring.scheduler import dispatch, materialise_states

            materialise_states(tenant=self.tenant)
            dispatch(sync=True)

            r = self.client.get(f"/api/monitoring/prefixes/{self.prefix.id}/checks/")
            self.assertEqual(r.status_code, 200)
            body = r.json()
            self.assertEqual(len(body["assignments"]), 1)
            self.assertTrue(body["assignments"][0]["apply_to_children"])
            self.assertEqual(body["rollup"]["monitored_ips"], 2)
            # 127.0.0.1 reaches the listener (up); 127.0.0.9 refuses (down) →
            # worst-wins rollup is down.
            self.assertEqual(body["rollup"]["status"], "down")
            self.assertEqual(len(body["ips"]), 2)
            _ = ip2
        finally:
            listener.close()

    def test_bulk_status_for_ips(self):
        listener, port = _open_port()
        try:
            t = self._make_template(name="tcp", kind="tcp", params={"port": port}).json()
            self.client.post(
                "/api/monitoring/assignments/",
                {"template": t["id"], "ip_address": str(self.ip.id)},
                format="json",
            )
            from monitoring.scheduler import dispatch, materialise_states

            materialise_states(tenant=self.tenant)
            dispatch(sync=True)
            r = self.client.get(f"/api/monitoring/status/?ips={self.ip.id}")
            self.assertEqual(r.status_code, 200)
            entry = r.json()["statuses"][str(self.ip.id)]
            self.assertEqual(entry["status"], "up")
            self.assertEqual(entry["checks"], 1)
        finally:
            listener.close()

    def test_prefix_schedule_mode_patch(self):
        t = self._make_template().json()
        a = self.client.post(
            "/api/monitoring/assignments/",
            {"template": t["id"], "prefix": str(self.prefix.id)},
            format="json",
        ).json()
        r = self.client.patch(
            f"/api/monitoring/assignments/{a['id']}/",
            {"schedule_mode": "custom_off", "apply_to_children": False},
            format="json",
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["schedule_mode"], "custom_off")
        self.assertFalse(r.json()["apply_to_children"])

    def test_bulk_check_now_by_prefix(self):
        listener, port = _open_port()
        try:
            ip2 = IPAddress.objects.create(
                tenant=self.tenant, ip_address="127.0.0.9", prefix=self.prefix
            )
            t = self._make_template(name="tcp", kind="tcp", params={"port": port}).json()
            self.client.post(
                "/api/monitoring/assignments/",
                {"template": t["id"], "prefix": str(self.prefix.id)},
                format="json",
            )
            r = self.client.post(
                "/api/monitoring/bulk-check-now/",
                {"prefix_ids": [str(self.prefix.id)]},
                format="json",
            )
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["targets"], 2)
            self.assertEqual(r.json()["checks"], 2)
            _ = ip2
        finally:
            listener.close()

    def test_bulk_check_now_empty(self):
        r = self.client.post(
            "/api/monitoring/bulk-check-now/", {"ip_ids": []}, format="json"
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"targets": 0, "checks": 0})

    def test_cross_tenant_ip_rejected_on_assignment(self):
        other_org = Organization.objects.create(name="Other", slug="other")
        other_t = Tenant.objects.create(org=other_org, name="Other", slug="other")
        other_pfx = Prefix.objects.create(tenant=other_t, cidr="10.0.0.0/8", status=status_for(other_t, "container"))
        other_ip = IPAddress.objects.create(
            tenant=other_t, ip_address="10.0.0.1", prefix=other_pfx
        )
        t = self._make_template().json()
        r = self.client.post(
            "/api/monitoring/assignments/",
            {"template": t["id"], "ip_address": str(other_ip.id)},
            format="json",
        )
        # The other tenant's IP isn't visible → rejected (400/404), never created.
        self.assertIn(r.status_code, (400, 404))
        self.assertFalse(
            CheckAssignment.objects.filter(ip_address=other_ip).exists()
        )


class BulkStatusPostTests(MonitoringApiTests):
    """POST body variant of the bulk status endpoint — a page of ~110 UUIDs
    makes a GET URL longer than gunicorn's request-line limit, so the SPA
    POSTs the id lists instead."""

    def test_post_ips_matches_get(self):
        listener, port = _open_port()
        try:
            t = self._make_template(
                name="tcp-post", kind="tcp", params={"port": port}
            ).json()
            self.client.post(
                "/api/monitoring/assignments/",
                {"template": t["id"], "ip_address": str(self.ip.id)},
                format="json",
            )
            from monitoring.scheduler import dispatch, materialise_states

            materialise_states(tenant=self.tenant)
            dispatch(sync=True)
            r = self.client.post(
                "/api/monitoring/status/",
                {"ips": [str(self.ip.id)]},
                format="json",
            )
            self.assertEqual(r.status_code, 200, r.content)
            entry = r.json()["statuses"][str(self.ip.id)]
            self.assertEqual(entry["status"], "up")
        finally:
            listener.close()

    def test_post_many_prefix_ids_is_accepted(self):
        # The exact failure shape from the field: >110 ids in one call.
        import uuid

        ids = [str(uuid.uuid4()) for _ in range(120)] + [str(self.prefix.id)]
        r = self.client.post(
            "/api/monitoring/status/", {"prefixes": ids}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_post_still_bounded(self):
        import uuid

        ids = [str(uuid.uuid4()) for _ in range(501)]
        r = self.client.post(
            "/api/monitoring/status/", {"prefixes": ids}, format="json"
        )
        self.assertEqual(r.status_code, 400)
