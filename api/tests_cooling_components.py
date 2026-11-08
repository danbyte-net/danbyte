"""Cooling intakes and outflows (#434): device components and their
device-type templates, the cooling path, the feed's connected load and flow,
and the unconnected-liquid filter."""
from __future__ import annotations

import json

from django.core.serializers.json import DjangoJSONEncoder

from api.cooling_trace import MAX_DEPTH, device_path
from api.device_library import export_bundle, import_bundle
from api.models import (
    CoolingIntake,
    CoolingIntakeTemplate,
    CoolingOutflow,
    CoolingOutflowTemplate,
    Device,
    DeviceType,
    diff_device_components,
    materialize_device_components,
    sync_device_components,
)
from core.models import Organization, Tenant

from .tests_cooling import FEEDS, SOURCES, _Base

INTAKES = "/api/cooling-intakes/"
OUTFLOWS = "/api/cooling-outflows/"


class _CoolBase(_Base):
    def setUp(self):
        super().setUp()
        self.cdu_type = DeviceType.objects.create(tenant=self.tenant, name="CDU-100")
        self.cdu = Device.objects.create(
            tenant=self.tenant, name="cdu1", site=self.site, rack=self.rack,
            device_type=self.cdu_type)

    def intake(self, device, name="in", **kw):
        return CoolingIntake.objects.create(device=device, name=name, **kw)

    def outflow(self, device, name="out", **kw):
        return CoolingOutflow.objects.create(device=device, name=name, **kw)


class TemplateTests(_CoolBase):
    def _templates(self):
        it = CoolingIntakeTemplate.objects.create(
            device_type=self.cdu_type, name="Primary in", connector="qd-1",
            diameter_mm=25, max_flow_lpm="120.0")
        CoolingOutflowTemplate.objects.create(
            device_type=self.cdu_type, name="Sec {position}", connector="qd-1/2",
            intake_template=it)
        return it

    def test_templates_stamp_intakes_before_outflows(self):
        self._templates()
        d = Device.objects.create(
            tenant=self.tenant, name="cdu2", site=self.site, device_type=self.cdu_type)
        created = materialize_device_components(d)
        self.assertEqual(created["cooling_intakes"], 1)
        self.assertEqual(created["cooling_outflows"], 1)
        out = d.cooling_outflows.get()
        self.assertEqual(out.name, "Sec 1")
        self.assertEqual(out.intake.name, "Primary in")
        self.assertEqual(d.cooling_intakes.get().connector, "qd-1")

    def test_device_create_through_api_stamps_them(self):
        self._templates()
        r = self.client.post("/api/devices/", {
            "name": "cdu3", "site_id": str(self.site.id),
            "device_type_id": str(self.cdu_type.id), "status_id": str(self.status.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        d = Device.objects.get(name="cdu3")
        self.assertEqual(d.cooling_outflows.get().intake, d.cooling_intakes.get())
        detail = self.client.get(f"/api/devices/{d.id}/").json()
        self.assertEqual(detail["cooling_count"], 2)

    def test_rename_follows_into_new_devices(self):
        it = self._templates()
        r = self.client.patch(f"/api/cooling-intake-templates/{it.id}/",
                              {"name": "Loop in"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        d = Device.objects.create(
            tenant=self.tenant, name="cdu4", site=self.site, device_type=self.cdu_type)
        materialize_device_components(d)
        self.assertEqual(d.cooling_outflows.get().intake.name, "Loop in")

    def test_sync_diff_adds_and_removes(self):
        self._templates()
        self.intake(self.cdu, "stray")
        diff = diff_device_components(self.cdu)
        self.assertEqual(diff["cooling_intakes"], {"add": ["Primary in"], "extra": ["stray"]})
        self.assertEqual(diff["cooling_outflows"], {"add": ["Sec 1"], "extra": []})
        result = sync_device_components(self.cdu, remove_extra=True)
        self.assertEqual(result["removed"], {"cooling_intakes": 1})
        self.assertEqual(diff_device_components(self.cdu), {})

    def test_outflow_template_takes_an_intake_of_its_own_type(self):
        other = DeviceType.objects.create(tenant=self.tenant, name="other")
        foreign = CoolingIntakeTemplate.objects.create(device_type=other, name="x")
        r = self.client.post("/api/cooling-outflow-templates/", {
            "device_type_id": str(self.cdu_type.id), "name": "o",
            "intake_template_id": str(foreign.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("intake_template_id", r.json())

    def test_type_counts(self):
        self._templates()
        body = self.client.get(f"/api/device-types/{self.cdu_type.id}/").json()
        self.assertEqual(body["component_counts"]["cooling-intake"], 1)
        self.assertEqual(body["component_counts"]["cooling-outflow"], 1)

    def test_bundle_round_trip(self):
        self._templates()
        bundle = json.loads(json.dumps(export_bundle(self.cdu_type), cls=DjangoJSONEncoder))
        comps = bundle["components"]
        self.assertEqual(comps["cooling_intakes"][0]["max_flow_lpm"], "120.0")
        self.assertEqual(comps["cooling_outflows"][0]["intake"], "Primary in")
        org = Organization.objects.create(name="B", slug="b")
        far = Tenant.objects.create(org=org, name="B", slug="b")
        report = import_bundle(bundle, far)
        self.assertEqual(report["components"]["cooling_outflows"], 1)
        dt = DeviceType.objects.get(tenant=far, name="CDU-100")
        out = dt.cooling_outflow_templates.get()
        self.assertEqual(out.intake_template.name, "Primary in")
        self.assertEqual(str(dt.cooling_intake_templates.get().max_flow_lpm), "120.0")


class ComponentRuleTests(_CoolBase):
    def test_create_with_feed_and_read_back(self):
        f = self.feed("A", rack=self.rack)
        r = self.client.post(INTAKES, {
            "device_id": str(self.srv.id), "name": "in", "connector": "qd-3/8",
            "diameter_mm": 10, "max_flow_lpm": "8.5", "cooling_feed_id": str(f.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["cooling_feed"]["source"]["name"], "CRAH-1")
        self.assertEqual(body["connector_display"], 'QD 3/8"')
        rows = self.client.get(INTAKES, {"cooling_feed": str(f.id)}).json()["results"]
        self.assertEqual([x["name"] for x in rows], ["in"])
        pick = self.client.get(INTAKES, {"picker": "1"}).json()["results"]
        self.assertEqual(set(pick[0]), {"id", "name", "device"})

    def test_bad_connector_is_refused(self):
        r = self.client.post(INTAKES, {"device_id": str(self.srv.id), "name": "in",
                                       "connector": "garden-hose"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_intake_takes_a_feed_or_an_outflow_not_both(self):
        f = self.feed("A", rack=self.rack)
        out = self.outflow(self.cdu)
        r = self.client.post(INTAKES, {
            "device_id": str(self.srv.id), "name": "in",
            "cooling_feed_id": str(f.id), "outflow_id": str(out.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        intake = self.intake(self.srv, cooling_feed=f)
        r = self.client.patch(f"{INTAKES}{intake.id}/", {"outflow_id": str(out.id)},
                              format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("outflow_id", r.json())
        r = self.client.patch(f"{INTAKES}{intake.id}/",
                              {"outflow_id": str(out.id), "cooling_feed_id": None},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def test_intake_outflow_on_its_own_device_is_refused(self):
        out = self.outflow(self.srv)
        r = self.client.post(INTAKES, {"device_id": str(self.srv.id), "name": "in",
                                       "outflow_id": str(out.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("outflow_id", r.json())

    def test_outflow_intake_must_be_on_the_same_device(self):
        foreign = self.intake(self.srv)
        r = self.client.post(OUTFLOWS, {"device_id": str(self.cdu.id), "name": "o",
                                        "intake_id": str(foreign.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("intake_id", r.json())
        own = self.intake(self.cdu)
        r = self.client.post(OUTFLOWS, {"device_id": str(self.cdu.id), "name": "o",
                                        "intake_id": str(own.id)}, format="json")
        self.assertEqual(r.status_code, 201, r.content)

    def test_bulk_edit_and_delete(self):
        a, b = self.intake(self.srv, "a"), self.intake(self.srv, "b")
        r = self.client.post(f"{INTAKES}bulk-update/", {
            "ids": [str(a.id), str(b.id)], "fields": {"connector": "barb"},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(set(CoolingIntake.objects.values_list("connector", flat=True)),
                         {"barb"})
        r = self.client.post(f"{INTAKES}bulk-delete/", {"ids": [str(a.id)]}, format="json")
        self.assertEqual(r.json()["deleted"], 1)

    def test_other_tenants_rows_are_out_of_reach(self):
        org = Organization.objects.create(name="B", slug="b")
        far = Tenant.objects.create(org=org, name="B", slug="b")
        far_dev = Device.objects.create(tenant=far, name="x", site=self.site)
        far_out = self.outflow(far_dev)
        far_in = self.intake(far_dev)
        r = self.client.post(INTAKES, {"device_id": str(self.srv.id), "name": "in",
                                       "outflow_id": str(far_out.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(INTAKES, {"device_id": str(far_dev.id), "name": "in2"},
                             format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.get(f"{INTAKES}{far_in.id}/").status_code, 404)
        self.assertEqual(self.client.get(f"/api/devices/{far_dev.id}/cooling-path/")
                         .status_code, 404)


class PathTests(_CoolBase):
    def test_trace_through_a_cdu(self):
        f = self.feed("Primary", rack=self.rack)
        cdu_in = self.intake(self.cdu, "pri", cooling_feed=f)
        sec = self.outflow(self.cdu, "sec1", intake=cdu_in)
        self.intake(self.srv, "in", outflow=sec)
        body = self.client.get(f"/api/devices/{self.srv.id}/cooling-path/").json()
        (path,) = body["paths"]
        self.assertEqual(path["status"], "fed")
        self.assertEqual(
            [(h["kind"], h["name"]) for h in path["hops"]],
            [("source", "CRAH-1"), ("feed", "Primary"), ("device", "cdu1"), ("device", "srv1")],
        )
        self.assertEqual(path["hops"][2]["intake"]["name"], "pri")
        self.assertEqual(path["hops"][2]["outflow"]["name"], "sec1")
        self.assertEqual(path["hops"][3]["intake"]["name"], "in")

    def test_unconnected_and_open(self):
        self.intake(self.srv, "a")
        sec = self.outflow(self.cdu, "sec")  # names no intake
        self.intake(self.srv, "b", outflow=sec)
        paths = self.client.get(f"/api/devices/{self.srv.id}/cooling-path/").json()["paths"]
        self.assertEqual([(p["intake"]["name"], p["status"], len(p["hops"])) for p in paths],
                         [("a", "open", 1), ("b", "open", 2)])

    def test_loop_guard(self):
        a = Device.objects.create(tenant=self.tenant, name="a", site=self.site)
        b = Device.objects.create(tenant=self.tenant, name="b", site=self.site)
        a_in, b_in = self.intake(a), self.intake(b)
        a_out = self.outflow(a, intake=a_in)
        b_out = self.outflow(b, intake=b_in)
        a_in.outflow = b_out
        a_in.save()
        b_in.outflow = a_out
        b_in.save()
        (path,) = device_path(a, self.admin, self.tenant)["paths"]
        self.assertEqual(path["status"], "loop")
        self.assertEqual([h["name"] for h in path["hops"]], ["b", "a"])

    def test_depth_cap(self):
        f = self.feed("A")
        prev = None
        chain = []
        for n in range(MAX_DEPTH + 3):
            d = Device.objects.create(tenant=self.tenant, name=f"d{n}", site=self.site)
            i = self.intake(d, cooling_feed=f if prev is None else None, outflow=prev)
            prev = self.outflow(d, intake=i)
            chain.append(d)
        (path,) = device_path(chain[-1], self.admin, self.tenant)["paths"]
        self.assertEqual(path["status"], "truncated")
        self.assertEqual(len(path["hops"]), MAX_DEPTH)
        (path,) = device_path(chain[MAX_DEPTH - 1], self.admin, self.tenant)["paths"]
        self.assertEqual(path["status"], "fed")
        self.assertEqual(len(path["hops"]), MAX_DEPTH + 2)

    def test_path_endpoint_needs_view_and_hides_the_rest(self):
        f = self.feed("Primary", rack=self.rack)
        cdu_in = self.intake(self.cdu, "pri", cooling_feed=f)
        sec = self.outflow(self.cdu, "sec1", intake=cdu_in)
        self.intake(self.srv, "in", outflow=sec)
        self.member((["rack"], ["view"], []))
        r = self.client.get(f"/api/devices/{self.srv.id}/cooling-path/")
        self.assertIn(r.status_code, (403, 404))
        self.member((["device"], ["view"], [self.site]))
        hops = self.client.get(f"/api/devices/{self.srv.id}/cooling-path/").json()["paths"][0]["hops"]
        self.assertEqual(hops[0], {"kind": "source", "hidden": True})
        self.assertEqual(hops[1], {"kind": "feed", "hidden": True})
        self.assertEqual(hops[2]["name"], "cdu1")


class LoadAndFlowTests(_CoolBase):
    def test_feed_load_is_its_connected_devices_heat(self):
        f = self.feed("A", rack=self.rack, rated_capacity_w=10000, flow_rate_lpm="50.0")
        body = self.client.get(f"{FEEDS}{f.id}/").json()
        self.assertEqual(body["capacity"]["basis"], "rack")
        self.assertEqual(body["capacity"]["heat_allocated_w"], 3000)
        self.assertEqual(body["flow"], {"connected_lpm": None, "rated_lpm": 50.0, "intakes": 0})
        # srv2 sits in R2 but its CDU-borne intake lands on this feed.
        cdu_in = self.intake(self.cdu, cooling_feed=f, max_flow_lpm="30.0")
        sec = self.outflow(self.cdu, intake=cdu_in)
        self.intake(self.srv2, outflow=sec, max_flow_lpm="12.5")
        body = self.client.get(f"{FEEDS}{f.id}/").json()
        self.assertEqual(body["capacity"]["basis"], "intakes")
        self.assertEqual(body["capacity"]["devices"], 2)
        self.assertEqual(body["capacity"]["heat_allocated_w"], 3000)  # the CDU gives off none
        self.assertEqual(body["flow"], {"connected_lpm": 30.0, "rated_lpm": 50.0, "intakes": 1})
        listed = self.client.get(FEEDS).json()["results"][0]
        self.assertEqual(listed["capacity"]["basis"], "intakes")
        self.assertEqual(self.client.get(FEEDS, {"picker": "1"}).json()["results"][0]["source"]
                         ["name"], "CRAH-1")

    def test_affected_follows_the_hoses_and_carries_the_path(self):
        f = self.feed("A", rack=self.rack)
        cdu_in = self.intake(self.cdu, cooling_feed=f)
        sec = self.outflow(self.cdu, intake=cdu_in)
        self.intake(self.srv2, outflow=sec)  # srv2 stands in R2, no feed of its own
        body = self.client.get(f"{SOURCES}{self.crah.id}/affected/").json()
        devices = {d["name"]: d for d in body["devices"]}
        self.assertEqual(set(devices), {"cdu1", "srv1", "srv2"})
        self.assertEqual(devices["srv2"]["level"], "outage")
        self.assertEqual([h["name"] for h in devices["srv2"]["path"]["hops"]],
                         ["CRAH-1", "A", "cdu1", "srv2"])
        self.assertIsNone(devices["srv1"]["path"])
        # A second feed reaching the CDU leaves it reduced.
        other = self.feed("B", rack=self.rack2, source=self._other_source())
        self.intake(self.cdu, "spare", cooling_feed=other)
        body = self.client.get(f"{FEEDS}{f.id}/affected/").json()
        devices = {d["name"]: d for d in body["devices"]}
        self.assertEqual(devices["cdu1"]["level"], "reduced_redundancy")
        power = self.client.get(f"/api/power-panels/{self._panel().id}/affected/").json()
        self.assertTrue(all("path" not in d for d in power["devices"]))

    def _other_source(self):
        from api.models import CoolingSource

        return CoolingSource.objects.create(tenant=self.tenant, site=self.site, name="CRAH-2")

    def _panel(self):
        from api.models import PowerFeed, PowerPanel

        panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site, name="MDB")
        PowerFeed.objects.create(tenant=self.tenant, power_panel=panel, name="P", rack=self.rack)
        return panel

    def test_unconnected_filter(self):
        liquid = DeviceType.objects.create(tenant=self.tenant, name="liq", cooling_method="liquid")
        a = Device.objects.create(tenant=self.tenant, name="liq-a", site=self.site,
                                  rack=self.rack, device_type=liquid)
        b = Device.objects.create(tenant=self.tenant, name="liq-b", site=self.site,
                                  rack=self.rack, device_type=liquid)
        self.intake(a)  # an intake connected to nothing still counts as unconnected
        self.intake(b, cooling_feed=self.feed("A", rack=self.rack))
        rows = self.client.get("/api/devices/", {
            "rack": str(self.rack.id), "cooling_unconnected": "1"}).json()["results"]
        self.assertEqual([d["name"] for d in rows], ["liq-a"])
        r = self.client.get("/api/devices/", {"cooling_unconnected": "maybe"})
        self.assertEqual(r.status_code, 400)
