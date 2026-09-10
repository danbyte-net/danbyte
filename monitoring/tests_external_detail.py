"""Rolling an external system's detail up for a list column.

The count and the unreachable protocols come from ``CheckState.last_detail``,
which every check writes. Most checks have nothing to say here, and the rollup
has to stay silent for those rather than render an empty badge on every row.
"""
from __future__ import annotations

from django.test import SimpleTestCase

from .views import _external_detail


class ExternalDetailTests(SimpleTestCase):
    def test_nothing_to_say_is_an_empty_dict(self):
        self.assertEqual(_external_detail([{}, {"avg_rtt": 0.2}]), {})

    def test_problem_counts_add_up_across_checks(self):
        got = _external_detail([{"problem_count": 2}, {"problem_count": 1}])
        self.assertEqual(got["problems"], 3)

    def test_only_down_protocols_are_reported(self):
        got = _external_detail([{
            "availability": {
                "agent": {"state": "up"},
                "snmp": {"state": "down"},
                "jmx": {"state": "unknown"},
            }
        }])
        self.assertEqual(got["unreachable"], ["snmp"])

    def test_a_protocol_down_on_any_check_counts_once(self):
        got = _external_detail([
            {"availability": {"snmp": {"state": "down"}}},
            {"availability": {"snmp": {"state": "down"}}},
        ])
        self.assertEqual(got["unreachable"], ["snmp"])

    def test_a_healthy_host_reports_neither(self):
        self.assertEqual(
            _external_detail([{"availability": {"agent": {"state": "up"}}}]), {}
        )

    def test_junk_in_the_detail_does_not_raise(self):
        """`last_detail` is free-form JSON a checker or a plugin writes; a list
        column must not 500 on an unexpected shape."""
        self.assertEqual(
            _external_detail([None, "nonsense", {"availability": "wrong"}, 7]), {}
        )
