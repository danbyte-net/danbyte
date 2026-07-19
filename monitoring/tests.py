"""Milestone 1 tests — the effective-check resolver and secrets-at-rest.

The resolver's inheritance/override rules are the load-bearing logic of the
whole feature, so they get exhaustive coverage here.
"""
from __future__ import annotations

from django.db import connection
from django.test import TestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from .models import CheckAssignment, CheckKind, CheckTemplate, ScheduleMode
from .resolver import resolve_effective_checks


from api.test_utils import status_for


class ResolverTestBase(TestCase):
    def setUp(self) -> None:
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        # /16 container, /24 inside it.
        self.p16 = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/16", status=status_for(self.tenant, "container")
        )
        self.p24 = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.10.0/24", status=status_for(self.tenant)
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.10.5", prefix=self.p24
        )
        self._slug = 0

    def make_template(self, *, kind=CheckKind.ICMP, enabled=True, **kw) -> CheckTemplate:
        self._slug += 1
        return CheckTemplate.objects.create(
            tenant=self.tenant,
            name=kw.pop("name", f"tmpl-{self._slug}"),
            slug=f"tmpl-{self._slug}",
            kind=kind,
            enabled=enabled,
            **kw,
        )

    def assign_ip(self, template, ip=None, **kw) -> CheckAssignment:
        return CheckAssignment.objects.create(
            tenant=self.tenant, template=template, ip_address=ip or self.ip, **kw
        )

    def assign_prefix(self, template, prefix, **kw) -> CheckAssignment:
        return CheckAssignment.objects.create(
            tenant=self.tenant, template=template, prefix=prefix, **kw
        )


class ResolverInheritanceTests(ResolverTestBase):
    def test_direct_assignment_is_effective(self):
        t = self.make_template()
        self.assign_ip(t)
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0].source, "direct")
        self.assertEqual(resolved[0].template, t)

    def test_prefix_assignment_inherits_to_child_ip(self):
        t = self.make_template()
        self.assign_prefix(t, self.p24)
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0].source, "inherited")
        self.assertEqual(resolved[0].prefix, self.p24)

    def test_container_prefix_also_inherits(self):
        t = self.make_template()
        self.assign_prefix(t, self.p16)
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0].prefix, self.p16)

    def test_apply_to_children_false_does_not_inherit(self):
        t = self.make_template()
        self.assign_prefix(t, self.p24, apply_to_children=False)
        self.assertEqual(resolve_effective_checks(self.ip), [])

    def test_template_disabled_is_never_effective(self):
        t = self.make_template(enabled=False)
        self.assign_ip(t)
        self.assertEqual(resolve_effective_checks(self.ip), [])

    def test_vrf_mismatch_prefix_does_not_enclose(self):
        from api.models import VRF

        vrf = VRF.objects.create(tenant=self.tenant, name="red")
        # Prefix lives in a VRF, the IP is in the Global VRF (NULL) — no match.
        pvrf = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.10.0/24", vrf=vrf, status=status_for(self.tenant)
        )
        t = self.make_template()
        self.assign_prefix(t, pvrf)
        self.assertEqual(resolve_effective_checks(self.ip), [])


class ResolverConflictTests(ResolverTestBase):
    def test_most_specific_prefix_wins(self):
        # Same template assigned at /16 and /24 with different intervals — the
        # /24 (longer mask) wins.
        t = self.make_template(interval_seconds=300)
        self.assign_prefix(t, self.p16, overrides={"interval_seconds": 3600})
        self.assign_prefix(t, self.p24, overrides={"interval_seconds": 900})
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0].prefix, self.p24)
        self.assertEqual(resolved[0].interval_seconds, 900)

    def test_direct_overrides_inherited_same_template(self):
        t = self.make_template(interval_seconds=300)
        self.assign_prefix(t, self.p24, overrides={"interval_seconds": 900})
        self.assign_ip(t, overrides={"interval_seconds": 60})
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0].source, "direct")
        self.assertEqual(resolved[0].interval_seconds, 60)

    def test_per_ip_disable_removes_inherited(self):
        t = self.make_template()
        self.assign_prefix(t, self.p24)
        self.assign_ip(t, enabled=False)  # explicit per-IP disable
        self.assertEqual(resolve_effective_checks(self.ip), [])

    def test_exclusion_removes_inherited(self):
        t = self.make_template()
        a = self.assign_prefix(t, self.p24)
        a.exclusions.add(self.ip)
        self.assertEqual(resolve_effective_checks(self.ip), [])

    def test_exclusion_only_affects_excluded_ip(self):
        other = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.10.6", prefix=self.p24
        )
        t = self.make_template()
        a = self.assign_prefix(t, self.p24)
        a.exclusions.add(self.ip)
        self.assertEqual(resolve_effective_checks(self.ip), [])
        self.assertEqual(len(resolve_effective_checks(other)), 1)

    def test_different_templates_both_effective(self):
        t1 = self.make_template(kind=CheckKind.ICMP)
        t2 = self.make_template(kind=CheckKind.TCP, params={"port": 22})
        self.assign_prefix(t1, self.p16)
        self.assign_ip(t2)
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual(len(resolved), 2)
        kinds = {r.kind for r in resolved}
        self.assertEqual(kinds, {"icmp", "tcp"})


class ResolvedCheckOverlayTests(ResolverTestBase):
    def test_params_shallow_merge(self):
        t = self.make_template(
            kind=CheckKind.HTTP, params={"path": "/", "expected_status": [200]}
        )
        self.assign_ip(t, overrides={"params": {"path": "/health"}})
        r = resolve_effective_checks(self.ip)[0]
        self.assertEqual(r.params["path"], "/health")
        self.assertEqual(r.params["expected_status"], [200])  # template value kept

    def test_threshold_overrides_fall_back_to_template(self):
        t = self.make_template(rise=2, fall=5, timeout_ms=1000)
        self.assign_ip(t, overrides={"fall": 9})
        r = resolve_effective_checks(self.ip)[0]
        self.assertEqual(r.fall, 9)  # overridden
        self.assertEqual(r.rise, 2)  # template default
        self.assertEqual(r.timeout_ms, 1000)


class SecretsAtRestTests(ResolverTestBase):
    def test_secret_params_round_trip(self):
        t = self.make_template(
            kind=CheckKind.SNMP, secret_params={"community": "s3cr3t"}
        )
        t.refresh_from_db()
        self.assertEqual(t.secret_params, {"community": "s3cr3t"})

    def test_secret_params_ciphertext_not_plaintext_in_db(self):
        t = self.make_template(
            kind=CheckKind.SSH, secret_params={"password": "hunter2"}
        )
        with connection.cursor() as cur:
            cur.execute(
                "SELECT secret_params FROM monitoring_checktemplate WHERE id = %s",
                [str(t.id)],
            )
            raw = cur.fetchone()[0]
        self.assertNotIn("hunter2", raw)
        self.assertTrue(raw)  # non-empty ciphertext stored

    def test_empty_secret_params_stays_empty(self):
        t = self.make_template(kind=CheckKind.ICMP)
        t.refresh_from_db()
        self.assertEqual(t.secret_params, {})


class PolicyFrequencyTests(ResolverTestBase):
    """The two-level frequency model: a per-scope MonitoringPolicy interval
    override beats the tenant's global default, most-specific policy wins."""

    def _policy(self, **kw):
        from .models import MonitoringPolicy

        return MonitoringPolicy.objects.create(tenant=self.tenant, **kw)

    def test_policy_interval_stamped_on_resolved_check(self):
        from .models import MonitoringPolicy

        t = self.make_template()
        pol = self._policy(
            scope=MonitoringPolicy.SCOPE_PREFIX, prefix=self.p24, interval_seconds=60
        )
        pol.templates.add(t)
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0].source, "policy")
        # The per-prefix override rides on the resolved check.
        self.assertEqual(resolved[0].interval_seconds, 60)

    def test_more_specific_policy_interval_wins(self):
        from .models import MonitoringPolicy

        t = self.make_template()
        # Global sets 900; the enclosing prefix overrides to 60.
        g = self._policy(scope=MonitoringPolicy.SCOPE_GLOBAL, interval_seconds=900)
        g.templates.add(t)
        p = self._policy(
            scope=MonitoringPolicy.SCOPE_PREFIX, prefix=self.p24, interval_seconds=60
        )
        p.templates.add(t)
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual(resolved[0].interval_seconds, 60)

    def test_no_override_falls_back_to_global_default(self):
        from .models import MonitoringPolicy, MonitoringSettings
        from .worker import effective_interval
        from .scheduler import materialise_ip

        MonitoringSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"default_interval_seconds": 1800}
        )
        t = self.make_template()
        pol = self._policy(scope=MonitoringPolicy.SCOPE_GLOBAL)  # no interval
        pol.templates.add(t)
        materialise_ip(self.ip)
        state = self.ip.check_states.get(template=t)
        self.assertIsNone(state.interval_seconds)
        cfg = {"global_enabled": True, "default_interval": 1800}
        self.assertEqual(effective_interval(state, cfg), 1800)

    def test_override_persisted_and_used_by_scheduler(self):
        from .models import MonitoringPolicy, MonitoringSettings
        from .worker import effective_interval
        from .scheduler import materialise_ip

        MonitoringSettings.objects.update_or_create(
            tenant=self.tenant, defaults={"default_interval_seconds": 1800}
        )
        t = self.make_template()
        pol = self._policy(
            scope=MonitoringPolicy.SCOPE_PREFIX, prefix=self.p24, interval_seconds=60
        )
        pol.templates.add(t)
        materialise_ip(self.ip)
        state = self.ip.check_states.get(template=t)
        self.assertEqual(state.interval_seconds, 60)
        cfg = {"global_enabled": True, "default_interval": 1800}
        self.assertEqual(effective_interval(state, cfg), 60)


class PolicyTargetTests(TestCase):
    """Device/type/role policies apply only to the IPs their `target` selects."""

    def setUp(self):
        from api.models import Device, DeviceType, Interface, Manufacturer

        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt
        )
        self.iface = Interface.objects.create(device=self.device, name="eth0")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        # primary (on the interface), an interface-less assigned IP, and an OOB IP.
        self.primary = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.1", prefix=self.prefix,
            assigned_device=self.device, assigned_interface=self.iface,
        )
        self.plain = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.2", prefix=self.prefix,
            assigned_device=self.device,
        )
        self.oob = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.3", prefix=self.prefix,
            assigned_device=self.device,
        )
        self.device.primary_ip = self.primary
        self.device.oob_ip = self.oob
        self.device.save()
        self._n = 0

    def _template(self):
        self._n += 1
        return CheckTemplate.objects.create(
            tenant=self.tenant, name=f"t{self._n}", slug=f"t{self._n}",
            kind=CheckKind.ICMP,
        )

    def _policy(self, target, scope=None, **kw):
        from .models import MonitoringPolicy

        scope = scope or MonitoringPolicy.SCOPE_DEVICE
        if scope == MonitoringPolicy.SCOPE_DEVICE:
            kw.setdefault("device", self.device)
        elif scope == MonitoringPolicy.SCOPE_DEVICE_TYPE:
            kw.setdefault("device_type", self.dt)
        pol = MonitoringPolicy.objects.create(
            tenant=self.tenant, scope=scope, target=target, enabled=True, **kw
        )
        pol.templates.add(self._template())
        return pol

    def _applies(self, ip, pol):
        tids = {r.template.id for r in resolve_effective_checks(ip)}
        return set(pol.templates.values_list("id", flat=True)) <= tids

    def test_target_all_hits_every_device_ip(self):
        from .models import MonitoringPolicy

        pol = self._policy(MonitoringPolicy.TARGET_ALL)
        for ip in (self.primary, self.plain, self.oob):
            self.assertTrue(self._applies(ip, pol))

    def test_target_primary_only(self):
        from .models import MonitoringPolicy

        pol = self._policy(MonitoringPolicy.TARGET_PRIMARY)
        self.assertTrue(self._applies(self.primary, pol))
        self.assertFalse(self._applies(self.plain, pol))
        self.assertFalse(self._applies(self.oob, pol))

    def test_target_oob_only(self):
        from .models import MonitoringPolicy

        pol = self._policy(MonitoringPolicy.TARGET_OOB)
        self.assertTrue(self._applies(self.oob, pol))
        self.assertFalse(self._applies(self.primary, pol))

    def test_target_interfaces_only(self):
        from .models import MonitoringPolicy

        pol = self._policy(MonitoringPolicy.TARGET_INTERFACES)
        self.assertTrue(self._applies(self.primary, pol))  # on eth0
        self.assertFalse(self._applies(self.plain, pol))  # no interface
        self.assertFalse(self._applies(self.oob, pol))

    def test_device_type_scope_honours_target(self):
        from .models import MonitoringPolicy

        pol = self._policy(
            MonitoringPolicy.TARGET_PRIMARY, scope=MonitoringPolicy.SCOPE_DEVICE_TYPE
        )
        self.assertTrue(self._applies(self.primary, pol))
        self.assertFalse(self._applies(self.plain, pol))


class PolicyDefaultPingTests(ResolverTestBase):
    """An enabled policy with no profiles/templates falls back to a default
    ICMP reachability check, so 'Monitor on' always produces something."""

    def test_empty_enabled_policy_resolves_to_default_ping(self):
        from .models import MonitoringPolicy
        from .resolver import _DEFAULT_PING_SLUG

        pol = MonitoringPolicy.objects.create(
            tenant=self.tenant,
            scope=MonitoringPolicy.SCOPE_PREFIX,
            prefix=self.p24,
            enabled=True,
            inherit=False,
        )
        self.assertEqual(pol.templates.count(), 0)
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0].source, "policy")
        self.assertEqual(resolved[0].kind, "icmp")
        self.assertEqual(resolved[0].template.slug, _DEFAULT_PING_SLUG)

    def test_explicit_template_suppresses_the_ping_fallback(self):
        from .models import MonitoringPolicy

        t = self.make_template(kind=CheckKind.TCP)
        pol = MonitoringPolicy.objects.create(
            tenant=self.tenant,
            scope=MonitoringPolicy.SCOPE_PREFIX,
            prefix=self.p24,
            enabled=True,
        )
        pol.templates.add(t)
        resolved = resolve_effective_checks(self.ip)
        self.assertEqual({r.template.id for r in resolved}, {t.id})


class PolicyFollowGlobalNoPingTests(ResolverTestBase):
    """A 'Follow global' (inherit) policy with nothing selected contributes no
    checks of its own — the ping fallback is only for explicit 'Monitor on'."""

    def test_inherit_empty_policy_does_not_ping(self):
        from .models import MonitoringPolicy

        MonitoringPolicy.objects.create(
            tenant=self.tenant,
            scope=MonitoringPolicy.SCOPE_PREFIX,
            prefix=self.p24,
            enabled=True,
            inherit=True,
        )
        self.assertEqual(resolve_effective_checks(self.ip), [])
