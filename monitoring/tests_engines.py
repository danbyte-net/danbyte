"""Phase 0 (control plane) tests for distributed monitoring engines (Outposts):
the local singleton, the site/location → engine resolver, the admin-gated API
(list/create/enroll/delete), the site/location binding endpoint, and that
``materialise`` stamps ``CheckState.engine``.
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, IPAddress, Location, Prefix, Site
from api.test_utils import status_for
from core.models import Organization, Tenant

from .engines import engine_for_ip, engine_for_prefix, set_binding
from .models import (
    CheckAssignment,
    CheckResult,
    CheckState,
    CheckTemplate,
    DeviceSnmp,
    MonitoringEngine,
    MonitoringEngineBinding,
    MonitoringDenySubnet,
    MonitoringPolicy,
    MonitoringProfile,
    MonitoringSettings,
    SnmpProfile,
    SnmpProfileBinding,
)
from .scheduler import materialise_ip

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()


class EngineModelTests(_Base):
    def test_local_singleton(self):
        a = MonitoringEngine.local_for(self.tenant)
        b = MonitoringEngine.local_for(self.tenant)
        self.assertEqual(a.id, b.id)
        self.assertTrue(a.is_local)
        self.assertEqual(a.slug, "local")

    def test_token_set_flag(self):
        e = MonitoringEngine.objects.create(
            tenant=self.tenant, name="ams", slug="ams", kind="remote"
        )
        self.assertFalse(e.token_set)
        e.token = {"secret": "abc"}
        e.save()
        self.assertTrue(e.token_set)


class EngineResolverTests(_Base):
    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(tenant=self.tenant, name="dc-ams")
        self.location = Location.objects.create(
            tenant=self.tenant, site=self.site, name="rack-row-A"
        )
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", site=self.site,
            status=status_for(self.tenant, "container"),
        )
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", site=self.site, location=self.location
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix,
            assigned_device=self.dev,
        )
        self.site_eng = MonitoringEngine.objects.create(
            tenant=self.tenant, name="site-eng", slug="site-eng", kind="remote"
        )
        self.loc_eng = MonitoringEngine.objects.create(
            tenant=self.tenant, name="loc-eng", slug="loc-eng", kind="remote"
        )

    def test_falls_back_to_local(self):
        self.assertTrue(engine_for_ip(self.ip).is_local)

    def test_tenant_default(self):
        s = MonitoringSettings.for_tenant(self.tenant)
        s.default_engine = self.site_eng
        s.save()
        self.assertEqual(engine_for_ip(self.ip).id, self.site_eng.id)

    def test_site_beats_default(self):
        s = MonitoringSettings.for_tenant(self.tenant)
        s.default_engine = self.loc_eng
        s.save()
        set_binding(self.tenant, "site", self.site.id, self.site_eng)
        self.assertEqual(engine_for_ip(self.ip).id, self.site_eng.id)

    def test_prefix_beats_site_for_subnet_work(self):
        set_binding(self.tenant, "site", self.site.id, self.site_eng)
        set_binding(self.tenant, "prefix", self.prefix.id, self.loc_eng)
        self.assertEqual(engine_for_prefix(self.prefix).id, self.loc_eng.id)
        self.assertEqual(engine_for_ip(self.ip).id, self.loc_eng.id)

    def test_location_beats_site(self):
        set_binding(self.tenant, "site", self.site.id, self.site_eng)
        set_binding(self.tenant, "location", self.location.id, self.loc_eng)
        self.assertEqual(engine_for_ip(self.ip).id, self.loc_eng.id)

    def test_child_location_inherits_parent(self):
        # A child location with no binding falls through to its parent's engine.
        child = Location.objects.create(
            tenant=self.tenant, site=self.site, name="cab-3", slug="cab-3",
            parent=self.location,
        )
        self.dev.location = child
        self.dev.save()
        set_binding(self.tenant, "location", self.location.id, self.loc_eng)
        self.assertEqual(engine_for_ip(self.ip).id, self.loc_eng.id)

    def test_disabled_engine_ignored(self):
        set_binding(self.tenant, "site", self.site.id, self.site_eng)
        self.site_eng.enabled = False
        self.site_eng.save()
        self.assertTrue(engine_for_ip(self.ip).is_local)

    def test_materialise_stamps_engine(self):
        set_binding(self.tenant, "prefix", self.prefix.id, self.site_eng)
        tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind="icmp"
        )
        CheckAssignment.objects.create(
            tenant=self.tenant, template=tmpl, ip_address=self.ip
        )
        materialise_ip(self.ip)
        state = CheckState.objects.get(target_ip=self.ip, template=tmpl)
        self.assertEqual(state.engine_id, self.site_eng.id)


class EngineApiTests(_Base):
    def test_list_ensures_local(self):
        r = self.client.get("/api/monitoring/engines/")
        self.assertEqual(r.status_code, 200)
        rows = r.json()["results"] if isinstance(r.json(), dict) else r.json()
        self.assertTrue(any(e["kind"] == "local" for e in rows))

    def test_create_remote_and_enroll_once(self):
        r = self.client.post(
            "/api/monitoring/engines/",
            {"name": "Outpost AMS", "description": "branch"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        eng = r.json()
        self.assertEqual(eng["kind"], "remote")
        self.assertFalse(eng["token_set"])
        # Enroll returns the token exactly once.
        r2 = self.client.post(f"/api/monitoring/engines/{eng['id']}/enroll/")
        self.assertEqual(r2.status_code, 200, r2.content)
        self.assertTrue(r2.json()["token"])
        # Now token_set is true but the value is never read back.
        r3 = self.client.get(f"/api/monitoring/engines/{eng['id']}/")
        self.assertTrue(r3.json()["token_set"])
        self.assertNotIn("token", r3.json())

    def test_cannot_delete_local(self):
        local = MonitoringEngine.local_for(self.tenant)
        r = self.client.delete(f"/api/monitoring/engines/{local.id}/")
        self.assertIn(r.status_code, (400, 403))

    def test_non_admin_can_read_but_not_mutate(self):
        user = User.objects.create_user("plain", "p@b.c", "pw")
        self._login(user)
        # Read is allowed (the site/location forms need the picker list)…
        self.assertEqual(self.client.get("/api/monitoring/engines/").status_code, 200)
        # …but creating/enrolling requires admin.
        self.assertEqual(
            self.client.post(
                "/api/monitoring/engines/", {"name": "x"}, format="json"
            ).status_code,
            403,
        )


class EngineBindingApiTests(_Base):
    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(tenant=self.tenant, name="dc-ams")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.42.0.0/24", site=self.site,
            status=status_for(self.tenant, "container"),
        )
        self.eng = MonitoringEngine.objects.create(
            tenant=self.tenant, name="ams", slug="ams", kind="remote"
        )

    def test_get_empty_then_set_then_clear(self):
        base = f"/api/monitoring/engine-binding/site/{self.site.id}/"
        self.assertIsNone(self.client.get(base).json()["engine_id"])
        r = self.client.put(base, {"engine_id": str(self.eng.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["engine_id"], str(self.eng.id))
        self.assertEqual(self.client.get(base).json()["engine_id"], str(self.eng.id))
        self.assertEqual(
            MonitoringEngineBinding.objects.filter(tenant=self.tenant).count(), 1
        )
        # Clear → inherit.
        self.client.put(base, {"engine_id": None}, format="json")
        self.assertIsNone(self.client.get(base).json()["engine_id"])

    def test_prefix_binding_endpoint(self):
        base = f"/api/monitoring/engine-binding/prefix/{self.prefix.id}/"
        self.assertIsNone(self.client.get(base).json()["engine_id"])
        r = self.client.put(base, {"engine_id": str(self.eng.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["engine_id"], str(self.eng.id))


class OutpostApiTests(_Base):
    """The pull transport: an enrolled Outpost pulls its due checks and posts
    results, which flow through the same ingest path as the local worker."""

    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(tenant=self.tenant, name="branch")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/24", site=self.site,
            status=status_for(self.tenant, "container"),
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.5", prefix=self.prefix,
            site=self.site,
        )
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch-op", slug="branch-op",
            kind="remote", transport="pull", token={"secret": "tkn-abc"},
        )
        set_binding(self.tenant, "site", self.site.id, self.engine)
        self.tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind="icmp"
        )
        CheckAssignment.objects.create(
            tenant=self.tenant, template=self.tmpl, ip_address=self.ip
        )
        materialise_ip(self.ip)

    def _auth(self, token="tkn-abc"):
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def test_hello_updates_heartbeat(self):
        r = self.client.post(
            "/api/outpost/hello/",
            {"version": "0.0.1", "hostname": "probe-1"},
            format="json", **self._auth(),
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.engine.refresh_from_db()
        self.assertIsNotNone(self.engine.last_seen_at)
        self.assertEqual(self.engine.agent_version, "0.0.1")
        self.assertEqual(self.engine.agent_hostname, "probe-1")

    def test_hello_offers_golden_update_when_auto_update_on(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        from monitoring.models import OutpostRelease

        OutpostRelease.objects.create(
            version="9.9.9", source="file", is_default=True,
            artifact=SimpleUploadedFile("danbyte-outpost", b"GOLDEN"),
        )

        def hello(ver):
            return self.client.post(
                "/api/outpost/hello/", {"version": ver, "hostname": "h"},
                format="json", **self._auth(),
            ).json()["update_to"]

        # Auto-update off → never offered.
        self.assertIsNone(hello("0.0.1"))
        # On + behind the golden version → offered.
        self.engine.auto_update = True
        self.engine.save()
        self.assertEqual(hello("0.0.1"), "9.9.9")
        # Already on the golden version → not offered (handles the v-prefix).
        self.assertIsNone(hello("v9.9.9"))

    def test_bad_token_rejected(self):
        self.assertEqual(
            self.client.get("/api/outpost/work/", **self._auth("wrong")).status_code,
            401,
        )

    def test_work_then_results_roundtrip(self):
        r = self.client.get("/api/outpost/work/", **self._auth())
        self.assertEqual(r.status_code, 200, r.content)
        checks = r.json()["checks"]
        self.assertEqual(len(checks), 1)
        self.assertEqual(checks[0]["kind"], "icmp")
        self.assertEqual(checks[0]["target"], "10.9.0.5")
        sid = checks[0]["state_id"]
        self.assertTrue(CheckState.objects.get(id=sid).in_flight)  # claimed
        # A second poll returns nothing — already claimed.
        self.assertEqual(
            len(self.client.get("/api/outpost/work/", **self._auth()).json()["checks"]),
            0,
        )
        # Report → ingested via the shared finalise path.
        r2 = self.client.post(
            "/api/outpost/results/",
            {"results": [{"state_id": sid, "status": "up", "latency_ms": 1.2}]},
            format="json", **self._auth(),
        )
        self.assertEqual(r2.json()["ingested"], 1)
        state = CheckState.objects.get(id=sid)
        self.assertEqual(state.status, "up")
        self.assertFalse(state.in_flight)
        self.assertEqual(CheckResult.objects.filter(target_ip=self.ip).count(), 1)

    def test_policy_profile_materialises_to_outpost_work(self):
        CheckAssignment.objects.filter(ip_address=self.ip).delete()
        CheckState.objects.filter(target_ip=self.ip).delete()
        profile = MonitoringProfile.objects.create(
            tenant=self.tenant, name="Default ping", slug="default-ping"
        )
        profile.templates.add(self.tmpl)
        policy = MonitoringPolicy.objects.create(
            tenant=self.tenant,
            scope=MonitoringPolicy.SCOPE_PREFIX,
            prefix=self.prefix,
            enabled=True,
        )
        policy.profiles.add(profile)

        materialise_ip(self.ip)
        state = CheckState.objects.get(target_ip=self.ip, template=self.tmpl)
        self.assertEqual(state.engine_id, self.engine.id)
        self.assertIsNone(state.assignment_id)

        r = self.client.get("/api/outpost/work/", **self._auth())
        self.assertEqual(r.status_code, 200, r.content)
        checks = r.json()["checks"]
        self.assertEqual(len(checks), 1)
        self.assertEqual(checks[0]["target"], "10.9.0.5")

    def test_scoped_to_own_engine(self):
        # A different Outpost's token gets none of this engine's work.
        MonitoringEngine.objects.create(
            tenant=self.tenant, name="o2", slug="o2", kind="remote",
            transport="pull", token={"secret": "other"},
        )
        mine = self.client.get("/api/outpost/work/", **self._auth()).json()["checks"]
        theirs = self.client.get(
            "/api/outpost/work/", HTTP_AUTHORIZATION="Bearer other"
        ).json()["checks"]
        self.assertEqual(len(mine), 1)
        self.assertEqual(len(theirs), 0)

    def test_local_dispatch_ignores_remote(self):
        from .scheduler import dispatch

        # The remote state is due, but dispatch (local RQ) must not claim it.
        res = dispatch(sync=True)
        self.assertEqual(res["due"], 0)
        self.assertFalse(CheckState.objects.get(target_ip=self.ip).in_flight)

    def test_stats_endpoint(self):
        r = self.client.get(f"/api/monitoring/engines/{self.engine.id}/stats/")
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual(d["total_checks"], 1)
        self.assertEqual([s["name"] for s in d["sites"]], ["branch"])


class SshTransportTests(_Base):
    """The SSH transport: Danbyte claims the engine's work, runs it over SSH
    (injected here), and ingests — the same finalise path as pull."""

    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(tenant=self.tenant, name="airgap")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.8.0.0/24", site=self.site,
            status=status_for(self.tenant, "container"),
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.8.0.5", prefix=self.prefix,
            site=self.site,
        )
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="ssh-op", slug="ssh-op", kind="remote",
            transport="ssh", ssh_host="10.8.0.1", ssh_user="danbyte",
            ssh_credential={"private_key": "KEY"},
        )
        set_binding(self.tenant, "site", self.site.id, self.engine)
        tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind="icmp"
        )
        CheckAssignment.objects.create(
            tenant=self.tenant, template=tmpl, ip_address=self.ip
        )
        materialise_ip(self.ip)

    def test_ssh_configured_flag(self):
        self.assertTrue(self.engine.ssh_configured)
        bare = MonitoringEngine.objects.create(
            tenant=self.tenant, name="ssh-x", slug="ssh-x",
            kind="remote", transport="ssh",
        )
        self.assertFalse(bare.ssh_configured)

    def test_drive_claims_runs_ingests(self):
        from monitoring.outpost_ssh import drive_ssh_engine

        seen = {}

        def fake_ssh(checks):
            seen["checks"] = checks
            return [
                {"state_id": c["state_id"], "status": "up", "latency_ms": 0.5}
                for c in checks
            ]

        r = drive_ssh_engine(self.engine, run_ssh=fake_ssh)
        self.assertEqual(r["ran"], 1)
        self.assertEqual(r["ingested"], 1)
        self.assertEqual(seen["checks"][0]["target"], "10.8.0.5")
        self.assertEqual(seen["checks"][0]["kind"], "icmp")
        st = CheckState.objects.get(target_ip=self.ip)
        self.assertEqual(st.status, "up")
        self.assertFalse(st.in_flight)
        self.engine.refresh_from_db()
        self.assertIsNotNone(self.engine.last_seen_at)

    def test_known_hosts_pins_when_key_set(self):
        from monitoring.outpost_ssh import _connect_kwargs, _known_hosts_entry

        self.engine.ssh_host_key = "ssh-ed25519 AAAAC3Nz"
        self.engine.ssh_port = 22
        self.assertEqual(
            _known_hosts_entry(self.engine), b"10.8.0.1 ssh-ed25519 AAAAC3Nz\n"
        )
        # Non-standard port uses the [host]:port form.
        self.engine.ssh_port = 2222
        self.assertEqual(
            _known_hosts_entry(self.engine),
            b"[10.8.0.1]:2222 ssh-ed25519 AAAAC3Nz\n",
        )
        # And a password engine's connect kwargs carry the pin.
        self.engine.ssh_port = 22
        self.engine.ssh_credential = {"password": "pw"}
        kw = _connect_kwargs(self.engine)
        self.assertEqual(kw["known_hosts"], b"10.8.0.1 ssh-ed25519 AAAAC3Nz\n")
        self.assertEqual(kw["password"], "pw")

    def test_known_hosts_tofu_when_key_unset(self):
        from monitoring.outpost_ssh import _known_hosts_entry

        self.engine.ssh_host_key = ""
        self.assertIsNone(_known_hosts_entry(self.engine))

    def test_api_sets_ssh_without_leaking_credential(self):
        r = self.client.post(
            "/api/monitoring/engines/",
            {"name": "SSH box", "transport": "ssh"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        eid = r.json()["id"]
        r2 = self.client.patch(
            f"/api/monitoring/engines/{eid}/",
            {
                "ssh_host": "10.9.0.1", "ssh_user": "danbyte",
                "ssh_credential": {"private_key": "SECRET"},
            },
            format="json",
        )
        self.assertEqual(r2.status_code, 200, r2.content)
        # ssh_configured true, credential never read back.
        got = self.client.get(f"/api/monitoring/engines/{eid}/").json()
        self.assertTrue(got["ssh_configured"])
        self.assertEqual(got["ssh_host"], "10.9.0.1")
        self.assertNotIn("ssh_credential", got)


class PackageStoreTests(_Base):
    """Upload/register Outpost builds; generate the version-pinned installer and
    serve the artifact (Outpost-token or admin auth)."""

    def _git_release(self, version="1.0.0", default=True):
        return self.client.post(
            "/api/monitoring/outpost-releases/",
            {
                "version": version, "source": "git",
                "git_url": "https://github.com/acme/danbyte-outpost",
                "git_ref": "v1.0.0", "is_default": default,
            },
            format="json",
        )

    def _file_release(self, version="2.0.0"):
        from django.core.files.uploadedfile import SimpleUploadedFile

        f = SimpleUploadedFile(
            "danbyte-outpost-2.0.0.tar.gz", b"BUILD-BYTES",
            content_type="application/gzip",
        )
        return self.client.post(
            "/api/monitoring/outpost-releases/",
            {"version": version, "source": "file", "artifact": f},
            format="multipart",
        )

    def test_git_release_install_script(self):
        self.assertEqual(self._git_release().status_code, 201)
        r = self.client.get("/api/outpost/install.sh?v=1.0.0")
        self.assertEqual(r.status_code, 200)
        body = r.content.decode()
        self.assertIn("git+https://github.com/acme/danbyte-outpost@v1.0.0", body)
        self.assertIn("danbyte-outpost run $RUNARGS", body)
        # Token/URL go in a root-only 0600 env file, NOT on the command line —
        # the agent reads OUTPOST_URL/OUTPOST_TOKEN from the environment, so the
        # token never lands in the unit file or the process argv (ps).
        self.assertNotIn("--token=$TOKEN", body)
        self.assertIn("OUTPOST_TOKEN=$TOKEN", body)
        self.assertIn("EnvironmentFile=/etc/danbyte-outpost/env", body)
        self.assertIn("chmod 600 /etc/danbyte-outpost/env", body)
        self.assertIn("--insecure) INSECURE=1", body)  # self-signed support

    def test_file_release_upload_and_download(self):
        r = self._file_release()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["size_bytes"], len(b"BUILD-BYTES"))
        self.assertTrue(r.json()["has_artifact"])
        self.assertNotIn("artifact", r.json())  # write-only
        # A .tar.gz file release installs via pip in a venv.
        script = self.client.get("/api/outpost/install.sh?v=2.0.0").content.decode()
        self.assertIn("/api/outpost/download/2.0.0/", script)
        self.assertIn("python3 -m venv", script)
        # Admin (superuser session) can download the artifact.
        d = self.client.get("/api/outpost/download/2.0.0/")
        self.assertEqual(d.status_code, 200)
        self.assertEqual(b"".join(d.streaming_content), b"BUILD-BYTES")

    def test_binary_release_install_script(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        f = SimpleUploadedFile(
            "danbyte-outpost", b"\x7fELFbinary", content_type="application/octet-stream"
        )
        r = self.client.post(
            "/api/monitoring/outpost-releases/",
            {"version": "3.0.0", "source": "file", "artifact": f},
            format="multipart",
        )
        self.assertEqual(r.status_code, 201, r.content)
        script = self.client.get("/api/outpost/install.sh?v=3.0.0").content.decode()
        # A bare binary → download to .new + atomic mv (avoids text-file-busy on
        # update) + run directly, no Python venv; and a real restart.
        self.assertIn('mv -f "$PREFIX/danbyte-outpost.new" "$PREFIX/danbyte-outpost"', script)
        self.assertIn("$PREFIX/danbyte-outpost run", script)
        self.assertNotIn("python3 -m venv", script)
        self.assertIn("systemctl restart danbyte-outpost", script)

    def test_download_requires_auth(self):
        self._file_release()
        from rest_framework.test import APIClient

        anon = APIClient()  # no session, no token
        self.assertEqual(anon.get("/api/outpost/download/2.0.0/").status_code, 401)
        # A valid Outpost token is accepted.
        MonitoringEngine.objects.create(
            tenant=self.tenant, name="op", slug="op", kind="remote",
            transport="pull", token={"secret": "dl-token"},
        )
        self.assertEqual(
            anon.get(
                "/api/outpost/download/2.0.0/", HTTP_AUTHORIZATION="Bearer dl-token"
            ).status_code,
            200,
        )

    def test_fetch_binary_from_github_release(self):
        from unittest.mock import patch

        with patch(
            "monitoring.viewsets._fetch_github_binary",
            return_value=("danbyte-outpost", b"\x7fELFDATA"),
        ):
            r = self.client.post(
                "/api/monitoring/outpost-releases/fetch_binary/",
                {"git_url": "https://github.com/acme/danbyte-outpost", "ref": "v0.2.0"},
                format="json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["version"], "v0.2.0")
        self.assertTrue(r.json()["has_artifact"])
        self.assertEqual(r.json()["size_bytes"], len(b"\x7fELFDATA"))
        # Stored as a binary file → the installer is binary-aware.
        script = self.client.get(
            "/api/outpost/install.sh?v=v0.2.0"
        ).content.decode()
        self.assertIn("chmod +x", script)
        self.assertNotIn("python3 -m venv", script)

    def test_available_lists_configured_repo_releases(self):
        from unittest.mock import patch

        s = MonitoringSettings.for_tenant(self.tenant)
        s.outpost_repo_url = "https://github.com/acme/danbyte-outpost"
        s.save()
        # Import 0.1.0 already so it's marked imported.
        self._git_release("0.1.0", default=False)
        fake = [
            {"tag": "v0.2.0", "name": "v0.2.0", "has_binary": True},
            {"tag": "0.1.0", "name": "0.1.0", "has_binary": True},
        ]
        with patch(
            "monitoring.viewsets._list_github_releases", return_value=fake
        ):
            r = self.client.get("/api/monitoring/outpost-releases/available/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["repo_url"], "https://github.com/acme/danbyte-outpost")
        tags = {v["tag"]: v["imported"] for v in body["versions"]}
        self.assertFalse(tags["v0.2.0"])
        self.assertTrue(tags["0.1.0"])

    def test_fetch_binary_uses_configured_repo(self):
        from unittest.mock import patch

        s = MonitoringSettings.for_tenant(self.tenant)
        s.outpost_repo_url = "https://github.com/acme/danbyte-outpost"
        s.outpost_repo_token = {"token": "ghp_secret"}
        s.save()
        with patch(
            "monitoring.viewsets._fetch_github_binary",
            return_value=("danbyte-outpost", b"\x7fELF"),
        ) as m:
            r = self.client.post(
                "/api/monitoring/outpost-releases/fetch_binary/",
                {"ref": "v0.2.0"},  # no git_url → from settings
                format="json",
            )
        self.assertEqual(r.status_code, 201, r.content)
        # The configured repo + token were used.
        args = m.call_args[0]
        self.assertEqual(args[0], "https://github.com/acme/danbyte-outpost")
        self.assertEqual(args[2], "ghp_secret")

    def test_default_release_and_admin_gate(self):
        self._git_release("1.0.0", default=True)
        # No ?v → the default.
        self.assertEqual(self.client.get("/api/outpost/install.sh").status_code, 200)
        # Non-admins can't manage releases.
        user = User.objects.create_user("plain", "p@b.c", "pw")
        self._login(user)
        self.assertEqual(
            self.client.get("/api/monitoring/outpost-releases/").status_code, 403
        )


class OutpostSnmpTests(_Base):
    """SNMP discovery over the Outpost: the agent pulls the site's devices +
    scoped creds, fetches facts remotely, and posts them back — persisted
    through the same path as a local poll."""

    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(tenant=self.tenant, name="branch")
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="branch-op", slug="branch-op",
            kind="remote", transport="pull", token={"secret": "snmp-tok"},
        )
        set_binding(self.tenant, "site", self.site.id, self.engine)
        self.device = Device.objects.create(
            tenant=self.tenant, name="r1", site=self.site
        )
        self.profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="prod", slug="prod", version="v2c",
            secret_params={"community": "public"},
        )
        SnmpProfileBinding.objects.create(
            tenant=self.tenant, scope="site", object_id=self.site.id,
            profile=self.profile,
        )

    def _auth(self, token="snmp-tok"):
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def test_snmp_work_lists_site_devices_with_creds(self):
        r = self.client.get("/api/outpost/snmp-work/", **self._auth())
        self.assertEqual(r.status_code, 200, r.content)
        devices = r.json()["devices"]
        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0]["device_id"], str(self.device.id))
        self.assertEqual(devices[0]["target"], "r1")  # no primary_ip → name
        self.assertEqual(devices[0]["secret_params"]["community"], "public")

    def test_snmp_results_persist_device_snmp(self):
        payload = {"results": [{
            "device_id": str(self.device.id),
            "data": {"sys_name": "r1.example"},
            "interfaces": [{"if_index": "1", "name": "Gi0/1"}],
            "neighbors": [], "arp": [], "reachable": True, "error": "",
        }]}
        r = self.client.post(
            "/api/outpost/snmp/", payload, format="json", **self._auth()
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["ingested"], 1)
        snmp = DeviceSnmp.objects.get(device=self.device)
        self.assertTrue(snmp.reachable)
        self.assertEqual(snmp.data["sys_name"], "r1.example")
        self.assertEqual(snmp.interfaces[0]["name"], "Gi0/1")
        self.assertEqual(snmp.profile_id, self.profile.id)

    def test_snmp_results_ignore_foreign_device(self):
        other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        foreign = Device.objects.create(tenant=other, name="x")
        r = self.client.post(
            "/api/outpost/snmp/",
            {"results": [{"device_id": str(foreign.id), "reachable": True}]},
            format="json", **self._auth(),
        )
        self.assertEqual(r.json()["ingested"], 0)
        self.assertFalse(DeviceSnmp.objects.filter(device=foreign).exists())

    def test_snmp_work_excludes_other_engine_devices(self):
        # A device at a different site (no binding to our engine) isn't included.
        other_site = Site.objects.create(tenant=self.tenant, name="hq")
        Device.objects.create(tenant=self.tenant, name="hq1", site=other_site)
        devices = self.client.get(
            "/api/outpost/snmp-work/", **self._auth()
        ).json()["devices"]
        self.assertEqual([d["device_id"] for d in devices], [str(self.device.id)])


class OutpostSweepTests(_Base):
    """Subnet discovery over the Outpost: the agent sweeps its site's prefixes
    and posts live IPs, which are created on the core like a local sweep."""

    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(tenant=self.tenant, name="branch")
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="op", slug="op", kind="remote",
            transport="pull", token={"secret": "sweep-tok"},
        )
        set_binding(self.tenant, "site", self.site.id, self.engine)
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.7.0.0/30", site=self.site,
            status=status_for(self.tenant, "container"), auto_discover=True,
        )
        s = MonitoringSettings.for_tenant(self.tenant)
        s.discovery_enabled = True
        s.discovery_min_prefix_length = 8
        s.save()

    def _auth(self, token="sweep-tok"):
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def test_sweep_work_lists_engine_prefixes(self):
        from monitoring.discovery import sweep_work_for_engine

        work = sweep_work_for_engine(self.engine)
        self.assertEqual([w["cidr"] for w in work], ["10.7.0.0/30"])
        r = self.client.get("/api/outpost/sweep-work/", **self._auth())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["prefixes"]), 1)

    def test_discovered_creates_ips(self):
        from api.models import IPAddress

        r = self.client.post(
            "/api/outpost/discovered/",
            {"results": [{"prefix_id": str(self.prefix.id),
                          "alive": ["10.7.0.1", "10.7.0.2"]}]},
            format="json", **self._auth(),
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 2)
        self.assertEqual(
            IPAddress.objects.filter(prefix=self.prefix, discovered=True).count(), 2
        )

    def test_sweep_work_excludes_denied_prefix(self):
        MonitoringDenySubnet.objects.create(
            tenant=self.tenant, cidr="10.7.0.0/30"
        )
        r = self.client.get("/api/outpost/sweep-work/", **self._auth())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["prefixes"], [])

    def test_discovered_filters_denied_alive_ips(self):
        from api.models import IPAddress

        MonitoringDenySubnet.objects.create(
            tenant=self.tenant, cidr="10.7.0.1/32"
        )
        r = self.client.post(
            "/api/outpost/discovered/",
            {
                "results": [
                    {
                        "prefix_id": str(self.prefix.id),
                        "alive": ["10.7.0.1", "10.7.0.2"],
                    }
                ]
            },
            format="json",
            **self._auth(),
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 1)
        self.assertFalse(
            IPAddress.objects.filter(prefix=self.prefix, ip_address="10.7.0.1").exists()
        )
        self.assertTrue(
            IPAddress.objects.filter(prefix=self.prefix, ip_address="10.7.0.2").exists()
        )

    def test_core_run_discovery_skips_remote_prefix(self):
        from monitoring.discovery import run_discovery

        # The prefix resolves to a remote engine → the core leaves it alone
        # (no real ICMP sweep runs).
        res = run_discovery()
        self.assertEqual(res["prefixes"], 0)


class OutpostDiscoverButtonTests(_Base):
    """The Discover-now button routes a remote-Outpost prefix to the Outpost
    (flag + poke) instead of a useless core sweep."""

    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(tenant=self.tenant, name="branch")
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="op", slug="op", kind="remote",
            transport="pull", token={"secret": "disc-tok"},
        )
        set_binding(self.tenant, "site", self.site.id, self.engine)
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.6.0.0/30", site=self.site,
            status=status_for(self.tenant, "container"),
        )
        s = MonitoringSettings.for_tenant(self.tenant)
        s.discovery_min_prefix_length = 8
        s.save()

    def test_button_routes_to_outpost(self):
        r = self.client.post(
            f"/api/monitoring/prefixes/{self.prefix.id}/discover/", {},
            format="json",
        )
        self.assertEqual(r.status_code, 202, r.content)
        self.assertTrue(r.json()["queued_on_outpost"])
        self.assertEqual(r.json()["engine"]["name"], "op")
        self.engine.refresh_from_db()
        self.assertIsNotNone(self.engine.sweep_requested_at)

    def test_work_signals_sweep_pending_then_sweep_work_clears(self):
        self.engine.sweep_requested_at = __import__("django.utils.timezone",
            fromlist=["now"]).now()
        self.engine.save()
        auth = {"HTTP_AUTHORIZATION": "Bearer disc-tok"}
        w = self.client.get("/api/outpost/work/", **auth)
        self.assertTrue(w.json()["sweep_pending"])
        # Fetching sweep-work clears the request.
        self.client.get("/api/outpost/sweep-work/", **auth)
        self.engine.refresh_from_db()
        self.assertIsNone(self.engine.sweep_requested_at)


class EngineHealthTests(_Base):
    """Dispatcher health sweep + banner endpoint (issue #154)."""

    def setUp(self):
        super().setUp()
        from datetime import timedelta

        from django.utils import timezone

        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant,
            name="Home",
            slug="home",
            kind="remote",
            poll_interval_seconds=60,
        )
        self.prefix = Prefix.objects.create(
            tenant=self.tenant,
            cidr="10.0.0.0/24",
            status=status_for(self.tenant),
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.1", prefix=self.prefix
        )
        self.tmpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="ping", slug="ping", kind="icmp"
        )
        self.state = CheckState.objects.create(
            tenant=self.tenant,
            target_ip=self.ip,
            template=self.tmpl,
            kind="icmp",
            engine=self.engine,
            next_run=timezone.now() - timedelta(minutes=5),
        )

    def _sweep(self, now=None):
        from .scheduler import check_engine_health

        return check_engine_health(now)

    def test_never_seen_engine_goes_stale_after_grace(self):
        from datetime import timedelta

        from django.utils import timezone

        # Inside the grace window (3× interval, min 180s) → healthy.
        r = self._sweep(self.engine.created_at + timedelta(seconds=60))
        self.assertEqual(r, {"flagged": 0, "recovered": 0})
        # Past the window → flagged once, not twice.
        later = timezone.now() + timedelta(seconds=400)
        self.assertEqual(self._sweep(later)["flagged"], 1)
        self.engine.refresh_from_db()
        self.assertIsNotNone(self.engine.stale_since)
        self.assertEqual(self._sweep(later)["flagged"], 0)

    def test_recovery_clears_flag(self):
        from datetime import timedelta

        from django.utils import timezone

        now = timezone.now()
        self._sweep(now + timedelta(seconds=400))
        # Outpost polls again.
        self.engine.refresh_from_db()
        self.engine.last_seen_at = now + timedelta(seconds=500)
        self.engine.save(update_fields=["last_seen_at"])
        r = self._sweep(now + timedelta(seconds=520))
        self.assertEqual(r["recovered"], 1)
        self.engine.refresh_from_db()
        self.assertIsNone(self.engine.stale_since)

    def test_engine_without_checks_never_flags(self):
        from datetime import timedelta

        from django.utils import timezone

        idle = MonitoringEngine.objects.create(
            tenant=self.tenant, name="Idle", slug="idle", kind="remote"
        )
        self._sweep(timezone.now() + timedelta(days=1))
        idle.refresh_from_db()
        self.assertIsNone(idle.stale_since)

    def test_health_endpoint(self):
        from datetime import timedelta

        from django.utils import timezone

        self._sweep(timezone.now() + timedelta(seconds=400))
        res = self.client.get("/api/monitoring/engine-health/")
        self.assertEqual(res.status_code, 200)
        stale = res.json()["stale_engines"]
        self.assertEqual(len(stale), 1)
        self.assertEqual(stale[0]["name"], "Home")
        self.assertEqual(stale[0]["stalled_checks"], 1)
