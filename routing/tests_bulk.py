"""Bulk edit and safe bulk delete on the routing lists (#314): every list
answers ``bulk-delete`` with a preview and kept rows, ``bulk-update`` with
the fields its spec names checked as a PATCH checks them, and
``bulk-edit-fields`` with the same fields described for the dialog - inside
the tenant, the caller's grant and the site fence, with a change-log entry
per row.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import VRF, Interface, Site, Status
from api.tests_wireless_psk import _enable_local_store
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Tag

from .models import (
    VTEP,
    ASPathList,
    BFDProfile,
    BGPInstance,
    BGPPeerGroup,
    BGPSession,
    Community,
    CommunityList,
    CommunityListRule,
    EIGRPInstance,
    EthernetSegment,
    ISISInstance,
    OSPFArea,
    OSPFInstance,
    OSPFInterface,
    PrefixList,
    RoutingKeychain,
    RoutingPolicy,
    RoutingPolicyRule,
    StaticRoute,
)
from .tests_access import _device, _fill, _tenant

User = get_user_model()

# The seventeen lists of #314 and their models.
LISTS = {
    "/api/routing/bgp-instances/": BGPInstance,
    "/api/routing/bgp-sessions/": BGPSession,
    "/api/routing/bgp-peer-groups/": BGPPeerGroup,
    "/api/routing/ospf-instances/": OSPFInstance,
    "/api/routing/ospf-areas/": OSPFArea,
    "/api/routing/isis-instances/": ISISInstance,
    "/api/routing/eigrp-instances/": EIGRPInstance,
    "/api/routing/vteps/": VTEP,
    "/api/routing/ethernet-segments/": EthernetSegment,
    "/api/routing/static-routes/": StaticRoute,
    "/api/routing/policies/": RoutingPolicy,
    "/api/routing/prefix-lists/": PrefixList,
    "/api/routing/communities/": Community,
    "/api/routing/community-lists/": CommunityList,
    "/api/routing/as-path-lists/": ASPathList,
    "/api/routing/keychains/": RoutingKeychain,
    "/api/routing/bfd-profiles/": BFDProfile,
}


def _fill_all(tenant, device, tag):
    rows = _fill(tenant, device, tag)
    rows[EthernetSegment] = EthernetSegment.objects.create(
        tenant=tenant, name=f"ES-{tag}", esi=f"00:11:22:33:44:55:66:77:88:{len(tag):02x}"
    )
    rows[Community] = Community.objects.create(
        tenant=tenant, name=f"C-{tag}", value=f"65000:{len(tag)}"
    )
    rows[CommunityList] = CommunityList.objects.create(tenant=tenant, name=f"CL-{tag}")
    rows[ASPathList] = ASPathList.objects.create(tenant=tenant, name=f"AP-{tag}")
    return rows


class _Base(APITestCase):
    def setUp(self):
        self.t = _tenant("t")
        self.other = _tenant("o")
        self.ams = Site.objects.create(tenant=self.t, name="AMS")
        self.lon = Site.objects.create(tenant=self.t, name="LON")
        self.dev = _device(self.t, self.ams, "ams-r1")
        self.dev_lon = _device(self.t, self.lon, "lon-r1")
        self.rows = _fill_all(self.t, self.dev, "a")
        self.foreign = _fill_all(
            self.other, _device(self.other, Site.objects.create(tenant=self.other, name="X"),
                                "x-r1"), "x"
        )
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.login(self.admin)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.t.id)
        s.save()

    def delete(self, url, ids, dry_run=False):
        body = {"ids": [str(i) for i in ids]}
        if dry_run:
            body["dry_run"] = True
        return self.client.post(f"{url}bulk-delete/", body, format="json")

    def update(self, url, ids, fields):
        return self.client.post(
            f"{url}bulk-update/", {"ids": [str(i) for i in ids], "fields": fields},
            format="json",
        )

    def status(self, slug, scope):
        return Status.objects.get(tenant=self.t, slug=slug, available_to__contains=[scope])


class EveryListTests(_Base):
    def test_every_list_previews_and_deletes_and_leaves_the_other_tenant(self):
        for url, model in LISTS.items():
            with self.subTest(url=url):
                mine, theirs = self.rows[model], self.foreign[model]
                r = self.delete(url, [mine.id, theirs.id], dry_run=True)
                self.assertEqual(r.status_code, 200, r.content)
                self.assertEqual(r.json()["deleted_ids"], [str(mine.id)])
                self.assertTrue(model.objects.filter(pk=mine.pk).exists())
        # Children before parents: a session before its instance.
        order = [BGPSession, *[m for m in LISTS.values() if m is not BGPSession]]
        for model in order:
            url = next(u for u, m in LISTS.items() if m is model)
            with self.subTest(url=url):
                mine, theirs = self.rows[model], self.foreign[model]
                r = self.delete(url, [mine.id, theirs.id])
                self.assertEqual(r.status_code, 200, r.content)
                self.assertEqual(r.json()["deleted"], 1, r.content)
                self.assertFalse(model.objects.filter(pk=mine.pk).exists())
                self.assertTrue(model.objects.filter(pk=theirs.pk).exists())
                self.assertTrue(ChangeLogEntry.objects.filter(
                    action=ChangeAction.DELETE, object_id=str(mine.pk)
                ).exists())

    def test_every_list_bulk_edits_description_and_tags_with_a_log_per_row(self):
        tag = Tag.objects.create(tenant=self.t, name="core", slug="core")
        for url, model in LISTS.items():
            with self.subTest(url=url):
                mine, theirs = self.rows[model], self.foreign[model]
                r = self.update(url, [mine.id, theirs.id],
                                {"description": "  bulk  ", "add_tag_ids": [tag.id]})
                self.assertEqual(r.status_code, 200, r.content)
                self.assertEqual(r.json()["updated"], 1)
                mine.refresh_from_db()
                theirs.refresh_from_db()
                self.assertEqual(mine.description, "bulk")
                self.assertNotEqual(theirs.description, "bulk")
                self.assertEqual([t.slug for t in mine.tags.all()], ["core"])
                self.assertTrue(ChangeLogEntry.objects.filter(
                    action=ChangeAction.UPDATE, object_id=str(mine.pk),
                    changes__has_key="description",
                ).exists())

    def test_every_list_describes_its_bulk_fields(self):
        for url in LISTS:
            with self.subTest(url=url):
                r = self.client.get(f"{url}bulk-edit-fields/")
                self.assertEqual(r.status_code, 200, r.content)
                keys = [f["key"] for f in r.json()["fields"]]
                self.assertIn("description", keys)
                self.assertTrue(r.json()["tags"])

    def test_the_per_type_fields(self):
        def fields(url):
            return {f["key"]: f for f in self.client.get(f"{url}bulk-edit-fields/").json()["fields"]}

        s = fields("/api/routing/bgp-sessions/")
        self.assertEqual(list(s), [
            "status_id", "description", "peer_group_id", "bfd_profile_id", "keychain_id",
            "import_policy_id", "export_policy_id",
        ])
        self.assertEqual(s["status_id"]["status_model"], "bgpsession")
        self.assertEqual(s["peer_group_id"]["kind"], "object")
        self.assertEqual(s["peer_group_id"]["endpoint"], "/api/routing/bgp-peer-groups/")
        self.assertEqual(s["import_policy_id"]["endpoint"], "/api/routing/policies/")
        r = fields("/api/routing/static-routes/")
        self.assertEqual(list(r), ["status_id", "description", "vrf_id", "next_hop", "distance"])
        self.assertEqual(r["vrf_id"]["kind"], "vrf")
        self.assertEqual(r["distance"]["kind"], "int")
        for url in ("/api/routing/ospf-instances/", "/api/routing/isis-instances/",
                    "/api/routing/eigrp-instances/"):
            f = fields(url)
            self.assertEqual(list(f), ["status_id", "description", "vrf_id"])
            self.assertEqual(f["status_id"]["status_model"], "routinginstance")
        self.assertEqual(list(fields("/api/routing/keychains/")), ["description"])

    def test_bad_ids_and_unknown_fields_are_400(self):
        url = "/api/routing/bgp-sessions/"
        self.assertEqual(self.client.post(f"{url}bulk-delete/", {"ids": ["nope"]},
                                          format="json").status_code, 400)
        r = self.update(url, [self.rows[BGPSession].id], {"remote_asn": 1})
        self.assertEqual(r.status_code, 400)
        self.assertIn("remote_asn", r.json())
        r = self.update(url, [self.rows[BGPSession].id], {})
        self.assertEqual(r.status_code, 400)


class KeptRowTests(_Base):
    def test_rows_still_referenced_are_kept_with_the_reason(self):
        t, sess = self.t, self.rows[BGPSession]
        used = {
            BGPPeerGroup: self.rows[BGPPeerGroup],
            RoutingPolicy: self.rows[RoutingPolicy],
            RoutingKeychain: self.rows[RoutingKeychain],
            BFDProfile: self.rows[BFDProfile],
        }
        sess.peer_group = used[BGPPeerGroup]
        sess.import_policy = used[RoutingPolicy]
        sess.keychain = used[RoutingKeychain]
        sess.bfd_profile = used[BFDProfile]
        sess.save()
        policy2 = RoutingPolicy.objects.create(tenant=t, name="POL-2")
        rule = RoutingPolicyRule.objects.create(policy=policy2, sequence=10)
        rule.match_prefix_lists.add(self.rows[PrefixList])
        rule.match_community_lists.add(self.rows[CommunityList])
        rule.match_as_path_lists.add(self.rows[ASPathList])
        clr = CommunityListRule.objects.create(community_list=CommunityList.objects.create(
            tenant=t, name="CL-2"), sequence=10)
        clr.communities.add(self.rows[Community])
        used.update({m: self.rows[m] for m in (PrefixList, CommunityList, ASPathList, Community)})
        ospf_if = Interface.objects.create(device=self.dev, name="eth9")
        OSPFInterface.objects.create(
            instance=self.rows[OSPFInstance], interface=ospf_if, area=self.rows[OSPFArea]
        )
        used[OSPFArea] = self.rows[OSPFArea]

        for model, row in used.items():
            url = next(u for u, m in LISTS.items() if m is model)
            spare = model.objects.create(
                tenant=t, name=f"spare-{model.__name__}",
                **({"area_id": "1"} if model is OSPFArea else {}),
                **({"value": "65000:99"} if model is Community else {}),
            )
            with self.subTest(model=model.__name__):
                r = self.delete(url, [row.id, spare.id], dry_run=True)
                body = r.json()
                self.assertEqual(body["deleted_ids"], [str(spare.id)])
                self.assertEqual([s["id"] for s in body["skipped"]], [str(row.id)])
                self.assertTrue(body["skipped"][0]["reason"].startswith("In use: "))
                r = self.delete(url, [row.id, spare.id])
                self.assertEqual(r.json()["deleted"], 1)
                self.assertTrue(model.objects.filter(pk=row.pk).exists())
                self.assertFalse(model.objects.filter(pk=spare.pk).exists())
        reasons = self.delete("/api/routing/bgp-peer-groups/",
                              [used[BGPPeerGroup].id]).json()["skipped"][0]["reason"]
        self.assertEqual(reasons, "In use: 1 BGP sessions.")
        reasons = self.delete("/api/routing/ospf-areas/",
                              [used[OSPFArea].id]).json()["skipped"][0]["reason"]
        self.assertEqual(reasons, "In use: 1 OSPF interfaces.")
        # The session itself goes freely; then its peer group is free too.
        self.assertEqual(self.delete("/api/routing/bgp-sessions/", [sess.id]).json()["deleted"], 1)
        self.assertEqual(
            self.delete("/api/routing/bgp-peer-groups/", [used[BGPPeerGroup].id]).json()["deleted"],
            1,
        )

    def test_instance_goes_with_its_sessions_listed_as_impact(self):
        r = self.delete("/api/routing/bgp-instances/", [self.rows[BGPInstance].id], dry_run=True)
        self.assertEqual(r.json()["impact"], [{"label": "BGP sessions", "count": 1}])

    def test_a_keychains_key_leaves_the_secret_store(self):
        from monitoring.secret_store import active_secret_store

        _enable_local_store()
        kid = self.client.post("/api/routing/keychains/", {
            "name": "ISIS", "algorithm": "md5", "psk": "correct horse battery",
        }, format="json").json()["id"]
        path = RoutingKeychain.objects.get(pk=kid).psk_secret_path
        self.assertIsNotNone(active_secret_store().get(self.t.id, path))
        r = self.delete("/api/routing/keychains/", [kid])
        self.assertEqual(r.json()["deleted"], 1)
        self.assertIsNone(active_secret_store().get(self.t.id, path))


class SessionEditTests(_Base):
    url = "/api/routing/bgp-sessions/"

    def setUp(self):
        super().setUp()
        inst = self.rows[BGPInstance]
        self.s2 = BGPSession.objects.create(
            tenant=self.t, instance=inst, remote_address="10.0.0.3", remote_asn=65003
        )
        self.ids = [self.rows[BGPSession].id, self.s2.id]

    def test_the_session_fields_land_on_every_row(self):
        disabled = self.status("disabled", "bgpsession")
        r = self.update(self.url, self.ids, {
            "status_id": str(disabled.id),
            "peer_group_id": str(self.rows[BGPPeerGroup].id),
            "bfd_profile_id": str(self.rows[BFDProfile].id),
            "keychain_id": str(self.rows[RoutingKeychain].id),
            "import_policy_id": str(self.rows[RoutingPolicy].id),
            "export_policy_id": str(self.rows[RoutingPolicy].id),
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        for s in BGPSession.objects.filter(pk__in=self.ids):
            self.assertEqual(s.status_id, disabled.id)
            self.assertEqual(s.peer_group_id, self.rows[BGPPeerGroup].id)
            self.assertEqual(s.bfd_profile_id, self.rows[BFDProfile].id)
            self.assertEqual(s.keychain_id, self.rows[RoutingKeychain].id)
            self.assertEqual(s.import_policy_id, self.rows[RoutingPolicy].id)
            self.assertEqual(s.export_policy_id, self.rows[RoutingPolicy].id)
            entry = ChangeLogEntry.objects.filter(
                action=ChangeAction.UPDATE, object_id=str(s.pk)
            ).latest("timestamp")
            self.assertIn("peer_group_id", entry.changes)
        # An empty id clears.
        r = self.update(self.url, self.ids, {"keychain_id": ""})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(BGPSession.objects.filter(pk__in=self.ids, keychain__isnull=False).exists())

    def test_another_tenants_objects_and_foreign_statuses_are_refused(self):
        for key, model in (("peer_group_id", BGPPeerGroup), ("keychain_id", RoutingKeychain),
                           ("bfd_profile_id", BFDProfile), ("import_policy_id", RoutingPolicy)):
            with self.subTest(key=key):
                r = self.update(self.url, self.ids, {key: str(self.foreign[model].id)})
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn(key, r.json())
        not_offered = Status.objects.filter(tenant=self.t).exclude(
            available_to__contains=["bgpsession"]
        ).first()
        r = self.update(self.url, self.ids, {"status_id": str(not_offered.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(BGPSession.objects.filter(status=not_offered).exists())


class StaticRouteEditTests(_Base):
    url = "/api/routing/static-routes/"

    def setUp(self):
        super().setUp()
        self.vrf = VRF.objects.create(tenant=self.t, name="CUST", rd="65000:1")
        self.r1 = self.rows[StaticRoute]
        self.r2 = StaticRoute.objects.create(
            tenant=self.t, device=self.dev, prefix="10.9.0.0/16", next_hop="10.0.0.1"
        )

    def test_vrf_next_hop_and_distance(self):
        r = self.update(self.url, [self.r1.id, self.r2.id], {
            "vrf_id": str(self.vrf.id), "next_hop": " 2001:db8:0::0001 ", "distance": 250,
        })
        self.assertEqual(r.status_code, 200, r.content)
        for row in (self.r1, self.r2):
            row.refresh_from_db()
            self.assertEqual(row.vrf_id, self.vrf.id)
            self.assertEqual(row.next_hop, "2001:db8::1")
            self.assertEqual(row.distance, 250)

    def test_bad_values_and_row_rules_are_refused_with_nothing_written(self):
        r = self.update(self.url, [self.r1.id], {"next_hop": "not-an-ip"})
        self.assertEqual(r.status_code, 400, r.content)
        r = self.update(self.url, [self.r1.id], {"distance": 70000})
        self.assertEqual(r.status_code, 400, r.content)
        r = self.update(self.url, [self.r1.id], {"vrf_id": str(VRF.objects.create(
            tenant=self.other, name="X", rd="1:1").id)})
        self.assertEqual(r.status_code, 400, r.content)
        hole = StaticRoute.objects.create(
            tenant=self.t, device=self.dev, prefix="10.66.0.0/16", kind="blackhole"
        )
        r = self.update(self.url, [self.r1.id, hole.id], {"next_hop": "10.0.0.9"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("10.66.0.0/16", str(r.json()))
        self.r1.refresh_from_db()
        self.assertEqual(self.r1.next_hop, "10.0.0.1")

    def test_a_path_two_rows_would_share_is_a_409(self):
        StaticRoute.objects.filter(pk=self.r2.pk).update(prefix=self.r1.prefix,
                                                          next_hop="10.0.0.2")
        r = self.update(self.url, [self.r2.id], {"next_hop": "10.0.0.1"})
        self.assertEqual(r.status_code, 409, r.content)


class InstanceVRFTests(_Base):
    def test_igp_instances_move_to_a_vrf(self):
        vrf = VRF.objects.create(tenant=self.t, name="CUST", rd="65000:1")
        for url, model in (("/api/routing/ospf-instances/", OSPFInstance),
                           ("/api/routing/isis-instances/", ISISInstance),
                           ("/api/routing/eigrp-instances/", EIGRPInstance)):
            with self.subTest(url=url):
                planned = self.status("planned", "routinginstance")
                r = self.update(url, [self.rows[model].id],
                                {"vrf_id": str(vrf.id), "status_id": str(planned.id)})
                self.assertEqual(r.status_code, 200, r.content)
                row = model.objects.get(pk=self.rows[model].pk)
                self.assertEqual((row.vrf_id, row.status_id), (vrf.id, planned.id))


class AccessTests(_Base):
    def _user(self, actions, sites=None, types=("staticroute",)):
        user = User.objects.create_user(f"u{ObjectPermission.objects.count()}")
        UserProfile.objects.create(user=user).tenants.add(self.t)
        perm = ObjectPermission.objects.create(
            name=f"p{ObjectPermission.objects.count()}", object_types=list(types),
            actions=actions,
        )
        perm.users.add(user)
        if sites:
            perm.sites.set(sites)
        self.login(user)
        return user

    def test_view_only_may_not_edit_delete_or_read_the_edit_fields(self):
        self._user(["view"])
        url = "/api/routing/static-routes/"
        self.assertEqual(self.delete(url, [self.rows[StaticRoute].id]).status_code, 403)
        self.assertEqual(
            self.update(url, [self.rows[StaticRoute].id], {"description": "x"}).status_code, 403
        )
        self.assertEqual(self.client.get(f"{url}bulk-edit-fields/").status_code, 403)
        self.assertTrue(StaticRoute.objects.filter(pk=self.rows[StaticRoute].pk).exists())

    def test_a_site_scoped_grant_reaches_only_its_sites_rows(self):
        lon_route = StaticRoute.objects.create(
            tenant=self.t, device=self.dev_lon, prefix="10.7.0.0/16", next_hop="10.0.0.1"
        )
        self._user(["view", "change", "delete"], sites=[self.ams])
        url = "/api/routing/static-routes/"
        r = self.update(url, [self.rows[StaticRoute].id, lon_route.id], {"description": "x"})
        self.assertEqual(r.json()["updated"], 1)
        lon_route.refresh_from_db()
        self.assertEqual(lon_route.description, "")
        r = self.delete(url, [self.rows[StaticRoute].id, lon_route.id])
        self.assertEqual(r.json()["deleted_ids"], [str(self.rows[StaticRoute].id)])
        self.assertTrue(StaticRoute.objects.filter(pk=lon_route.pk).exists())
