"""Writable relations must resolve inside the active tenant.

A serializer relation whose queryset is ``Model.objects.all()`` takes any id
in the database: a writer could link another tenant's object and read its
name back. :class:`RelationGuardTests` walks every routed (and every other
project) serializer and fails on a writable FK/M2M to a tenant-scoped model
that is not a :class:`TenantScopedPrimaryKeyRelatedField`; the API tests below
pin the fields that used to take a foreign id.
"""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.test import SimpleTestCase
from django.urls import get_resolver
from django.utils import timezone
from rest_framework import serializers
from rest_framework.test import APIRequestFactory, APITestCase

from api.models import (
    VRF,
    Device,
    DeviceRole,
    DeviceType,
    IPAddress,
    Manufacturer,
    Prefix,
    Provider,
    Site,
)
from api.serializers import (
    _PARENT_TENANT_PATH,
    _TENANT_Q,
    TenantScopedPrimaryKeyRelatedField,
)
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

#: ``module.Serializer.field`` relations that may point at a tenant-scoped
#: model without being tenant-scoped. Every entry says why.
ALLOWED_UNSCOPED = {
    # Deployment-admin only (DeploymentAdmin): SSO providers are deployment
    # records; a tenant column on one narrows who may sign in through it, it
    # does not make it a tenant's object.
    "auth_api.sso_admin.SsoGroupMappingSerializer.provider",
    # Deployment-admin only: a backup schedule is deployment-wide and may
    # notify through any tenant's channel.
    "backups.serializers.BackupScheduleSerializer.notify_channels",
}

_WRITE_ACTIONS = ("create", "update", "partial_update")


def _tenant_scoped(model) -> bool:
    return (
        any(f.name == "tenant" for f in model._meta.fields)
        or model.__name__ in _PARENT_TENANT_PATH
        or model.__name__ in _TENANT_Q
    )


def _view_classes():
    """(view class, action names) for every routed API view."""
    seen: dict = {}

    def walk(patterns):
        for p in patterns:
            if hasattr(p, "url_patterns"):
                walk(p.url_patterns)
                continue
            cls = getattr(p.callback, "cls", None)
            if cls is None:
                continue
            actions = set((getattr(p.callback, "actions", None) or {}).values())
            seen.setdefault(cls, set()).update(actions)

    walk(get_resolver().url_patterns)
    return seen


def _serializer_classes(cls, actions):
    out = set()
    base = getattr(cls, "serializer_class", None)
    if base is not None:
        out.add(base)
    if "get_serializer_class" not in cls.__dict__ and not any(
        "get_serializer_class" in k.__dict__ for k in cls.__mro__[1:]
        if k.__module__.split(".")[0] not in ("rest_framework",)
    ):
        return out
    request = APIRequestFactory().post("/")
    request.query_params = request.GET
    request.user = None
    for action in set(actions) | set(_WRITE_ACTIONS):
        view = cls()
        view.action = action
        view.request = request
        view.kwargs = {}
        view.format_kwarg = None
        try:
            sc = view.get_serializer_class()
        except Exception:  # noqa: BLE001 - a view that needs a real request
            continue
        if sc is not None:
            out.add(sc)
    return out


def _writable_relations(serializer, prefix=""):
    """(dotted name, relation field) for every writable relation, nested
    writable serializers included."""
    for name, field in serializer.fields.items():
        if field.read_only:
            continue
        if isinstance(field, serializers.ListSerializer):
            yield from _writable_relations(field.child, f"{prefix}{name}.")
            continue
        if isinstance(field, serializers.BaseSerializer):
            yield from _writable_relations(field, f"{prefix}{name}.")
            continue
        rel = field.child_relation if isinstance(field, serializers.ManyRelatedField) else field
        if isinstance(rel, serializers.RelatedField) and rel.queryset is not None:
            yield f"{prefix}{name}", rel


def _project_serializers():
    """Every serializer class defined in this project - also the ones a
    function view builds by hand, which the URL walk can't see."""

    def subclasses(c):
        for s in c.__subclasses__():
            yield s
            yield from subclasses(s)

    yield from set(subclasses(serializers.BaseSerializer))


#: Serializers that aren't this project's: third-party apps and test modules.
def _ours(sc) -> bool:
    mod = sc.__module__
    return mod.split(".")[0] not in {"rest_framework", "drf_spectacular", "django_rq"} and (
        ".tests" not in mod and ".test_" not in mod
    )


def unscoped_relations():
    found = set()
    classes = set(_project_serializers())
    for cls, actions in _view_classes().items():
        classes |= _serializer_classes(cls, actions)
    for sc in filter(_ours, classes):
        try:
            ser = sc(context={})
            ser.fields  # noqa: B018 - builds the field map
        except Exception:  # noqa: BLE001,S112 - needs arguments; not a form
            continue
        for name, rel in _writable_relations(ser):
            if isinstance(rel, TenantScopedPrimaryKeyRelatedField):
                continue
            if not _tenant_scoped(rel.queryset.model):
                continue
            found.add(f"{sc.__module__}.{sc.__name__}.{name}")
    return found


class RelationGuardTests(SimpleTestCase):
    def test_every_writable_relation_is_tenant_scoped(self):
        bad = sorted(unscoped_relations() - ALLOWED_UNSCOPED)
        self.assertEqual(
            bad, [],
            "Writable relations to tenant-scoped models must use "
            "TenantScopedPrimaryKeyRelatedField (or TenantScopedModelSerializer); "
            "add a commented ALLOWED_UNSCOPED entry only for deployment-global "
            "surfaces.",
        )

    def test_allow_list_has_no_stale_entries(self):
        self.assertEqual(sorted(ALLOWED_UNSCOPED - unscoped_relations()), [])


class _TwoTenants(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Org", slug="org")
        self.a = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.b = Tenant.objects.create(org=org, name="Beta", slug="beta")
        admin = User.objects.create_user("root", password="x", is_superuser=True)
        UserProfile.objects.create(user=admin).tenants.add(self.a, self.b)
        self._login(admin, self.a)

    def _login(self, user, tenant):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(tenant.id)
        s.save()

    def _device(self, tenant, name, site=None):
        site = site or Site.objects.create(tenant=tenant, name=f"S-{name}")
        mfr, _ = Manufacturer.objects.get_or_create(
            tenant=tenant, slug="m", defaults={"name": "M"}
        )
        dtype, _ = DeviceType.objects.get_or_create(
            tenant=tenant, model="X", defaults={"manufacturer": mfr}
        )
        role, _ = DeviceRole.objects.get_or_create(
            tenant=tenant, slug="r", defaults={"name": "R"}
        )
        return Device.objects.create(
            tenant=tenant, name=name, device_type=dtype, site=site, role=role,
            status=status_for(tenant),
        )

    def assertRejected(self, r, field):
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn(field, r.json())


class MaintenanceProviderTests(_TwoTenants):
    URL = "/api/monitoring/maintenance-events/"

    def setUp(self):
        super().setUp()
        from api.models import Status
        from api.status_registry import seed_builtin_statuses

        seed_builtin_statuses(self.a)
        self.status = Status.objects.get(tenant=self.a, slug="tentative")
        self.mine = Provider.objects.create(tenant=self.a, name="Mine", slug="mine")
        self.theirs = Provider.objects.create(tenant=self.b, name="Secret Carrier", slug="sc")

    def _body(self, provider):
        t0 = timezone.now()
        return {
            "kind": "maintenance", "status_id": str(self.status.id), "name": "w",
            "provider": str(provider.id), "starts_at": t0.isoformat(),
            "ends_at": (t0 + timedelta(hours=1)).isoformat(),
        }

    def test_create_rejects_foreign_provider(self):
        r = self.client.post(self.URL, self._body(self.theirs), format="json")
        self.assertRejected(r, "provider")
        self.assertNotIn(b"Secret Carrier", r.content)

    def test_update_rejects_foreign_provider(self):
        r = self.client.post(self.URL, self._body(self.mine), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.patch(
            f"{self.URL}{r.json()['id']}/", {"provider": str(self.theirs.id)}, format="json"
        )
        self.assertRejected(r, "provider")


class NotificationChannelMatchTests(_TwoTenants):
    URL = "/api/monitoring/channels/"

    def setUp(self):
        super().setUp()
        self.dev_b = self._device(self.b, "b1")
        self.prefix_b = Prefix.objects.create(
            tenant=self.b, cidr="10.9.0.0/24", status=status_for(self.b)
        )
        self.ip_b = IPAddress.objects.create(
            tenant=self.b, ip_address="10.9.0.1", prefix=self.prefix_b
        )

    def _body(self, **match):
        return {"name": "ops", "kind": "email",
                "config": {"recipients": ["ops@example.test"]}, **match}

    def _foreign(self):
        return (("match_device", self.dev_b), ("match_ip", self.ip_b),
                ("match_prefix", self.prefix_b))

    def test_create_rejects_foreign_targets(self):
        for field, obj in self._foreign():
            r = self.client.post(self.URL, self._body(**{field: str(obj.id)}), format="json")
            self.assertRejected(r, field)

    def test_update_rejects_foreign_targets(self):
        r = self.client.post(self.URL, self._body(), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        url = f"{self.URL}{r.json()['id']}/"
        for field, obj in self._foreign():
            r = self.client.patch(url, {field: str(obj.id)}, format="json")
            self.assertRejected(r, field)

    def test_own_target_still_accepted(self):
        dev = self._device(self.a, "a1")
        r = self.client.post(self.URL, self._body(match_device=str(dev.id)), format="json")
        self.assertEqual(r.status_code, 201, r.content)


class NotificationChannelSiteFenceTests(_TwoTenants):
    """Under enhanced site separation a site-limited editor can't aim a
    channel at a device of a site they don't edit."""

    def setUp(self):
        super().setUp()
        from core.models import DeploymentSettings

        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()
        self.site1 = Site.objects.create(tenant=self.a, name="S1")
        self.site2 = Site.objects.create(tenant=self.a, name="S2")
        self.dev1 = self._device(self.a, "d1", site=self.site1)
        self.dev2 = self._device(self.a, "d2", site=self.site2)
        user = User.objects.create_user("siteop", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.a)
        ch = ObjectPermission.objects.create(
            name="channels", object_types=["notificationchannel"],
            actions=["view", "add", "change"],
        )
        ch.users.add(user)
        dev = ObjectPermission.objects.create(
            name="s1-devices", object_types=["device"], actions=["view", "change"],
        )
        dev.users.add(user)
        dev.sites.set([self.site1])
        self._login(user, self.a)

    def _post(self, device):
        return self.client.post(
            "/api/monitoring/channels/",
            {"name": "ops", "kind": "email", "config": {"recipients": ["o@example.test"]},
             "match_device": str(device.id)},
            format="json",
        )

    def test_other_site_device_rejected(self):
        self.assertRejected(self._post(self.dev2), "match_device")

    def test_own_site_device_accepted(self):
        r = self._post(self.dev1)
        self.assertEqual(r.status_code, 201, r.content)


class NotificationSubscriptionChannelTests(_TwoTenants):
    URL = "/api/monitoring/subscriptions/"

    def test_update_rejects_foreign_channel(self):
        from monitoring.models import NotificationChannel

        mine = NotificationChannel.objects.create(
            tenant=self.a, name="mine", kind="email", config={"recipients": ["a@x.test"]}
        )
        theirs = NotificationChannel.objects.create(
            tenant=self.b, name="theirs", kind="email", config={"recipients": ["b@x.test"]}
        )
        user = User.objects.create_user("member", password="x")
        r = self.client.post(
            self.URL, {"channel": str(mine.id), "user": user.id}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.patch(
            f"{self.URL}{r.json()['id']}/", {"channel": str(theirs.id)}, format="json"
        )
        self.assertRejected(r, "channel")


class SnmpSensorDeviceTypeTests(_TwoTenants):
    URL = "/api/monitoring/snmp-sensors/"

    def setUp(self):
        super().setUp()
        mfr = Manufacturer.objects.create(tenant=self.b, name="M", slug="m")
        self.dt_b = DeviceType.objects.create(tenant=self.b, model="Hidden", manufacturer=mfr)

    def _body(self, **extra):
        return {"name": "PSU", "oid": "1.3.6.1.4.1.1", "value_map": {}, **extra}

    def test_create_rejects_foreign_device_type(self):
        r = self.client.post(self.URL, self._body(device_type=str(self.dt_b.id)), format="json")
        self.assertRejected(r, "device_type")

    def test_update_rejects_foreign_device_type(self):
        r = self.client.post(self.URL, self._body(), format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.patch(
            f"{self.URL}{r.json()['id']}/", {"device_type": str(self.dt_b.id)}, format="json"
        )
        self.assertRejected(r, "device_type")


class PlanningBoardTests(_TwoTenants):
    def setUp(self):
        super().setUp()
        from planning.models import Board, Milestone, TaskLabel, TaskStatus, seed_default_statuses

        self.board = Board.objects.create(tenant=self.a, name="A", slug="a")
        seed_default_statuses(self.board)
        self.todo = TaskStatus.objects.filter(board=self.board).first()
        self.board_b = Board.objects.create(tenant=self.b, name="B", slug="b")
        seed_default_statuses(self.board_b)
        self.todo_b = TaskStatus.objects.filter(board=self.board_b).first()
        self.ms_b = Milestone.objects.create(tenant=self.b, board=self.board_b, name="m")
        self.label_b = TaskLabel.objects.create(tenant=self.b, name="Secret label")

    def test_status_and_milestone_cannot_move_boards(self):
        from planning.models import Milestone

        ms = Milestone.objects.create(tenant=self.a, board=self.board, name="m")
        for url in (f"/api/planning/statuses/{self.todo.id}/",
                    f"/api/planning/milestones/{ms.id}/"):
            r = self.client.patch(url, {"board": str(self.board_b.id)}, format="json")
            self.assertRejected(r, "board")

    def test_task_rejects_foreign_labels_on_create(self):
        r = self.client.post(
            "/api/planning/tasks/",
            {"board": str(self.board.id), "status": str(self.todo.id), "title": "t",
             "labels": [str(self.label_b.id)]},
            format="json",
        )
        self.assertRejected(r, "labels")
        self.assertNotIn(b"Secret label", r.content)

    def test_task_cannot_move_to_foreign_board(self):
        r = self.client.post(
            "/api/planning/tasks/",
            {"board": str(self.board.id), "status": str(self.todo.id), "title": "t"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        url = f"/api/planning/tasks/{r.json()['id']}/"
        r = self.client.patch(
            url, {"board": str(self.board_b.id), "status": str(self.todo_b.id),
                  "milestone": str(self.ms_b.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.patch(url, {"labels": [str(self.label_b.id)]}, format="json")
        self.assertRejected(r, "labels")


class MonitoringSettingsVrfTests(_TwoTenants):
    URL = "/api/monitoring/settings/"

    def test_foreign_default_vrf_rejected(self):
        vrf_b = VRF.objects.create(tenant=self.b, name="Hidden VRF")
        r = self.client.patch(self.URL, {"snmp_default_vrf_id": str(vrf_b.id)}, format="json")
        self.assertRejected(r, "snmp_default_vrf_id")
        self.assertNotIn(b"Hidden VRF", r.content)

    def test_own_default_vrf_accepted(self):
        vrf = VRF.objects.create(tenant=self.a, name="Mine")
        r = self.client.patch(self.URL, {"snmp_default_vrf_id": str(vrf.id)}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
