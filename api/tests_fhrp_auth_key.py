"""An FHRP group's authentication key lives in the secret store, never in
the row (#383) - the arrangement SSID, IPsec and keychain PSKs already use,
through the same model, serializer and viewset mixins.

The API says only whether a key is set; the key itself comes back through
the audited ``reveal-psk`` action under the ``reveal`` verb. Exports,
imports and config templates never carry it, and the upgrade moves keys
written before into the store.
"""
from __future__ import annotations

import csv
import io

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase
from rest_framework.test import APITestCase

from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import FHRPGroup

User = get_user_model()

KEY = "correct-horse-battery"
BEFORE = ("api", "0204_normalise_aggregate_prefixes")
AFTER = ("api", "0205_fhrpgroup_auth_key_secret_store")


def _store(provider: str) -> None:
    ds = DeploymentSettings.load()
    ds.secrets_provider = provider
    ds.save(update_fields=["secrets_provider"])


def _tenant(slug="acme"):
    org = Organization.objects.create(name=slug, slug=slug)
    return Tenant.objects.create(org=org, name=slug, slug=slug)


class _Base(APITestCase):
    def setUp(self):
        self.tenant = _tenant()
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.login(self.admin)
        _store("local")

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def create(self, **extra):
        payload = {"protocol": "vrrp3", "group_id": 10, "auth_type": "plaintext", **extra}
        return self.client.post("/api/fhrp-groups/", payload, format="json")

    def user_with(self, name, actions):
        u = User.objects.create_user(name)
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=name, object_types=["fhrpgroup"], actions=actions
        )
        perm.users.add(u)
        return u


class StoreTests(_Base):
    def test_key_is_stored_under_its_own_folder_and_never_read_back(self):
        r = self.create(auth_key=KEY)
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(body["auth_key_set"])
        self.assertNotIn("auth_key", body)
        g = FHRPGroup.objects.get(pk=body["id"])
        self.assertNotIn(KEY, str(g.__dict__))
        self.assertEqual(g.psk_secret_path, f"fhrp-groups/{g.id}")
        self.assertEqual(g.psk_secret_provider, "local")
        for url in (f"/api/fhrp-groups/{g.id}/", "/api/fhrp-groups/"):
            self.assertNotIn(KEY, self.client.get(url).content.decode())

    def test_without_a_store_a_key_is_refused_not_stored_in_the_clear(self):
        _store("")
        r = self.create(auth_key=KEY)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("auth_key", r.json())
        self.assertFalse(FHRPGroup.objects.exists())
        r = self.create(auth_type="")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertFalse(r.json()["auth_key_set"])

    def test_blank_keeps_null_clears_and_a_new_value_rotates(self):
        gid = self.create(auth_key="first").json()["id"]
        r = self.client.patch(f"/api/fhrp-groups/{gid}/",
                              {"description": "edited", "auth_key": ""}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["auth_key_set"])
        self.client.patch(f"/api/fhrp-groups/{gid}/", {"auth_key": "second"}, format="json")
        r = self.client.post(f"/api/fhrp-groups/{gid}/reveal-psk/")
        self.assertEqual(r.json()["psk"], "second")
        r = self.client.patch(f"/api/fhrp-groups/{gid}/", {"auth_key": None}, format="json")
        self.assertFalse(r.json()["auth_key_set"])
        g = FHRPGroup.objects.get(pk=gid)
        self.assertEqual((g.psk_secret_path, g.psk_secret_provider), ("", ""))
        r = self.client.post(f"/api/fhrp-groups/{gid}/reveal-psk/")
        self.assertEqual(r.status_code, 400, r.content)

    def test_turning_authentication_off_clears_the_key(self):
        from monitoring.secret_store import active_secret_store

        gid = self.create(auth_key=KEY).json()["id"]
        path = FHRPGroup.objects.get(pk=gid).psk_secret_path
        r = self.client.patch(f"/api/fhrp-groups/{gid}/", {"auth_type": ""}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["auth_key_set"])
        self.assertIsNone(active_secret_store().get(self.tenant.id, path))

    def test_a_key_without_authentication_is_refused(self):
        r = self.create(auth_type="", auth_key=KEY)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("auth_key", r.json())

    def test_deleting_the_group_takes_the_key_with_it(self):
        from monitoring.secret_store import active_secret_store

        gid = self.create(auth_key=KEY).json()["id"]
        path = FHRPGroup.objects.get(pk=gid).psk_secret_path
        self.assertIsNotNone(active_secret_store().get(self.tenant.id, path))
        self.assertEqual(self.client.delete(f"/api/fhrp-groups/{gid}/").status_code, 204)
        self.assertIsNone(active_secret_store().get(self.tenant.id, path))

    def test_the_change_log_never_carries_the_key(self):
        gid = self.create(auth_key=KEY).json()["id"]
        self.client.patch(f"/api/fhrp-groups/{gid}/", {"auth_key": "rotated"}, format="json")
        for e in ChangeLogEntry.objects.filter(object_id=gid):
            blob = f"{e.changes} {e.pre_change} {e.post_change}"
            self.assertNotIn(KEY, blob)
            self.assertNotIn("rotated", blob)


class RevealTests(_Base):
    def setUp(self):
        super().setUp()
        self.gid = self.create(auth_key=KEY).json()["id"]

    def test_view_only_user_reads_neither_the_key_nor_the_reveal(self):
        self.login(self.user_with("viewer", ["view"]))
        for url in (f"/api/fhrp-groups/{self.gid}/", "/api/fhrp-groups/"):
            r = self.client.get(url)
            self.assertEqual(r.status_code, 200, url)
            self.assertNotIn(KEY, r.content.decode())
        self.assertTrue(self.client.get(f"/api/fhrp-groups/{self.gid}/").json()["auth_key_set"])
        r = self.client.post(f"/api/fhrp-groups/{self.gid}/reveal-psk/")
        self.assertEqual(r.status_code, 403, r.content)
        self.assertNotIn(KEY, r.content.decode())
        self.assertFalse(ChangeLogEntry.objects.filter(action=ChangeAction.REVEAL).exists())

    def test_reveal_grant_returns_it_and_leaves_an_audit_trail(self):
        user = self.user_with("revealer", ["view", "reveal"])
        self.login(user)
        r = self.client.post(f"/api/fhrp-groups/{self.gid}/reveal-psk/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["psk"], KEY)
        entry = ChangeLogEntry.objects.get(action=ChangeAction.REVEAL, object_id=self.gid)
        self.assertEqual(entry.object_label, "FHRP group")
        self.assertEqual(entry.object_type, "api.fhrpgroup")
        self.assertEqual(entry.changes, {"revealed": "auth_key"})
        self.assertEqual(entry.user_id, user.id)
        self.assertNotIn(KEY, str(entry.changes))

    def test_another_tenant_cannot_reveal(self):
        other = _tenant("other")
        u = User.objects.create_superuser("other", "o@a.c", "pw")
        self.client.force_login(u)
        s = self.client.session
        s["current_tenant_id"] = str(other.id)
        s.save()
        r = self.client.post(f"/api/fhrp-groups/{self.gid}/reveal-psk/")
        self.assertEqual(r.status_code, 404, r.content)


class ExportImportTests(_Base):
    def test_export_carries_neither_the_key_nor_its_reference(self):
        self.create(auth_key=KEY)
        r = self.client.get("/api/io/fhrpgroup/export/?fmt=csv")
        self.assertEqual(r.status_code, 200)
        text = b"".join(r.streaming_content).decode()
        self.assertNotIn(KEY, text)
        header = next(csv.reader(io.StringIO(text)))
        for col in ("auth_key", "psk_secret_path", "psk_secret_provider"):
            self.assertNotIn(col, header)
        self.assertIn("auth_type", header)

    def test_round_trip_keeps_the_stored_key(self):
        gid = self.create(auth_key=KEY).json()["id"]
        text = b"".join(
            self.client.get("/api/io/fhrpgroup/export/?fmt=csv").streaming_content
        ).decode()
        r = self.client.post("/api/io/fhrpgroup/import/",
                             {"format": "csv", "content": text}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["errors"], [], r.content)
        r = self.client.post(f"/api/fhrp-groups/{gid}/reveal-psk/")
        self.assertEqual(r.json()["psk"], KEY)

    def test_import_cannot_point_a_group_at_another_key(self):
        a = self.create(auth_key=KEY).json()["id"]
        b = self.create(group_id=11, auth_key="other-key").json()["id"]
        content = (
            "id,protocol,group_id,auth_type,psk_secret_path,auth_key\n"
            f"{b},vrrp3,11,plaintext,fhrp-groups/{a},injected\n"
        )
        r = self.client.post("/api/io/fhrpgroup/import/",
                             {"format": "csv", "content": content}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        g = FHRPGroup.objects.get(pk=b)
        self.assertEqual(g.psk_secret_path, f"fhrp-groups/{b}")
        self.assertEqual(self.client.post(f"/api/fhrp-groups/{b}/reveal-psk/").json()["psk"],
                         "other-key")


class RenderTests(_Base):
    def test_config_template_gets_a_placeholder_never_the_key(self):
        from api.models import (
            Device,
            DeviceType,
            ExportTemplate,
            FHRPGroupAssignment,
            Interface,
            Manufacturer,
            Site,
        )
        from api.status_registry import seed_builtin_statuses

        seed_builtin_statuses(self.tenant)
        gid = self.create(auth_key=KEY).json()["id"]
        site = Site.objects.create(tenant=self.tenant, name="S")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        dev = Device.objects.create(tenant=self.tenant, name="r1", device_type=dt, site=site)
        iface = Interface.objects.create(device=dev, name="vlan10")
        FHRPGroupAssignment.objects.create(fhrp_group_id=gid, interface=iface, priority=110)
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="t", object_type="device",
            template_code=(
                "{% for g in routing.by_interface['vlan10'].fhrp %}"
                "{{ g.auth_type }} {{ g.key_set }} {{ g.key_placeholder }}{% endfor %}"
            ),
        )
        r = self.client.get(f"/api/devices/{dev.id}/render/?template={t.id}")
        self.assertEqual(r.status_code, 200, r.content)
        out = r.json()["output"].strip()
        self.assertEqual(out, f"plaintext True <fhrp-key:{gid}>")
        self.assertNotIn(KEY, r.content.decode())


class MigrationTests(TestCase):
    """The upgrade moves keys written before #383 out of the row."""

    def setUp(self):
        self.tenant = _tenant()
        # Rows written in this transaction leave deferred foreign-key checks
        # pending, and ALTER TABLE refuses a table with pending checks.
        with connection.cursor() as c:
            c.execute("SET CONSTRAINTS ALL IMMEDIATE")

    def _old_group(self, key):
        ex = MigrationExecutor(connection)
        ex.migrate([BEFORE])
        old = ex.loader.project_state([BEFORE]).apps.get_model("api", "FHRPGroup")
        row = old.objects.create(
            tenant_id=self.tenant.id, protocol="hsrp", group_id=1,
            auth_type="md5", auth_key=key,
        )
        return row.pk

    def _forward(self):
        MigrationExecutor(connection).migrate([AFTER])

    def _column_exists(self) -> bool:
        with connection.cursor() as c:
            cols = [col.name for col in connection.introspection.get_table_description(
                c, "api_fhrpgroup")]
        return "auth_key" in cols

    def test_moves_keys_into_the_configured_store(self):
        from monitoring.secret_store import active_secret_store

        _store("local")
        pk = self._old_group(KEY)
        self._forward()
        self.assertFalse(self._column_exists())
        g = FHRPGroup.objects.get(pk=pk)
        self.assertEqual(g.psk_secret_path, f"fhrp-groups/{pk}")
        self.assertEqual(g.psk_secret_provider, "local")
        self.assertEqual(g.resolve_psk(), KEY)
        self.assertEqual(active_secret_store().get(self.tenant.id, g.psk_secret_path),
                         {"psk": KEY})

    def test_without_a_store_keys_go_to_the_encrypted_local_table(self):
        from monitoring.models import StoredSecret
        from monitoring.secret_store import SecretStoreDisabled

        _store("")
        pk = self._old_group(KEY)
        self._forward()
        self.assertFalse(self._column_exists())
        g = FHRPGroup.objects.get(pk=pk)
        self.assertTrue(g.psk_set)
        self.assertEqual(g.psk_secret_provider, "local")
        row = StoredSecret.objects.get(tenant=self.tenant, ref=f"fhrp-groups/{pk}")
        self.assertEqual(row.value, {"psk": KEY})
        with connection.cursor() as c:
            c.execute("SELECT value FROM monitoring_storedsecret WHERE id = %s", [row.id])
            self.assertNotIn(KEY, str(c.fetchone()[0]))
        # Still fail-closed: nothing reveals it until a store is enabled.
        with self.assertRaises(SecretStoreDisabled):
            g.resolve_psk()
        _store("local")
        self.assertEqual(g.resolve_psk(), KEY)

    def test_groups_without_a_key_stay_without_one(self):
        _store("local")
        pk = self._old_group("")
        self._forward()
        g = FHRPGroup.objects.get(pk=pk)
        self.assertEqual((g.psk_secret_path, g.psk_secret_provider), ("", ""))

    def test_reverses_back_into_the_column(self):
        from monitoring.models import StoredSecret

        _store("local")
        pk = self._old_group(KEY)
        self._forward()
        ex = MigrationExecutor(connection)
        ex.migrate([BEFORE])
        old = ex.loader.project_state([BEFORE]).apps.get_model("api", "FHRPGroup")
        self.assertEqual(old.objects.get(pk=pk).auth_key, KEY)
        self.assertFalse(StoredSecret.objects.filter(ref=f"fhrp-groups/{pk}").exists())
        self._forward()
        self.assertEqual(FHRPGroup.objects.get(pk=pk).resolve_psk(), KEY)


class ChangeLogScrubTests(TestCase):
    """Change-log rows written while the key was a column are masked."""

    def test_old_entries_lose_the_key(self):
        from importlib import import_module

        from django.apps import apps

        tenant = _tenant()
        e = ChangeLogEntry.objects.create(
            tenant=tenant, action=ChangeAction.UPDATE, object_type="api.fhrpgroup",
            object_id="x", object_repr="HSRP 1",
            changes={"auth_key": {"old": "", "new": KEY}, "name": {"old": "", "new": "a"}},
            pre_change={"auth_key": "", "name": ""},
            post_change={"auth_key": KEY, "name": "a"},
        )
        other = ChangeLogEntry.objects.create(
            tenant=tenant, action=ChangeAction.UPDATE, object_type="api.site",
            object_id="y", object_repr="S", changes={"auth_key": {"old": "", "new": "s"}},
        )
        mod = import_module("audit.migrations.0012_scrub_fhrp_auth_key")
        mod.scrub(apps, None)
        e.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual(e.changes["auth_key"], {"old": None, "new": "•••"})
        self.assertEqual(e.changes["name"], {"old": "", "new": "a"})
        self.assertEqual(e.post_change["auth_key"], "•••")
        self.assertIsNone(e.pre_change["auth_key"])
        self.assertNotIn(KEY, f"{e.changes} {e.pre_change} {e.post_change}")
        self.assertEqual(other.changes["auth_key"]["new"], "s")
