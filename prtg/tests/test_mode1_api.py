"""The Mode 1 API: links, the queue, adoption rules, the state map, device
status, the device-list filter and the push receiver - and that none of it
crosses a tenant."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APITestCase

from api.models import Device, IPAddress, Prefix, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings
from monitoring.models import MonitoringEngine
from prtg.hook import RATE_PER_MINUTE, new_token
from prtg.models import PrtgAdoptionRule, PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgSensor


class _Base(APITestCase):
    def setUp(self):
        cache.clear()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        for tenant in (self.tenant, self.other):
            IntegrationSettings.objects.update_or_create(
                tenant=tenant, defaults={"prtg_enabled": True}
            )
        self.admin = get_user_model().objects.create_superuser("root", "r@x.io", "pw")
        self.conn = self._world(self.tenant, "a")
        self.foreign = self._world(self.other, "b")

    def _world(self, tenant, tag):
        site = Site.objects.create(tenant=tenant, name=f"S{tag}")
        prefix = Prefix.objects.create(tenant=tenant, cidr="10.0.0.0/24")
        conn = PrtgConnection.objects.create(
            tenant=tenant, name=f"prtg-{tag}", url="https://prtg.example.com",
            credentials={"api_key": "k"},
        )
        device = Device.objects.create(tenant=tenant, name=f"dev-{tag}", site=site)
        ip = IPAddress.objects.create(
            tenant=tenant, ip_address="10.0.0.5/24", prefix=prefix, assigned_device=device,
        )
        link = PrtgDeviceLink.objects.create(
            tenant=tenant, connection=conn, device=device, objid="2081", name="db-dev01",
            host="10.0.0.5", matched_by="address", state="degraded",
            sensor_counts={"total": 2, "up": 1, "degraded": 1, "paused": 0},
        )
        PrtgSensor.objects.create(
            tenant=tenant, connection=conn, link=link, device=device, objid="2091",
            name="SSL Certificate", status_raw=4, state="degraded", message="Warning",
        )
        PrtgChange.objects.create(
            tenant=tenant, connection=conn, device=device, kind=PrtgChange.AMBIGUOUS,
            detail={"reason": "two"},
        )
        setattr(self, f"device_{tag}", device)
        setattr(self, f"ip_{tag}", ip)
        setattr(self, f"site_{tag}", site)
        return conn

    def login(self, user=None):
        self.client.force_login(user or self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()


class TenantIsolationTests(_Base):
    def test_lists_show_only_the_active_tenant(self):
        self.login()
        for url in ("/api/prtg/links/", "/api/prtg/changes/", "/api/prtg/connections/"):
            with self.subTest(url=url):
                rows = self.client.get(url).json()
                rows = rows.get("results", rows) if isinstance(rows, dict) else rows
                self.assertEqual(len(rows), 1, rows)

    def test_foreign_rows_are_404(self):
        self.login()
        link = PrtgDeviceLink.objects.get(connection=self.foreign)
        change = PrtgChange.objects.get(connection=self.foreign)
        self.assertEqual(self.client.get(f"/api/prtg/links/{link.id}/").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/prtg/links/{link.id}/").status_code, 404)
        self.assertEqual(
            self.client.post(f"/api/prtg/changes/{change.id}/dismiss/").status_code, 404)
        self.assertEqual(self.client.post(
            "/api/prtg/changes/apply-all/", {"connection": str(self.foreign.id)},
            format="json").status_code, 404)

    def test_device_status_and_states_never_cross(self):
        self.login()
        r = self.client.get(f"/api/prtg/device-status/?device={self.device_b.id}")
        self.assertEqual(r.json(), [])
        r = self.client.get(f"/api/prtg/device-status/?ip={self.ip_b.id}")
        self.assertEqual(r.json(), [])
        states = self.client.get("/api/prtg/device-states/").json()
        self.assertEqual(list(states), [str(self.device_a.id)])
        self.assertEqual(states[str(self.device_a.id)]["state"], "degraded")
        self.assertEqual(states[str(self.device_a.id)]["warning"], 1)
        self.assertEqual(states[str(self.device_a.id)]["url"],
                         "https://prtg.example.com/device.htm?id=2081")

    def test_device_status_of_own_device(self):
        self.login()
        [entry] = self.client.get(f"/api/prtg/device-status/?device={self.device_a.id}").json()
        self.assertEqual(entry["status"]["state"], "degraded")
        self.assertEqual(entry["status"]["problems"][0]["name"], "SSL Certificate")

    def test_adoption_rule_refuses_foreign_rows(self):
        self.login()
        r = self.client.post("/api/prtg/adoption-rules/", {
            "connection": str(self.foreign.id), "pattern": "kbh-*", "site": str(self.site_a.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/prtg/adoption-rules/", {
            "connection": str(self.conn.id), "pattern": "kbh-*", "site": str(self.site_b.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/prtg/adoption-rules/", {
            "connection": str(self.conn.id), "pattern": "10.0.0.0/33", "scope": "ip",
            "site": str(self.site_a.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/api/prtg/adoption-rules/", {
            "connection": str(self.conn.id), "pattern": "10.0.0.0/24", "scope": "ip",
            "site": str(self.site_a.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(PrtgAdoptionRule.objects.get().tenant, self.tenant)

    def test_the_toggle_hides_everything(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        self.login()
        for url in ("/api/prtg/links/", "/api/prtg/changes/", "/api/prtg/adoption-rules/",
                    "/api/prtg/device-states/",
                    f"/api/prtg/device-status/?device={self.device_a.id}"):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 404)

    def test_a_member_without_the_type_sees_nothing(self):
        user = get_user_model().objects.create_user("m", "m@x.io", "pw")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="m", object_types=["device"], actions=["view"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.client.get("/api/prtg/links/").status_code, 403)
        self.assertEqual(self.client.get("/api/prtg/changes/").status_code, 403)


class QueueTests(_Base):
    def test_ambiguous_cannot_be_applied_and_a_link_can(self):
        self.login()
        amb = PrtgChange.objects.get(connection=self.conn)
        r = self.client.post(f"/api/prtg/changes/{amb.id}/apply/")
        self.assertEqual(r.status_code, 400)
        d = Device.objects.create(tenant=self.tenant, name="db-zabbix")
        link = PrtgChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=d, kind=PrtgChange.LINK,
            key="2082", detail={"objid": "2082", "name": "db-zabbix", "matched_by": "name"},
        )
        r = self.client.post(f"/api/prtg/changes/{link.id}/apply/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(PrtgDeviceLink.objects.get(device=d).objid, "2082")
        self.assertFalse(PrtgChange.objects.filter(id=link.id).exists())

    def test_apply_refuses_a_taken_prtg_device(self):
        self.login()
        d = Device.objects.create(tenant=self.tenant, name="twin")
        change = PrtgChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=d, kind=PrtgChange.LINK,
            key="2081", detail={"objid": "2081"},
        )
        r = self.client.post(f"/api/prtg/changes/{change.id}/apply/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("already linked", r.json()["detail"])

    def test_apply_all_skips_ambiguity(self):
        self.login()
        d = Device.objects.create(tenant=self.tenant, name="db-zabbix")
        PrtgChange.objects.create(
            tenant=self.tenant, connection=self.conn, device=d, kind=PrtgChange.LINK,
            key="2082", detail={"objid": "2082"},
        )
        r = self.client.post("/api/prtg/changes/apply-all/",
                             {"connection": str(self.conn.id)}, format="json")
        self.assertEqual(r.json()["applied"], 1)
        self.assertTrue(PrtgChange.objects.filter(kind=PrtgChange.AMBIGUOUS,
                                                  connection=self.conn).exists())


class ConnectionFieldTests(_Base):
    def test_defaults_describe_the_map(self):
        self.login()
        body = self.client.get("/api/prtg/connections/defaults/").json()
        codes = {c["value"]: c for c in body["codes"]}
        self.assertFalse(codes["3"]["fixed"])
        self.assertTrue(codes["11"]["fixed"])
        self.assertEqual(codes["11"]["reason"], "PRTG licence limit")
        self.assertEqual(body["default_map"]["14"], "degraded")
        self.assertEqual([s["value"] for s in body["statuses"]], ["up", "degraded", "down"])

    def test_state_map_validation(self):
        self.login()
        url = f"/api/prtg/connections/{self.conn.id}/"
        for bad in ({"11": "down"}, {"3": "purple"}, {"42": "up"}, ["up"]):
            with self.subTest(bad=bad):
                r = self.client.patch(url, {"state_map": bad}, format="json")
                self.assertEqual(r.status_code, 400, r.content)
        r = self.client.patch(url, {"state_map": {"4": "up", "10": "up"}}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        stored = r.json()["state_map"]
        self.assertEqual((stored["4"], stored["10"], stored["5"], stored["11"]),
                         ("up", "up", "down", "unknown"))
        # The stored roll-up follows the new map at once.
        self.assertEqual(PrtgDeviceLink.objects.get(connection=self.conn).state, "up")

    def test_engines_must_be_own_prtg_engines(self):
        self.login()
        url = f"/api/prtg/connections/{self.conn.id}/"
        local = MonitoringEngine.local_for(self.tenant)
        foreign = MonitoringEngine.objects.create(
            tenant=self.other, name="p", slug="p", kind="prtg")
        own = MonitoringEngine.objects.create(
            tenant=self.tenant, name="p", slug="p", kind="prtg")
        self.assertEqual(self.client.patch(
            url, {"engines": [str(local.id)]}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(
            url, {"engines": [str(foreign.id)]}, format="json").status_code, 400)
        r = self.client.patch(url, {"engines": [str(own.id)]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["engine_names"], [{"id": str(own.id), "name": "p"}])

    def test_the_hook_token_is_shown_once(self):
        self.login()
        r = self.client.post(f"/api/prtg/connections/{self.conn.id}/rotate-hook-token/")
        token = r.json()["token"]
        self.assertEqual(r.json()["path"], f"/api/prtg/hook/{token}/")
        body = self.client.get(f"/api/prtg/connections/{self.conn.id}/").json()
        self.assertTrue(body["hook_token_set"])
        self.assertNotIn(token, str(body))
        self.conn.refresh_from_db()
        self.assertNotIn(token, self.conn.hook_token_hash)


class DeviceFilterTests(_Base):
    def test_prtg_filter(self):
        self.login()
        lone = Device.objects.create(tenant=self.tenant, name="lone")

        def names(q):
            rows = self.client.get(f"/api/devices/?prtg={q}").json()
            return sorted(r["name"] for r in rows.get("results", rows))

        self.assertEqual(names("linked"), ["dev-a"])
        self.assertEqual(names("degraded"), ["dev-a"])
        self.assertEqual(names("down"), [])
        self.assertEqual(names("unlinked"), [lone.name])
        self.assertEqual(self.client.get("/api/devices/?prtg=bogus").status_code, 400)


class HookTests(_Base):
    def setUp(self):
        super().setUp()
        self.conn.push_enabled = True
        self.conn.save()
        self.token = new_token(self.conn)
        self.url = f"/api/prtg/hook/{self.token}/"

    def post(self, url=None, data=None):
        with mock.patch("django_rq.get_queue") as q:
            r = self.client.post(url or self.url, data or {
                "sensorid": "2091", "deviceid": "2081", "laststatus": "Down",
            })
        return r, q.return_value.enqueue

    def test_a_good_hint_queues_a_reread_of_the_ids_only(self):
        r, enqueue = self.post()
        self.assertEqual(r.status_code, 202, r.content)
        args = enqueue.call_args.args
        self.assertEqual(args[1:], (str(self.conn.id), 2091, 2081))
        # The payload's status is never used: nothing was written.
        self.assertEqual(PrtgSensor.objects.get(objid="2091", connection=self.conn).state,
                         "degraded")

    def test_debounced(self):
        self.post()
        r, enqueue = self.post()
        self.assertEqual(r.json()["queued"], False)
        enqueue.assert_not_called()

    def test_bad_token_and_switches_are_404(self):
        r, enqueue = self.post(url="/api/prtg/hook/not-a-token/")
        self.assertEqual(r.status_code, 404)
        foreign_token = new_token(self.foreign)  # push off on the other one
        r, _ = self.post(url=f"/api/prtg/hook/{foreign_token}/")
        self.assertEqual(r.status_code, 404)
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        self.assertEqual(self.post()[0].status_code, 404)
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=True)
        self.tenant.is_active = False
        self.tenant.save()
        self.assertEqual(self.post()[0].status_code, 404)
        self.tenant.is_active = True
        self.tenant.save()
        new_token(self.conn)   # rotated: the old token is dead
        self.assertEqual(self.post()[0].status_code, 404)

    def test_rate_limited_per_connection(self):
        for i in range(RATE_PER_MINUTE):
            r, _ = self.post(data={"sensorid": str(3000 + i)})
            self.assertEqual(r.status_code, 202)
        r, enqueue = self.post(data={"sensorid": "9999"})
        self.assertEqual(r.status_code, 429)
        enqueue.assert_not_called()

    def test_needs_an_id(self):
        r, _ = self.post(data={"laststatus": "Down"})
        self.assertEqual(r.status_code, 400)

    def test_no_session_needed(self):
        self.client.logout()
        self.assertEqual(self.post()[0].status_code, 202)
