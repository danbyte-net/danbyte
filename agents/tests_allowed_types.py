"""The tenant's allowed types narrow every tool, search included (#327).

``list``, ``get`` and ``count`` refused a type outside the list while
``search`` returned hits of any type and took a disallowed ``type``.
"""
from __future__ import annotations

import json

from api.models import Circuit, CircuitType, Device, Provider
from api.search_index import rebuild
from integrations.models import IntegrationSettings

from .models import AgentSettings
from .tests_mcp import _Base


class _Narrowed(_Base):
    def setUp(self):
        super().setUp()
        provider = Provider.objects.create(tenant=self.tenant, name="Prov", slug="prov")
        ctype = CircuitType.objects.create(tenant=self.tenant, name="Ethernet", slug="eth")
        self.circuit = Circuit.objects.create(
            tenant=self.tenant, cid="ZZCIRC-4242", provider=provider, type=ctype
        )
        # A device whose name shares the circuit's prefix, so one query can
        # hit both types.
        Device.objects.create(
            tenant=self.tenant, name="ZZCIRC-sw1", site=self.site,
            device_type=self.dtype, role=self.role,
        )
        rebuild()

    def narrow(self, *types: str) -> None:
        AgentSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"allowed_types": list(types)}
        )


class SearchAllowedTypesTests(_Narrowed):
    def test_without_narrowing_search_finds_every_type(self):
        hits = self.tool("search", {"q": "ZZCIRC"})
        self.assertEqual({h["type"] for h in hits["hits"]}, {"circuit", "device"})
        self.assertEqual(hits["total"], 2)

    def test_hits_of_other_types_are_dropped_and_not_counted(self):
        self.narrow("device")
        hits = self.tool("search", {"q": "ZZCIRC"})
        self.assertEqual([h["type"] for h in hits["hits"]], ["device"])
        self.assertEqual(hits["total"], 1)
        self.assertNotIn("ZZCIRC-4242", json.dumps(hits))

    def test_an_exact_match_of_another_type_is_not_in_the_answer(self):
        self.narrow("device")
        found = self.tool("search", {"q": "ZZCIRC-4242"})
        # The near-named device may still rank; the circuit itself, its
        # provider and its id must not.
        self.assertTrue(all(h["type"] == "device" for h in found["hits"]))
        self.assertNotIn("ZZCIRC-4242", json.dumps(found["hits"]))
        self.assertNotIn("Prov", json.dumps(found["hits"]))
        self.assertEqual(found["total"], len(found["hits"]))

    def test_a_disallowed_type_argument_is_refused(self):
        self.narrow("device")
        refused = self.tool("search", {"q": "ZZCIRC", "type": "circuit"})
        self.assertIn("limited to: device", refused["error"])
        # Spelled the way `list` also accepts it.
        refused = self.tool("search", {"q": "ZZCIRC", "type": "Circuits"})
        self.assertIn("limited to: device", refused["error"])

    def test_a_disallowed_type_token_in_the_query_is_refused(self):
        self.narrow("device")
        refused = self.tool("search", {"q": "type:circuit ZZCIRC"})
        self.assertIn("limited to: device", refused["error"])

    def test_an_allowed_type_argument_still_works(self):
        self.narrow("device", "site")
        hits = self.tool("search", {"q": "ZZCIRC", "type": "device"})
        self.assertEqual([h["type"] for h in hits["hits"]], ["device"])
        self.assertEqual(hits["total"], 1)

    def test_an_allowed_type_token_in_the_query_still_works(self):
        self.narrow("device")
        hits = self.tool("search", {"q": "type:devices ZZCIRC"})
        self.assertEqual([h["type"] for h in hits["hits"]], ["device"])
        self.assertEqual(hits["total"], 1)

    def test_a_search_alias_is_judged_as_the_type_it_narrows_to(self):
        # `type:ip` narrows the search to IP addresses, so it is allowed
        # when they are and refused when they are not.
        self.narrow("device")
        self.assertIn("limited to: device",
                      self.tool("search", {"q": "type:ip 10.0"})["error"])
        self.narrow("ipaddress")
        self.assertNotIn("error", self.tool("search", {"q": "type:ip 10.0"}))

    def test_an_unknown_type_is_named_as_unknown(self):
        self.narrow("device")
        self.assertIn("Unknown object type",
                      self.tool("search", {"q": "x", "type": "nonsense"})["error"])

    def test_the_list_is_normalised_the_way_list_and_get_normalise_it(self):
        self.narrow("Devices")
        hits = self.tool("search", {"q": "ZZCIRC"})
        self.assertEqual([h["type"] for h in hits["hits"]], ["device"])
        self.assertEqual(self.tool("list", {"type": "device"})["type"], "device")

    def test_a_type_outside_the_index_cannot_open_the_search_up(self):
        # Nothing of this type is indexed, so the index cannot narrow to it;
        # the answer must still hold nothing of the other types.
        self.narrow("agentsettings")
        hits = self.tool("search", {"q": "ZZCIRC"})
        self.assertEqual(hits["hits"], [])
        self.assertEqual(hits["total"], 0)


class OtherToolsAllowedTypesTests(_Narrowed):
    def test_every_read_tool_with_a_type_refuses_one_outside_the_list(self):
        self.narrow("site")
        calls = [
            ("get", {"type": "device", "id": "aarhus-core-1"}),
            ("list", {"type": "device"}),
            ("count", {"type": "device"}),
            ("explain", {"type": "device"}),
            ("where_is", {"type": "device", "id": "aarhus-core-1"}),
            ("monitoring_status", {"type": "device", "id": "aarhus-core-1"}),
            ("changes", {"type": "device", "id": "aarhus-core-1"}),
        ]
        for name, arguments in calls:
            self.assertIn("limited to: site", self.tool(name, arguments)["error"], name)

    def test_lifecycle_reads_device_types_so_it_needs_them_allowed(self):
        self.narrow("site")
        self.assertIn("limited to: site", self.tool("lifecycle")["error"])
        self.narrow("devicetype")
        self.assertIn("types", self.tool("lifecycle"))

    def test_write_tools_refuse_a_type_outside_the_list(self):
        IntegrationSettings.objects.filter(tenant=self.tenant).update(ai_writes_enabled=True)
        self.narrow("site")
        calls = [
            ("create", {"type": "device", "payload": {"name": "x"}}),
            ("update", {"type": "device", "id": "aarhus-core-1", "payload": {"name": "x"}}),
            ("delete", {"type": "device", "id": "aarhus-core-1", "confirm": "aarhus-core-1"}),
            ("connect", {"a_device": "aarhus-core-1", "a_port": "Gi1",
                         "b_device": "hq-core-1", "b_port": "Gi1"}),
            ("terminate", {"circuit": "ZZCIRC-4242", "side": "A", "site": "Aarhus"}),
        ]
        for name, arguments in calls:
            self.assertIn("limited to: site", self.tool(name, arguments)["error"], name)
        self.assertEqual(Device.objects.filter(name="x").count(), 0)
