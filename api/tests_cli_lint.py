"""The CLI check on a rendered config (#465): vocabulary, "did you mean",
ignores, and learning only from this tenant's configs."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations.models import ConfigPush, DeviceConfigState

from . import cli_lint
from .models import Device, ExportTemplate, Platform, Site

User = get_user_model()

RENDER = """\
hostname sw1
!
snmp-server comunity public RO
snmp-server location HQ
no ip domain-lookup
int Gi0/1
 description uplink
 shutdown
banner motd ^C
anything goes here
^C
vendor-magic on
"""


class CheckTextTests(SimpleTestCase):
    def vocab(self, learned=None):
        return cli_lint.vocabulary("ios", learned or {})

    def test_typo_in_an_option_with_a_hint(self):
        warnings = cli_lint.check_text(RENDER, self.vocab())
        by_line = {w["line"]: w for w in warnings}
        self.assertEqual(by_line[3]["suggestion"], "community")
        self.assertIn("did you mean 'community'", by_line[3]["message"])
        # Known commands, an abbreviation, a ``no`` prefix, sub-mode lines
        # and the banner body pass.
        self.assertEqual(set(by_line), {3, 12})
        self.assertEqual(by_line[12]["keyword"], "vendor-magic")
        self.assertIsNone(by_line[12]["suggestion"])

    def test_unknown_command_hint(self):
        warnings = cli_lint.check_text("hostnme sw1\n", self.vocab())
        self.assertEqual(warnings[0]["suggestion"], "hostname")

    def test_learned_commands_are_known(self):
        learned = {}
        cli_lint.learn("vendor-magic off\nsnmp-server comunity x\n", learned)
        warnings = cli_lint.check_text(RENDER, self.vocab(learned))
        self.assertEqual(warnings, [])

    def test_patterns(self):
        warnings = cli_lint.check_text(
            RENDER, self.vocab(), patterns=["vendor-magic", "snmp-server com*"],
        )
        self.assertEqual(warnings, [])
        warnings = cli_lint.check_text(RENDER, self.vocab(), patterns=["VENDOR-MAGIC ON"])
        self.assertEqual([w["line"] for w in warnings], [3])

    def test_inline_marker(self):
        code = (
            "hostname {{ device.name }}\n"
            "vendor-magic {{ x }} {# lint: ignore #}\n"
            "{{ raw }} {# lint: ignore #}\n"
        )
        prefixes = cli_lint.inline_ignores(code)
        self.assertEqual(prefixes, ["vendor-magic"])
        warnings = cli_lint.check_text(RENDER, self.vocab(), prefixes=prefixes)
        self.assertEqual([w["line"] for w in warnings], [3])

    def test_clean_patterns(self):
        self.assertEqual(cli_lint.clean_patterns([" a ", "a", "", "b*"]), ["a", "b*"])
        for bad in ("x", [1], ["x" * 201], ["p"] * 101):
            with self.assertRaises(ValueError):
                cli_lint.clean_patterns(bad)


class LintEndpointTests(APITestCase):
    def setUp(self):
        cache.clear()
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.rival = Tenant.objects.create(org=org, name="Rival", slug="rival")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.login(self.admin)
        self.tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="ios", object_type="device",
            template_code="hostname {{ device.name }}\n",
        )
        self.platform = Platform.objects.create(
            tenant=self.tenant, name="Cisco IOS-XE", slug="cisco-ios-xe",
            config_template=self.tmpl,
        )
        site = Site.objects.create(tenant=self.tenant, name="HQ")
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", site=site, platform=self.platform,
        )

    def login(self, user, tenant=None):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str((tenant or self.tenant).id)
        s.save()

    def lint(self, output, tmpl=None):
        tmpl = tmpl or self.tmpl
        return self.client.post(
            f"/api/export-templates/{tmpl.id}/lint/", {"output": output}, format="json"
        )

    def test_family_from_the_platform_and_warnings(self):
        r = self.lint("hostname a\nsnmp-server comunity x RO\n")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["family"], "ios")
        self.assertEqual(body["warnings"][0]["line"], 2)

    def test_off_and_unknown_family(self):
        self.tmpl.lint_family = "off"
        self.tmpl.save()
        self.assertEqual(self.lint("bogus\n").json()["warnings"], [])
        self.tmpl.lint_family = ""
        self.tmpl.save()
        self.platform.name, self.platform.slug = "Debian", "debian"
        self.platform.save()
        self.assertEqual(self.lint("bogus\n").json()["family"], "")

    def test_stored_patterns_apply(self):
        r = self.client.patch(f"/api/export-templates/{self.tmpl.id}/",
                              {"ignore_lint_patterns": ["bogus"]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["ignore_lint_patterns"], ["bogus"])
        self.assertEqual(self.lint("bogus 1\n").json()["warnings"], [])
        r = self.client.patch(f"/api/export-templates/{self.tmpl.id}/",
                              {"ignore_lint_patterns": "bogus"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_learns_from_this_tenant_only(self):
        ConfigPush.objects.create(
            tenant=self.tenant, device=self.device, path="cfg", sha256="x",
            output="vendor-magic on\n", pushed_at=timezone.now(),
        )
        # Another tenant's running config teaches nothing here.
        rsite = Site.objects.create(tenant=self.rival, name="R")
        rplat = Platform.objects.create(tenant=self.rival, name="IOS", slug="ios")
        rdev = Device.objects.create(tenant=self.rival, name="r1", site=rsite, platform=rplat)
        DeviceConfigState.objects.create(
            tenant=self.rival, device=rdev, template=self.tmpl,
            actual_config="rival-secret-cmd 1\n",
        )
        body = self.lint("vendor-magic on\nrival-secret-cmd 1\n").json()
        self.assertEqual([w["keyword"] for w in body["warnings"]], ["rival-secret-cmd"])

    def test_learns_only_from_devices_the_caller_may_view(self):
        DeviceConfigState.objects.create(
            tenant=self.tenant, device=self.device, actual_config="vendor-magic on\n",
        )
        viewer = User.objects.create_user("viewer", "", "x")
        UserProfile.objects.create(user=viewer).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="t", object_types=["exporttemplate"], actions=["view"],
        )
        grant.users.add(viewer)
        self.login(viewer)
        r = self.lint("vendor-magic on\n")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["warnings"]), 1)
        self.login(self.admin)
        self.assertEqual(self.lint("vendor-magic on\n").json()["warnings"], [])

    def test_other_tenant_template_is_not_found(self):
        self.login(self.admin, tenant=self.rival)
        self.assertEqual(self.lint("x\n").status_code, 404)

    def test_bad_payload(self):
        self.assertEqual(self.lint(5).status_code, 400)
