"""The shared external-monitor layer, on its own.

No system involved: a made-up vocabulary for the state map, plain dicts for
the matching cascade, and plain objects for device-shaped policies. The Zabbix
suite covers the same code through a real system.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

from django.test import SimpleTestCase

from monitoring.external import beat, hooks
from monitoring.external.adoption import applicable, set_reason
from monitoring.external.matching import Cascade, Level
from monitoring.external.policy import device_matches
from monitoring.external.state_map import StateMap

MAP = StateMap(
    source_values=(("3", "Up"), ("4", "Warning"), ("5", "Down"), ("7", "Paused")),
    defaults={"3": "up", "4": "degraded", "5": "down"},
    fixed={"7": "unknown"},
)


class StateMapTests(SimpleTestCase):
    def test_defaults_fill_holes_and_odd_values_are_dropped(self):
        self.assertEqual(
            MAP.clean({"4": "down", "5": "sideways"}),
            {"3": "up", "4": "down", "5": "down", "7": "unknown"},
        )
        self.assertEqual(MAP.clean(None), MAP.default_map())

    def test_fixed_values_cannot_be_remapped(self):
        self.assertEqual(MAP.clean({"7": "down"})["7"], "unknown")

    def test_worst_wins_and_unknown_never_outranks_up(self):
        m = MAP.clean({})
        self.assertEqual(MAP.worst(["3", "4", "5"], m), "down")
        self.assertEqual(MAP.worst(["7", "3"], m), "up")
        self.assertEqual(MAP.worst([], m), "up")


def _dev(**kw):
    return SimpleNamespace(**{"name": "sw1", "serial": "", "addrs": [], **kw})


CASCADE = Cascade(
    levels=(
        Level("address", lambda d: d.addrs),
        Level("name", lambda d: [d.name]),
    ),
    id_key="id",
    plural="widgets",
    singular="widget",
)


class CascadeTests(SimpleTestCase):
    A = {"id": "1", "name": "a"}
    B = {"id": "2", "name": "b"}

    def test_first_unambiguous_level_wins(self):
        idx = {"address": {"10.0.0.1": [self.A]}, "name": {"sw1": [self.B]}}
        m = CASCADE.match(_dev(addrs=["10.0.0.1"]), idx)
        self.assertEqual((m.how, m.remote), ("address", self.A))

    def test_two_candidates_is_no_match(self):
        idx = {"address": {"10.0.0.1": [self.A, self.B]}, "name": {}}
        m = CASCADE.match(_dev(addrs=["10.0.0.1"]), idx)
        self.assertEqual(m.how, "ambiguous")
        self.assertFalse(m.matched)
        self.assertIn("2 widgets share", m.reason)

    def test_the_same_object_twice_is_one(self):
        idx = {"address": {"10.0.0.1": [self.A, dict(self.A)]}, "name": {}}
        self.assertEqual(CASCADE.match(_dev(addrs=["10.0.0.1"]), idx).how, "address")

    def test_stored_link_first_then_falls_through_when_gone(self):
        idx = {"by_id": {"2": self.B}, "address": {}, "name": {"sw1": [self.A]}}
        self.assertEqual(CASCADE.match(_dev(), idx, link_id="2").how, "link")
        m = CASCADE.match(_dev(), idx, link_id="9")
        self.assertEqual((m.how, m.remote), ("name", self.A))

    def test_nothing(self):
        m = CASCADE.match(_dev(), {"address": {}, "name": {}})
        self.assertEqual((m.how, m.reason), ("none", "No widget matches this device."))


def _rule(scope, **kw):
    base = dict(
        scope=scope, region_id=None, target_site_id=None, platform_id=None,
        device_type_id=None, device_role_id=None, device_id=None,
        match_tags=[], match_name="", match_hardware="",
    )
    return SimpleNamespace(**{**base, **kw})


DEVICE = SimpleNamespace(
    id="d1", name="core-sw1", site_id="s1", platform_id="p1",
    device_type_id="t1", role_id="r1",
)


class DeviceMatchesTests(SimpleTestCase):
    def test_device_shaped_scopes(self):
        self.assertTrue(device_matches(_rule("global"), DEVICE))
        self.assertTrue(device_matches(_rule("site", target_site_id="s1"), DEVICE))
        self.assertFalse(device_matches(_rule("site", target_site_id="s2"), DEVICE))
        self.assertTrue(device_matches(_rule("platform", platform_id="p1"), DEVICE))
        self.assertTrue(device_matches(_rule("device_type", device_type_id="t1"), DEVICE))
        self.assertTrue(device_matches(_rule("device_role", device_role_id="r1"), DEVICE))
        self.assertFalse(device_matches(_rule("device_role", device_role_id="r2"), DEVICE))
        self.assertTrue(device_matches(_rule("device", device_id="d1"), DEVICE))

    def test_address_shaped_scopes_never_match(self):
        self.assertFalse(device_matches(_rule("vrf"), DEVICE))
        self.assertFalse(device_matches(_rule("prefix"), DEVICE))
        self.assertFalse(device_matches(_rule("global"), None))

    def test_filters_narrow(self):
        self.assertTrue(device_matches(_rule("global", match_name="core-*"), DEVICE))
        self.assertFalse(device_matches(_rule("global", match_name="edge-*"), DEVICE))
        self.assertTrue(
            device_matches(_rule("global", match_tags=["a"]), DEVICE, device_tags={"a", "b"})
        )
        self.assertFalse(
            device_matches(_rule("global", match_tags=["a", "c"]), DEVICE, device_tags={"a"})
        )
        self.assertTrue(
            device_matches(
                _rule("global", match_hardware="psu*"), DEVICE, device_hardware={"psu-1"}
            )
        )


class AdoptionReasonTests(SimpleTestCase):
    def test_reason_names_what_is_missing(self):
        d = {"site_id": "s", "role_id": None, "device_type_id": None}
        set_reason(d, "name the site in a group")
        self.assertEqual(
            d["reason"],
            "No role, device type to adopt into - set the defaults on the "
            "connection, or name the site in a group.",
        )
        self.assertFalse(applicable(d))
        d.update(role_id="r", device_type_id="t")
        set_reason(d)
        self.assertNotIn("reason", d)
        self.assertTrue(applicable(d))


class RegistryTests(SimpleTestCase):
    def setUp(self):
        self._writers = dict(hooks._ACK_WRITERS)
        self._listeners = dict(hooks._WINDOW_LISTENERS)
        self._beat = dict(beat._ENTRIES)
        # Only what each test registers: the installed systems' entries would
        # reach the database.
        hooks._ACK_WRITERS.clear()
        hooks._WINDOW_LISTENERS.clear()
        beat._ENTRIES.clear()

    def tearDown(self):
        hooks._ACK_WRITERS.clear()
        hooks._ACK_WRITERS.update(self._writers)
        hooks._WINDOW_LISTENERS.clear()
        hooks._WINDOW_LISTENERS.update(self._listeners)
        beat._ENTRIES.clear()
        beat._ENTRIES.update(self._beat)

    def test_ack_writer_is_skipped_for_its_own_source(self):
        fn = mock.Mock()
        hooks.register_ack_writer("demo", fn, system="demo")
        alert = SimpleNamespace(kind="demo")
        hooks.on_alert_acknowledged(None, alert=alert, acknowledged=True, source="demo")
        fn.assert_not_called()
        hooks.on_alert_acknowledged(None, alert=alert, acknowledged=True)
        fn.assert_called_once_with(alert, True, actor=None, source=None)
        hooks.on_alert_acknowledged(
            None, alert=SimpleNamespace(kind="icmp"), acknowledged=True
        )
        self.assertEqual(fn.call_count, 1)

    def test_window_listeners_get_the_tenant(self):
        fn = mock.Mock()
        hooks.register_window_listener("demo", fn)
        hooks.on_window_changed(None, event=SimpleNamespace(tenant_id="t1"))
        hooks.on_event_deleted(None, instance=SimpleNamespace(tenant_id="t2"))
        fn.assert_has_calls([mock.call("t1"), mock.call("t2")])

    def test_beat_skips_own_timer_entries_unless_named(self):
        shared, own = mock.Mock(return_value={"n": 1}), mock.Mock(return_value={})
        beat.register_beat("a", "A", shared)
        beat.register_beat("b", "B", own, own_timer=True)
        self.assertEqual(set(beat.run_beat()), {"a"})
        self.assertEqual(set(beat.run_beat(names=["b"])), {"b"})
        self.assertEqual(set(beat.run_beat(include_own_timer=True)), {"a", "b"})

    def test_enqueue_due_counts_and_respects_the_toggle(self):
        queue = mock.Mock()
        on = SimpleNamespace(id="c1", tenant="on", due=True)
        off = SimpleNamespace(id="c2", tenant="off", due=True)
        job = mock.Mock()
        task = beat.BeatTask("status", lambda c, now: c.due, job, 60)
        with mock.patch(
            "integrations.toggles.integration_enabled", side_effect=lambda t, k: t == "on"
        ):
            out = beat.enqueue_due([on, off], "demo", [task], queue=queue, now=None)
        self.assertEqual(out, {"status": 1})
        queue.enqueue.assert_called_once_with(job, "c1", job_timeout=60)
