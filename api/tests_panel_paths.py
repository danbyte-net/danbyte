"""device_paths: viewing a patch panel draws the whole run *through* it
(server → panel-a → panel-b → client), not a fragment starting at the panel."""
from __future__ import annotations

from api.models import Device, FrontPort, Interface, RearPort
from api.tests_topology import _Base


class DevicePanelPathsTests(_Base):
    def setUp(self):
        super().setUp()
        self.server = Device.objects.create(tenant=self.tenant, name="server")
        self.client_dev = Device.objects.create(tenant=self.tenant, name="client")
        self.seth = Interface.objects.create(device=self.server, name="eth0")
        self.ceth = Interface.objects.create(device=self.client_dev, name="eth0")

        self.pa = Device.objects.create(tenant=self.tenant, name="panel-a")
        self.pb = Device.objects.create(tenant=self.tenant, name="panel-b")
        self.ra = RearPort.objects.create(device=self.pa, name="rear", positions=12)
        self.fa = FrontPort.objects.create(
            device=self.pa, name="front1", rear_port=self.ra, rear_port_position=1
        )
        self.rb = RearPort.objects.create(device=self.pb, name="rear", positions=12)
        self.fb = FrontPort.objects.create(
            device=self.pb, name="front1", rear_port=self.rb, rear_port_position=1
        )
        # server.eth0 — panel-a.front1 ; panel-a.rear — panel-b.rear (trunk) ;
        # panel-b.front1 — client.eth0
        self._cable(self.seth, self.fa)
        self._cable(self.ra, self.rb)
        self._cable(self.fb, self.ceth)

    def _runs(self, dev):
        return self.client.get(f"/api/devices/{dev.id}/paths/").json()["runs"]

    def test_panel_run_is_full_end_to_end(self):
        runs = self._runs(self.pa)
        # Front + rear origins collapse to one run through the panel.
        self.assertEqual(len(runs), 1, runs)
        steps = runs[0]["steps"]
        names = [s["device"] for s in steps if s["t"] == "chip"]
        # Spans both endpoints and both panels — not a fragment.
        for expected in ("server", "client", "panel-a", "panel-b"):
            self.assertIn(expected, names)
        # The viewed panel is the highlighted origin, mid-path (not an endpoint).
        origins = [s for s in steps if s["t"] == "chip" and s.get("origin")]
        self.assertEqual(len(origins), 1)
        self.assertEqual(origins[0]["device"], "panel-a")
        self.assertNotEqual(names[0], "panel-a")   # panel isn't the first chip
        self.assertNotEqual(names[-1], "panel-a")  # nor the last — it's in the middle
        self.assertTrue(runs[0]["complete"])
