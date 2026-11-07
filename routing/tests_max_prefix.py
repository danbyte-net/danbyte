"""BGP ``maximum-prefix N [threshold] [restart M | warning-only]``: the three
detail fields, their range and exclusivity checks, the same inheritance as
``maximum_prefix``, the render keys, and the copy out of ``extra``.
"""

from __future__ import annotations

import importlib

from django.apps import apps as django_apps
from django.core.exceptions import ValidationError

from .models import BGPNeighborAF, BGPPeerGroup, effective_afs, group_effective_afs
from .render import routing_context
from .tests_neighbor_afs import _Base

AF_URL = "/api/routing/bgp-neighbor-afs/"


class ValidationTests(_Base):
    def test_ranges_are_field_errors(self):
        g = BGPPeerGroup(
            tenant=self.tenant,
            name="G",
            maximum_prefix=10,
            maximum_prefix_threshold=101,
            maximum_prefix_restart=0,
        )
        with self.assertRaises(ValidationError) as cm:
            g.full_clean()
        self.assertIn("maximum_prefix_threshold", cm.exception.message_dict)
        self.assertIn("maximum_prefix_restart", cm.exception.message_dict)
        r = self.client.post(
            "/api/routing/bgp-peer-groups/",
            {
                "name": "G",
                "maximum_prefix": 10,
                "maximum_prefix_restart": 65536,
            },
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("maximum_prefix_restart", r.json())

    def test_restart_and_warning_only_refused_together(self):
        r = self.client.post(
            "/api/routing/bgp-peer-groups/",
            {
                "name": "G",
                "maximum_prefix": 10,
                "maximum_prefix_restart": 5,
                "maximum_prefix_warning_only": True,
            },
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("maximum_prefix_restart", r.json())
        # A partial update that would leave both set is refused too.
        s = self._session(remote_address="10.0.0.1", maximum_prefix=10, maximum_prefix_restart=5)
        r = self.client.patch(
            f"/api/routing/bgp-sessions/{s.id}/",
            {"maximum_prefix_warning_only": True},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("maximum_prefix_restart", r.json())
        # Warning-only off next to restart is fine.
        r = self.client.patch(
            f"/api/routing/bgp-sessions/{s.id}/",
            {"maximum_prefix_warning_only": False},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        s = self._session(remote_address="10.0.0.2", address_families=["ipv4-unicast"])
        row = s.afs.get()
        r = self.client.patch(
            f"{AF_URL}{row.id}/",
            {
                "maximum_prefix": 10,
                "maximum_prefix_restart": 5,
                "maximum_prefix_warning_only": True,
            },
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("maximum_prefix_restart", r.json())

    def test_a_family_row_needs_a_maximum_in_effect(self):
        g = BGPPeerGroup.objects.create(
            tenant=self.tenant, name="G", address_families=["ipv4-unicast"]
        )
        s = self._session(
            remote_address="10.0.0.1", peer_group=g, address_families=["ipv4-unicast"]
        )
        row = s.afs.get()
        r = self.client.patch(f"{AF_URL}{row.id}/", {"maximum_prefix_threshold": 75}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("maximum_prefix_threshold", r.json())
        # The group's family row brings one: accepted.
        g.afs.update(maximum_prefix=10)
        r = self.client.patch(f"{AF_URL}{row.id}/", {"maximum_prefix_threshold": 75}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        # Warning-only off says nothing, so it needs no maximum.
        grow = g.afs.get()
        r = self.client.patch(
            f"{AF_URL}{grow.id}/",
            {"maximum_prefix": None, "maximum_prefix_warning_only": False},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)


class ResolutionTests(_Base):
    def test_same_chain_as_maximum_prefix(self):
        g = BGPPeerGroup.objects.create(
            tenant=self.tenant,
            name="CE",
            address_families=["ipv4-unicast"],
            maximum_prefix=10,
            maximum_prefix_threshold=75,
            maximum_prefix_restart=5,
        )
        s = self._session(remote_address="10.0.0.1", peer_group=g)
        eff = s.effective()
        self.assertEqual(
            (eff["maximum_prefix"], eff["maximum_prefix_threshold"], eff["maximum_prefix_restart"]),
            (10, 75, 5),
        )
        self.assertIsNone(eff["maximum_prefix_warning_only"])
        af = effective_afs(s)[0]
        self.assertEqual((af["maximum_prefix_threshold"], af["maximum_prefix_restart"]), (75, 5))
        # The session switches to warning-only: its own value beats the
        # group's restart, which drops out.
        s.maximum_prefix_warning_only = True
        s.save()
        eff = s.effective()
        self.assertTrue(eff["maximum_prefix_warning_only"])
        self.assertIsNone(eff["maximum_prefix_restart"])
        af = effective_afs(s)[0]
        self.assertTrue(af["maximum_prefix_warning_only"])
        self.assertIsNone(af["maximum_prefix_restart"])
        # A session row with a restart beats the session's warning-only.
        s.address_families = ["ipv4-unicast"]
        s.save()
        s.afs.update(maximum_prefix_restart=15)
        af = effective_afs(s)[0]
        self.assertEqual(af["maximum_prefix_restart"], 15)
        self.assertFalse(af["maximum_prefix_warning_only"])
        # An explicit off on the session overrides a group's on.
        g.maximum_prefix_restart = None
        g.maximum_prefix_warning_only = True
        g.save()
        s2 = self._session(
            remote_address="10.0.0.2", peer_group=g, maximum_prefix_warning_only=False
        )
        self.assertIs(s2.effective()["maximum_prefix_warning_only"], False)
        self.assertTrue(group_effective_afs(g)[0]["maximum_prefix_warning_only"])

    def test_details_without_a_maximum_are_dropped(self):
        g = BGPPeerGroup.objects.create(
            tenant=self.tenant,
            name="G",
            address_families=["ipv4-unicast"],
            maximum_prefix_threshold=75,
            maximum_prefix_restart=5,
        )
        s = self._session(remote_address="10.0.0.1", peer_group=g)
        eff = s.effective()
        self.assertIsNone(eff["maximum_prefix_threshold"])
        self.assertIsNone(eff["maximum_prefix_restart"])
        self.assertIsNone(effective_afs(s)[0]["maximum_prefix_restart"])
        # A family row that sets the maximum picks the group's details up.
        g.afs.update(maximum_prefix=10)
        af = effective_afs(s)[0]
        self.assertEqual(
            (af["maximum_prefix"], af["maximum_prefix_threshold"], af["maximum_prefix_restart"]),
            (10, 75, 5),
        )


class SerializerAndRenderTests(_Base):
    def test_fields_effective_and_render(self):
        r = self.client.post(
            "/api/routing/bgp-peer-groups/",
            {
                "name": "CE",
                "address_families": ["ipv4-unicast"],
                "maximum_prefix": 10,
                "maximum_prefix_threshold": 75,
                "maximum_prefix_restart": 5,
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(
            (body["maximum_prefix_threshold"], body["maximum_prefix_restart"]), (75, 5)
        )
        self.assertIsNone(body["maximum_prefix_warning_only"])
        g = BGPPeerGroup.objects.get(pk=body["id"])
        s = self._session(remote_address="10.0.0.1", peer_group=g)
        r = self.client.get(f"/api/routing/bgp-sessions/{s.id}/")
        body = r.json()
        self.assertEqual(body["effective"]["maximum_prefix_restart"], 5)
        self.assertEqual(body["effective_afs"][0]["maximum_prefix_threshold"], 75)
        self.assertIsNone(body["maximum_prefix_restart"])  # stored null: inherits

        ctx = routing_context(self.ce)["bgp"][0]
        sd = ctx["sessions"][0]
        self.assertEqual(
            (
                sd["maximum_prefix"],
                sd["maximum_prefix_threshold"],
                sd["maximum_prefix_restart"],
                sd["maximum_prefix_warning_only"],
            ),
            (10, 75, 5, False),
        )
        a = sd["af_by_name"]["ipv4-unicast"]
        self.assertEqual((a["maximum_prefix_threshold"], a["maximum_prefix_restart"]), (75, 5))
        grp = ctx["peer_groups"][0]
        self.assertEqual((grp["maximum_prefix_threshold"], grp["maximum_prefix_restart"]), (75, 5))
        out = self._render(
            self.ce,
            (
                "{% for b in routing.bgp %}{% for s in b.sessions %}"
                "neighbor {{ s.remote_address }} maximum-prefix {{ s.maximum_prefix }}"
                "{% if s.maximum_prefix_threshold %} {{ s.maximum_prefix_threshold }}{% endif %}"
                "{% if s.maximum_prefix_restart %} restart {{ s.maximum_prefix_restart }}"
                "{% elif s.maximum_prefix_warning_only %} warning-only{% endif %}"
                "{% endfor %}{% endfor %}"
            ),
        )
        self.assertEqual(out.strip(), "neighbor 10.0.0.1 maximum-prefix 10 75 restart 5")


class CopyFromExtraTests(_Base):
    def test_moves_only_integers_in_range_and_keeps_extra(self):
        g = BGPPeerGroup.objects.create(
            tenant=self.tenant,
            name="G",
            maximum_prefix=10,
            extra={"maximum_prefix_threshold": 75, "maximum_prefix_restart": 70000},
        )
        s = self._session(
            remote_address="10.0.0.1",
            maximum_prefix=10,
            extra={"maximum_prefix_threshold": "75", "maximum_prefix_restart": 5},
        )
        s2 = self._session(
            remote_address="10.0.0.2",
            maximum_prefix=10,
            maximum_prefix_restart=9,
            extra={"maximum_prefix_restart": 5, "maximum_prefix_threshold": True},
        )
        row = BGPNeighborAF.objects.create(
            session=s,
            afi_safi="ipv6-unicast",
            extra={"maximum_prefix_threshold": 0},
        )
        mod = importlib.import_module("routing.migrations.0021_bgp_maximum_prefix_detail")
        mod.copy_from_extra(django_apps, None)
        mod.copy_from_extra(django_apps, None)  # idempotent
        g.refresh_from_db()
        s.refresh_from_db()
        s2.refresh_from_db()
        row.refresh_from_db()
        self.assertEqual((g.maximum_prefix_threshold, g.maximum_prefix_restart), (75, None))
        self.assertEqual((s.maximum_prefix_threshold, s.maximum_prefix_restart), (None, 5))
        # An existing value is never overwritten; a bool is not an integer.
        self.assertEqual((s2.maximum_prefix_threshold, s2.maximum_prefix_restart), (None, 9))
        self.assertIsNone(row.maximum_prefix_threshold)
        self.assertEqual(g.extra, {"maximum_prefix_threshold": 75, "maximum_prefix_restart": 70000})
        self.assertEqual(s.extra["maximum_prefix_restart"], 5)
