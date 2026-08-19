"""Deleting a tenant must work whatever it owns.

Tenant deletion touches nearly every model in the product: structural catalogs
PROTECT their tenant, leaf data cascades, and 145 models are audited. That
breadth is exactly why a narrow test misses things - the original suite deleted
a tenant owning a Prefix and a Status, which happens to avoid the one ordering
problem that mattered (#37: audit entries written *after* the tenant row is
gone, failing the deferred foreign key at COMMIT).

So this module tests the *workflow* rather than a case:

1. a seeded tenant with a realistic object graph deletes cleanly;
2. every audited catalog the introspection can build is covered automatically,
   so a model added later is included without anyone remembering to;
3. no change-log row is left pointing at a tenant that no longer exists -
   the invariant #37 actually violated;
4. the audit suspension is scoped to the teardown and nothing wider.
"""
from __future__ import annotations

from django.apps import apps
from django.contrib.auth.models import User
from django.core.management import call_command
from django.db import models
from rest_framework.test import APITestCase

from api.models import Prefix, Status
from audit.models import ChangeLogEntry
from core.models import Organization, Tenant


def _buildable_audited_models():
    """Audited models we can construct from a tenant (and maybe a name) alone.

    Deliberately conservative: anything needing another object is skipped
    rather than guessed at. The sweep below asserts a floor on how many this
    finds, so if a refactor makes it silently match nothing the test fails
    instead of quietly passing.
    """
    from audit.apps import AUDITED_MODELS

    out = []
    for label in AUDITED_MODELS:
        try:
            model = apps.get_model(label)
        except LookupError:
            continue
        tenant_field = next(
            (
                f for f in model._meta.get_fields()
                if getattr(f, "name", None) == "tenant"
                and isinstance(f, models.ForeignKey)
            ),
            None,
        )
        if tenant_field is None:
            continue
        needs = []
        for f in model._meta.get_fields():
            if not isinstance(f, models.Field) or f.name == "tenant":
                continue
            if f.primary_key or f.blank or f.null or f.has_default():
                continue
            if f.name == "name" and isinstance(f, models.CharField):
                needs.append(f.name)
                continue
            needs = None  # something we can't supply
            break
        if needs is None:
            continue
        out.append((model, needs))
    return out


class TenantDeleteWorkflowTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(self.admin)

    def _activate(self, tenant):
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()

    def _delete(self, tenant):
        self._activate(tenant)
        r = self.client.delete(f"/api/tenants/{tenant.id}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertFalse(Tenant.objects.filter(pk=tenant.pk).exists())

    # 1 ── a realistic graph, not a hand-picked pair of models
    def test_a_seeded_tenant_deletes_cleanly(self):
        call_command("seed_demo", verbosity=0)
        tenant = Tenant.objects.get(slug="acme")
        self.assertTrue(Prefix.objects.filter(tenant=tenant).exists())

        self._delete(tenant)

        self.assertFalse(Prefix.objects.filter(tenant_id=tenant.id).exists())
        self.assertFalse(Status.objects.filter(tenant_id=tenant.id).exists())

    # 2 ── every audited catalog we can build, so new models come along free
    def test_every_buildable_audited_model_is_covered(self):
        org = Organization.objects.create(name="Sweep", slug="sweep")
        tenant = Tenant.objects.create(org=org, name="Sweep", slug="sweep")
        call_command("seed_builtin_statuses", verbosity=0)

        built = []
        for model, needs in _buildable_audited_models():
            kwargs = {"tenant": tenant}
            for field in needs:
                kwargs[field] = f"sweep-{model._meta.model_name}"[:60]
            try:
                model.objects.create(**kwargs)
            except Exception:
                continue  # a constraint we can't satisfy blindly - fine
            built.append(model._meta.label)

        # A floor, not an exact count: it must not silently sweep nothing.
        self.assertGreaterEqual(
            len(built), 10,
            f"introspection built only {len(built)} audited models - the sweep "
            "has stopped covering anything meaningful",
        )
        self._delete(tenant)

    # 3 ── the invariant #37 broke
    def test_no_change_log_entry_outlives_its_tenant(self):
        from integrations.models import VirtualizationSource

        org = Organization.objects.create(name="Orph", slug="orph")
        tenant = Tenant.objects.create(org=org, name="Orph", slug="orph")
        # Reached only through the tenant's own cascade - the shape that broke.
        VirtualizationSource.objects.create(
            tenant=tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "x", "secret": "s"},
        )
        Prefix.objects.create(tenant=tenant, cidr="10.44.0.0/24")

        self._delete(tenant)

        live = set(Tenant.objects.values_list("id", flat=True))
        orphans = (
            ChangeLogEntry.objects.exclude(tenant__isnull=True)
            .exclude(tenant_id__in=live)
            .count()
        )
        self.assertEqual(orphans, 0, "change-log rows outlived their tenant")

    # 4 ── the suspension is a scalpel, not a switch left on
    def test_auditing_is_suspended_only_during_the_teardown(self):
        from audit.context import is_suspended

        org = Organization.objects.create(name="Scope", slug="scope")
        doomed = Tenant.objects.create(org=org, name="Doomed", slug="doomed2")
        keep = Tenant.objects.create(org=org, name="Keep", slug="keep2")

        self.assertFalse(is_suspended())
        self._delete(doomed)
        self.assertFalse(is_suspended(), "audit stayed suspended after the delete")

        before = ChangeLogEntry.objects.filter(tenant=keep).count()
        Prefix.objects.create(tenant=keep, cidr="10.45.0.0/24")
        self.assertEqual(
            ChangeLogEntry.objects.filter(tenant=keep).count(), before + 1,
            "an ordinary write stopped being audited",
        )
