"""Agent access: the toggle, the handshake, and what a token may reach.

These are the security tests. An assistant must never see more than its
token's owner would, must never receive a secret, and must not be able to
write until an admin says so.
"""
from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, DeviceRole, DeviceType, Manufacturer, Site
from auth_api.models import ApiToken, ObjectPermission, UserProfile, hash_api_key
from core.models import Organization, Tenant
from integrations.models import IntegrationSettings

from .models import AgentCall, AgentSettings


def rpc(method: str, params: dict | None = None, id_: int | str = 1) -> dict:
    body = {"jsonrpc": "2.0", "method": method}
    if id_ is not None:
        body["id"] = id_
    if params is not None:
        body["params"] = params
    return body


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other_tenant = Tenant.objects.create(org=org, name="U", slug="u")
        self.user = get_user_model().objects.create_user("agent", "a@e.com", "x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(self.tenant)
        self.grant(["view", "add", "change", "delete"], ["*"])
        self.key = "dbt_" + "a" * 48
        self.token = ApiToken.objects.create(
            user=self.user, tenant=self.tenant, name="assistant",
            key_hash=hash_api_key(self.key), prefix=self.key[:11], scope="full",
        )
        self.settings_row = IntegrationSettings.objects.create(
            tenant=self.tenant, ai_access_enabled=True
        )
        # A little inventory to answer questions about.
        self.site = Site.objects.create(tenant=self.tenant, name="Aarhus")
        self.other_site = Site.objects.create(tenant=self.tenant, name="HQ")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Dell", slug="dell")
        self.dtype = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, name="R640", model="R640"
        )
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Core", slug="core")
        self.device = Device.objects.create(
            tenant=self.tenant, name="aarhus-core-1", site=self.site,
            device_type=self.dtype, role=self.role,
        )
        self.elsewhere = Device.objects.create(
            tenant=self.tenant, name="hq-core-1", site=self.other_site,
            device_type=self.dtype, role=self.role,
        )

    def grant(self, actions, types, *, user=None, sites=None):
        perm = ObjectPermission.objects.create(
            name=f"grant-{'-'.join(actions)}-{len(ObjectPermission.objects.all())}",
            object_types=list(types), actions=list(actions), enabled=True,
        )
        perm.tenants.add(self.tenant)
        perm.users.add(user or self.user)
        if sites:
            for s in sites:
                perm.sites.add(s)
        return perm

    def call(self, body, *, key=None, expect=200):
        response = self.client.post(
            "/api/mcp/", json.dumps(body), content_type="application/json",
            HTTP_AUTHORIZATION=f"Token {key or self.key}",
        )
        self.assertEqual(response.status_code, expect, response.content[:400])
        return response.json() if response.content else None

    def tool(self, name, arguments=None, *, key=None):
        answer = self.call(rpc("tools/call", {"name": name, "arguments": arguments or {}}),
                           key=key)
        result = answer["result"]
        if result.get("isError"):
            return {"error": result["content"][0]["text"]}
        return result["structuredContent"]


class ToggleTests(_Base):
    def test_off_until_an_admin_turns_it_on(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_access_enabled=False)
        body = self.call(rpc("initialize"), expect=404)
        self.assertEqual(body["detail"], "Integration not enabled.")
        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_access_enabled=True)
        self.assertEqual(self.call(rpc("initialize"))["result"]["serverInfo"]["name"], "danbyte")

    def test_a_tenant_with_no_settings_row_is_off(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).delete()
        self.call(rpc("initialize"), expect=404)

    def test_toggle_reaches_the_integrations_endpoints(self):
        self.client.force_login(self.user)
        enabled = self.client.get("/api/integrations/enabled/").json()
        self.assertTrue(enabled["ai"])
        self.assertFalse(enabled["ai_writes"])


class AuthTests(_Base):
    def test_a_session_cookie_is_not_enough(self):
        self.client.force_login(self.user)
        response = self.client.post("/api/mcp/", json.dumps(rpc("initialize")),
                                    content_type="application/json")
        self.assertEqual(response.status_code, 401)

    def test_a_bad_token_is_refused(self):
        response = self.client.post(
            "/api/mcp/", json.dumps(rpc("initialize")), content_type="application/json",
            HTTP_AUTHORIZATION="Token dbt_nope",
        )
        self.assertEqual(response.status_code, 401)

    def test_get_and_delete_answer_plainly(self):
        for method in (self.client.get, self.client.delete):
            response = method("/api/mcp/", HTTP_AUTHORIZATION=f"Token {self.key}")
            self.assertEqual(response.status_code, 405)
            self.assertIn("POST", response["Allow"])

    def test_any_accept_header_works(self):
        """A Streamable HTTP client offers text/event-stream; some offer only
        that. Negotiating would turn a workable request into a 406."""
        for accept in ("application/json, text/event-stream", "text/event-stream",
                       "*/*", "application/json"):
            response = self.client.post(
                "/api/mcp/", json.dumps(rpc("ping")), content_type="application/json",
                HTTP_AUTHORIZATION=f"Token {self.key}", HTTP_ACCEPT=accept,
            )
            self.assertEqual(response.status_code, 200, accept)
            self.assertEqual(response["Content-Type"], "application/json")


class HandshakeTests(_Base):
    def test_initialize_advertises_only_what_we_serve(self):
        result = self.call(rpc("initialize", {"clientInfo": {"name": "claude-code"}}))["result"]
        self.assertEqual(result["protocolVersion"], "2025-06-18")
        self.assertIn("tools", result["capabilities"])
        self.assertIn("source of truth", result["instructions"])

    def test_ping_and_notifications(self):
        self.assertEqual(self.call(rpc("ping"))["result"], {})
        response = self.client.post(
            "/api/mcp/", json.dumps(rpc("notifications/initialized", id_=None)),
            content_type="application/json", HTTP_AUTHORIZATION=f"Token {self.key}",
        )
        self.assertEqual(response.status_code, 202)

    def test_unknown_method_is_a_json_rpc_error(self):
        answer = self.call(rpc("tools/frobnicate"))
        self.assertEqual(answer["error"]["code"], -32601)

    def test_tool_list_hides_writes_until_enabled(self):
        names = {t["name"] for t in self.call(rpc("tools/list"))["result"]["tools"]}
        self.assertIn("search", names)
        self.assertNotIn("create", names)
        self.assertNotIn("delete", names)

        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_writes_enabled=True)
        names = {t["name"] for t in self.call(rpc("tools/list"))["result"]["tools"]}
        self.assertIn("create", names)
        self.assertIn("update", names)
        self.assertIn("delete", names)

    def test_a_read_only_token_never_sees_a_write_tool(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_writes_enabled=True)
        key = "dbt_" + "r" * 48
        ApiToken.objects.create(
            user=self.user, tenant=self.tenant, name="read", key_hash=hash_api_key(key),
            prefix=key[:11], scope="read",
        )
        # A read-scope token cannot even POST: the auth layer refuses first.
        response = self.client.post(
            "/api/mcp/", json.dumps(rpc("tools/list")), content_type="application/json",
            HTTP_AUTHORIZATION=f"Token {key}",
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn("read-only", response.json()["detail"])

    def test_batch_requests(self):
        answers = self.call([rpc("ping", id_=1), rpc("ping", id_=2),
                             rpc("notifications/initialized", id_=None)])
        self.assertEqual([a["id"] for a in answers], [1, 2])


class ReadToolTests(_Base):
    def test_types_lists_only_what_the_token_can_read(self):
        payload = self.tool("types")
        slugs = {t["type"] for t in payload["types"]}
        self.assertIn("device", slugs)
        self.assertFalse(payload["writes_enabled"])
        counts = {t["type"]: t["count"] for t in payload["types"]}
        self.assertEqual(counts["device"], 2)

    def test_list_get_and_name_lookup(self):
        rows = self.tool("list", {"type": "devices"})
        self.assertEqual(rows["type"], "device")
        self.assertEqual({r["name"] for r in rows["rows"]},
                         {"aarhus-core-1", "hq-core-1"})
        self.assertFalse(rows["truncated"])

        one = self.tool("get", {"type": "device", "id": "aarhus-core-1"})
        self.assertEqual(one["object"]["name"], "aarhus-core-1")
        by_id = self.tool("get", {"type": "device", "id": str(self.device.id)})
        self.assertEqual(by_id["object"]["id"], str(self.device.id))

    def test_list_accepts_filters_sent_as_json_text(self):
        payload = self.tool("list", {"type": "device", "filters": '{"site": "Aarhus"}'})
        self.assertEqual([r["name"] for r in payload["rows"]], ["aarhus-core-1"])

    def test_row_cap_is_honest_about_more(self):
        AgentSettings.objects.update_or_create(tenant=self.tenant, defaults={"max_rows": 1})
        rows = self.tool("list", {"type": "device"})
        self.assertEqual(rows["returned"], 1)
        self.assertTrue(rows["truncated"])
        self.assertEqual(rows["next_cursor"], 1)

    def test_allowed_types_narrows_everything(self):
        AgentSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"allowed_types": ["site"]}
        )
        self.assertEqual({t["type"] for t in self.tool("types")["types"]}, {"site"})
        refused = self.tool("list", {"type": "device"})
        self.assertIn("limited to", refused["error"])

    def test_explain_describes_fields_and_actions(self):
        payload = self.tool("explain", {"type": "device"})
        self.assertEqual(payload["type"], "device")
        self.assertEqual(payload["endpoint"], "/api/devices/")
        self.assertIn("change", payload["you_may"])
        self.assertTrue(payload["fields"])

    def test_explain_carries_a_fields_help_text(self):
        # Cable ends are a list of dicts; without the serializer's help text
        # an assistant has nothing to tell it what goes in one.
        payload = self.tool("explain", {"type": "cable"})
        ends = [f for f in payload["fields"] if f["name"] in ("a", "b")]
        self.assertEqual(len(ends), 2)
        for field in ends:
            self.assertIn("kind", field["help"])
            self.assertIn("interface", field["help"])

    def test_script_resolves_to_scripts_not_their_runs(self):
        # ScriptRunViewSet carries rbac_object_type "script" so it shares the
        # permission; that label must not claim the slug.
        payload = self.tool("explain", {"type": "script"})
        self.assertEqual(payload["endpoint"], "/api/scripts/")
        self.assertIn("source", payload["writable_fields"])
        self.assertEqual(
            self.tool("explain", {"type": "scriptrun"})["endpoint"],
            "/api/scripts/runs/",
        )

    def test_script_guide_describes_the_sdk_and_the_row(self):
        payload = self.tool("script_guide")
        calls = [entry["call"] for entry in payload["sdk"]["db"]]
        self.assertTrue(any(call.startswith("list(") for call in calls))
        self.assertTrue(
            any(e["call"].startswith("output_csv(") for e in payload["sdk"]["run"])
        )
        self.assertIn("string", payload["params_schema"]["types"])
        self.assertEqual(payload["create_with"]["type"], "script")
        self.assertIn("danbyte_sdk", payload["example"])

    def test_script_guide_says_whether_it_may_save_one(self):
        # Writes are off by default, so it should offer the code to paste
        # rather than claim it can save the script.
        self.assertIn("paste", self.tool("script_guide")["you_may"])
        IntegrationSettings.objects.filter(tenant=self.tenant).update(
            ai_writes_enabled=True
        )
        self.assertIn("create", self.tool("script_guide")["you_may"])

    def test_unknown_type_says_what_to_do(self):
        payload = self.tool("get", {"type": "widget", "id": "x"})
        self.assertIn("Unknown object type", payload["error"])
        self.assertIn("`types`", payload["error"])

    def test_where_is_and_changes(self):
        where = self.tool("where_is", {"type": "device", "id": "aarhus-core-1"})
        self.assertEqual(where["where"]["name"], "aarhus-core-1")
        self.assertIn("Aarhus", json.dumps(where["where"]))

        self.device.name = "aarhus-core-01"
        self.device.save()
        changes = self.tool("changes", {"type": "device", "id": str(self.device.id),
                                        "since": "24h"})
        self.assertIsInstance(changes["entries"], list)

    def test_search_uses_the_products_own_ranking(self):
        from api.search_index import rebuild

        rebuild()
        hits = self.tool("search", {"q": "aarhus-core", "type": "device"})
        self.assertGreaterEqual(hits["total"], 1)
        self.assertEqual(hits["hits"][0]["type"], "device")


class ScopingTests(_Base):
    def test_a_site_scoped_token_never_sees_the_other_site(self):
        ObjectPermission.objects.all().delete()
        self.grant(["view"], ["*"], sites=[self.site])
        rows = self.tool("list", {"type": "device"})
        self.assertEqual([r["name"] for r in rows["rows"]], ["aarhus-core-1"])
        # and the hidden row reads as missing, never as forbidden
        payload = self.tool("get", {"type": "device", "id": str(self.elsewhere.id)})
        self.assertIn("error", payload)
        self.assertNotIn("permission", payload["error"].lower())
        self.assertNotIn("forbidden", payload["error"].lower())

    def test_no_grant_at_all_is_refused_not_silently_empty(self):
        ObjectPermission.objects.all().delete()
        payload = self.tool("list", {"type": "device"})
        self.assertIn("error", payload)


class SecretTests(_Base):
    def test_credentials_never_come_back(self):
        from monitoring.models import SnmpProfile

        profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="ro", slug="ro", version="v2c",
            secret_params={"community": "public-secret"},
        )
        self.grant(["view"], ["*"])
        payload = self.tool("get", {"type": "snmpprofile", "id": str(profile.id)})
        self.assertNotIn("error", payload, payload)
        body = json.dumps(payload)
        self.assertNotIn("public-secret", body)
        self.assertNotIn("secret_params", payload["object"])

    def test_the_blocklist_strips_by_name_too(self):
        from agents.dispatch import clean

        cleaned = clean({"name": "x", "password": "hunter2", "nested": {"token": "t"},
                         "permissions": {"change": True}})
        self.assertEqual(cleaned, {"name": "x", "nested": {}})


class WriteTests(_Base):
    def setUp(self):
        super().setUp()
        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_writes_enabled=True)

    def test_create_update_delete_round_trip_and_are_audited(self):
        from audit.models import ChangeLogEntry

        made = self.tool("create", {"type": "site", "payload": {"name": "Odense"}})
        self.assertTrue(made["created"])
        site_id = made["object"]["id"]

        changed = self.tool("update", {"type": "site", "id": site_id,
                                       "payload": {"description": "second site"}})
        self.assertEqual(changed["object"]["description"], "second site")

        refused = self.tool("delete", {"type": "site", "id": site_id, "confirm": "wrong"})
        self.assertIn("confirm='Odense'", refused["error"])
        gone = self.tool("delete", {"type": "site", "id": site_id, "confirm": "Odense"})
        self.assertTrue(gone["deleted"])
        self.assertFalse(Site.objects.filter(pk=site_id).exists())

        entries = ChangeLogEntry.objects.filter(object_id=str(site_id))
        self.assertEqual({e.action for e in entries}, {"create", "update", "delete"})
        self.assertEqual({e.user_name for e in entries}, {"agent"})

    def test_connect_cables_two_ports_by_name(self):
        from api.models import Cable, Interface

        other = Device.objects.create(
            tenant=self.tenant, name="aarhus-fw-1", site=self.site,
            device_type=self.dtype, role=self.role,
        )
        Interface.objects.create(device=self.device, name="Gi1/0/3")
        Interface.objects.create(device=other, name="ethernet1/3")
        payload = self.tool("connect", {
            "a_device": "aarhus-core-1", "a_port": "Gi1/0/3",
            "b_device": "aarhus-fw-1", "b_port": "ethernet1/3",
        })
        self.assertTrue(payload["created"])
        self.assertIn("Gi1/0/3", payload["connected"])
        cable = Cable.objects.get(pk=payload["object"]["id"])
        self.assertEqual(
            {t.end for t in cable.terminations.all()}, {"A", "B"}
        )

    def test_connect_names_the_ports_a_device_has(self):
        from api.models import Interface

        Interface.objects.create(device=self.device, name="Gi1/0/1")
        payload = self.tool("connect", {
            "a_device": "aarhus-core-1", "a_port": "nope",
            "b_device": "hq-core-1", "b_port": "also-nope",
        })
        self.assertIn("has no interface 'nope'", payload["error"])
        self.assertIn("Gi1/0/1", payload["error"])

    def test_terminate_lands_a_circuit_end_by_name(self):
        from api.models import Circuit, CircuitType, Provider

        provider = Provider.objects.create(tenant=self.tenant, name="P", slug="p")
        ctype = CircuitType.objects.create(tenant=self.tenant, name="Ethernet", slug="eth")
        circuit = Circuit.objects.create(
            tenant=self.tenant, cid="NX-1", provider=provider, type=ctype
        )
        payload = self.tool("terminate", {
            "circuit": "NX-1", "side": "Z", "site": "Aarhus",
        })
        self.assertEqual(payload["object"]["term_side"], "Z")
        self.assertEqual(circuit.terminations.count(), 1)

    def test_connect_names_a_circuit_end_by_its_side(self):
        from api.models import Circuit, CircuitTermination, CircuitType, Interface, Provider

        provider = Provider.objects.create(tenant=self.tenant, name="P2", slug="p2")
        ctype = CircuitType.objects.create(tenant=self.tenant, name="Wave", slug="wave")
        circuit = Circuit.objects.create(
            tenant=self.tenant, cid="NX-2", provider=provider, type=ctype
        )
        CircuitTermination.objects.create(
            circuit=circuit, term_side="A", site=self.site
        )
        Interface.objects.create(device=self.device, name="Gi1/0/9")

        # A circuit end has no port name, so a port name is a dead end - and
        # saying so beats "more than one matches".
        wrong = self.tool("connect", {
            "a_device": "aarhus-core-1", "a_port": "Gi1/0/9",
            "b_device": "NX-2", "b_port": "ethernet1/4",
            "b_kind": "circuit_termination",
        })
        self.assertIn('"A" or "Z"', wrong["error"])

        payload = self.tool("connect", {
            "a_device": "aarhus-core-1", "a_port": "Gi1/0/9",
            "b_device": "NX-2", "b_port": "A", "b_kind": "circuit_termination",
        })
        self.assertTrue(payload["created"])
        self.assertIn("NX-2 A side", payload["connected"])

    def test_connect_says_when_a_circuit_side_is_missing(self):
        from api.models import Circuit, CircuitType, Interface, Provider

        provider = Provider.objects.create(tenant=self.tenant, name="P3", slug="p3")
        ctype = CircuitType.objects.create(tenant=self.tenant, name="Eth", slug="eth2")
        Circuit.objects.create(
            tenant=self.tenant, cid="NX-3", provider=provider, type=ctype
        )
        Interface.objects.create(device=self.device, name="Gi1/0/8")
        payload = self.tool("connect", {
            "a_device": "aarhus-core-1", "a_port": "Gi1/0/8",
            "b_device": "NX-3", "b_port": "Z", "b_kind": "circuit_termination",
        })
        self.assertIn("no Z side", payload["error"])
        self.assertIn("terminate(", payload["error"])

    def test_terminate_needs_a_side_and_somewhere_to_land(self):
        self.assertIn('"A" or "Z"', self.tool("terminate", {
            "circuit": "NX-1", "side": "left", "site": "Aarhus",
        })["error"])

    def test_writes_refused_when_the_switch_is_off(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_writes_enabled=False)
        answer = self.call(rpc("tools/call", {"name": "create", "arguments": {
            "type": "site", "payload": {"name": "Nope", "slug": "nope"}}}))
        self.assertTrue(answer["result"]["isError"])
        self.assertIn("read only", answer["result"]["content"][0]["text"])
        self.assertFalse(Site.objects.filter(name="Nope").exists())

    def test_a_write_without_the_grant_is_refused(self):
        ObjectPermission.objects.all().delete()
        self.grant(["view"], ["*"])
        payload = self.tool("create", {"type": "site", "payload": {"name": "X"}})
        self.assertIn("error", payload)
        self.assertFalse(Site.objects.filter(name="X").exists())


class CallLogTests(_Base):
    def test_every_call_is_recorded(self):
        self.tool("list", {"type": "device"})
        call = AgentCall.objects.get()
        self.assertEqual(call.tool, "list")
        self.assertEqual(call.object_type, "device")
        self.assertEqual(call.rows, 2)
        self.assertEqual(call.token, self.token)
        self.assertEqual(call.tenant, self.tenant)
        self.assertFalse(call.wrote)
        self.assertEqual(call.error, "")

    def test_a_refusal_is_recorded_with_its_reason(self):
        self.tool("get", {"type": "device", "id": "no-such-device"})
        call = AgentCall.objects.get()
        self.assertIn("no-such-device", call.error)
        self.assertEqual(call.rows, 0)

    def test_a_refused_write_attempt_is_recorded(self):
        payload = self.tool("create", {"type": "site", "payload": {"name": "X"}})
        self.assertIn("read only", payload["error"])
        call = AgentCall.objects.get(tool="create")
        self.assertIn("read only", call.error)
        self.assertFalse(call.wrote)

    def test_credential_arguments_are_masked_in_the_log(self):
        self.tool("get", {"type": "device", "id": "aarhus-core-1", "password": "hunter2"})
        call = AgentCall.objects.get(tool="get")
        self.assertNotIn("hunter2", json.dumps(call.arguments))
        self.assertEqual(call.arguments["password"], "•••")

    def test_the_log_endpoint_needs_a_tenant_admin(self):
        self.tool("list", {"type": "device"})
        # A wildcard grant includes `user: change`, which *is* tenant admin;
        # narrow this account first so the gate is actually exercised.
        ObjectPermission.objects.all().delete()
        self.grant(["view"], ["device"])
        self.client.force_login(self.user)
        self.assertEqual(self.client.get("/api/agent/calls/").status_code, 403)
        admin = get_user_model().objects.create_superuser("root", "r@e.com", "x")
        self.client.force_login(admin)
        body = self.client.get("/api/agent/calls/").json()
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["results"][0]["tool"], "list")


class SettingsApiTests(_Base):
    def test_settings_read_and_admin_only_write(self):
        ObjectPermission.objects.all().delete()
        self.grant(["view"], ["device"])
        self.client.force_login(self.user)
        body = self.client.get("/api/agent/settings/").json()
        self.assertTrue(body["enabled"])
        self.assertFalse(body["writes_enabled"])
        self.assertIn("device", body["known_types"])
        self.assertEqual(
            self.client.put("/api/agent/settings/", {"max_rows": 10},
                            content_type="application/json").status_code, 403)

        admin = get_user_model().objects.create_superuser("root", "r@e.com", "x")
        self.client.force_login(admin)
        r = self.client.put("/api/agent/settings/",
                            {"max_rows": 10, "allowed_types": ["device"]},
                            content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["max_rows"], 10)

        r = self.client.put("/api/agent/settings/", {"allowed_types": ["nope"]},
                            content_type="application/json")
        self.assertEqual(r.status_code, 400)
        r = self.client.put("/api/agent/settings/", {"max_rows": 99999},
                            content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_connect_snippets_name_this_deployment(self):
        self.client.force_login(self.user)
        body = self.client.get("/api/agent/connect/").json()
        self.assertTrue(body["url"].endswith("/api/mcp/"))
        ids = {c["id"] for c in body["clients"]}
        self.assertEqual(ids, {"claude-code", "claude-desktop", "cursor", "vscode"})
        for client in body["clients"]:
            # Either a literal placeholder or the editor's own secret prompt.
            self.assertTrue(
                "<your-token>" in client["snippet"] or "input:" in client["snippet"],
                client["id"],
            )
