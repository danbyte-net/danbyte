"""Rolling an external system's detail up for a list column.

The count and the unreachable protocols come from ``CheckState.last_detail``,
which every check writes. Most checks have nothing to say here, and the rollup
has to stay silent for those rather than render an empty badge on every row.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

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


class IpChecksRollupTests(TestCase):
    """The address's own page must say what the list it was opened from said.

    The prefix's IP row showed "1 problem, SNMP unreachable" while the IP's
    detail page said nothing, which reads as the two disagreeing. Both now come
    from the same helper on the server.
    """

    def setUp(self):
        from api.models import IPAddress, Prefix
        from core.models import Organization, Tenant

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24")
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.5/24", prefix=self.prefix
        )
        user = get_user_model().objects.create_superuser("root", "r@x.io", "pw")
        self.client.force_login(user)

    def _state(self, detail):
        from django.utils import timezone

        from monitoring.models import CheckState, CheckTemplate

        tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="Zabbix", kind="zabbix", interval_seconds=300
        )
        CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=tmpl, kind="zabbix",
            interval_seconds=300, next_run=timezone.now(), status="down",
            last_detail=detail,
        )

    def test_the_endpoint_carries_the_same_rollup_the_lists_use(self):
        self._state({
            "zabbix_host": "aarhus-asw1", "hostid": "10683",
            "zabbix_url": "http://10.0.0.53", "problem_count": 1,
            "problems": [{"name": "Unavailable by ICMP ping", "severity": "4"}],
            "availability": {"snmp": {"state": "down", "error": "timed out"}},
        })
        r = self.client.get(f"/api/monitoring/ips/{self.ip.id}/checks/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["problems"], 1)
        self.assertEqual(body["unreachable"], ["snmp"])
        self.assertEqual(body["external"]["host"], "aarhus-asw1")
        self.assertEqual(body["problem_names"][0]["severity"], "4")

    def test_an_address_with_nothing_external_carries_nothing(self):
        self._state({})
        body = self.client.get(f"/api/monitoring/ips/{self.ip.id}/checks/").json()
        for key in ("problems", "unreachable", "external"):
            self.assertNotIn(key, body)
