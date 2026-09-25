"""Routing serializers. A list (prefix list, community list, AS-path list,
routing policy) reads its rules nested and accepts a ``rules`` list on
write that replaces the set - upsert by sequence, delete the rest, in one
transaction - so the form is one page with a rules table. The rule rows
also have plain serializers of their own for scripts and CSV.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from api.models import (
    ASN,
    L2VPN,
    VLAN,
    VRF,
    Device,
    Interface,
    IPAddress,
    Prefix,
    VirtualMachine,
    VMInterface,
)
from api.serializers import (
    CustomFieldsSerializerMixin,
    DeviceMiniSerializer,
    InterfaceMiniSerializer,
    IPMiniSerializer,
    NumIdModelSerializer,
    PrefixMiniSerializer,
    SecretPSKSerializerMixin,
    SiteMiniSerializer,
    StatusSerializerMixin,
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
    VLANMiniSerializer,
    VRFMiniSerializer,
)
from core.models import Tag

from .models import (
    AFI_SAFI_CHOICES,
    VTEP,
    ASPathList,
    ASPathListRule,
    BFDProfile,
    BGPAddressFamily,
    BGPInstance,
    BGPPeerGroup,
    BGPSession,
    Community,
    CommunityList,
    CommunityListRule,
    EIGRPInstance,
    EIGRPInterface,
    EthernetSegment,
    ISISInstance,
    ISISInterface,
    LDPInstance,
    OSPFArea,
    OSPFInstance,
    OSPFInterface,
    PrefixList,
    PrefixListRule,
    Redistribution,
    RoutingKeychain,
    RoutingPolicy,
    RoutingPolicyRule,
    StaticRoute,
    VTEPMembership,
    link_remote_address,
    resolve_membership_vlan,
    validate_address_families,
)


def _run_clean(instance) -> None:
    """Run the model's ``clean()`` and re-raise as DRF field errors."""
    try:
        instance.clean()
    except DjangoValidationError as exc:
        raise serializers.ValidationError(
            exc.message_dict if hasattr(exc, "message_dict") else exc.messages
        ) from exc


def _rule_error(i: int, detail) -> serializers.ValidationError:
    """One readable line per problem - ``Rule 2: ge: Must be…`` - under the
    ``rules`` key, so a form shows it beneath the table instead of trying
    to map a nested {row: {field: [...]}} onto its inputs."""
    lines = []
    if isinstance(detail, dict):
        for field, msgs in detail.items():
            for m in (msgs if isinstance(msgs, list) else [msgs]):
                lines.append(f"Rule {i + 1}: {field}: {m}")
    else:
        for m in (detail if isinstance(detail, list) else [detail]):
            lines.append(f"Rule {i + 1}: {m}")
    return serializers.ValidationError({"rules": lines})


class VMMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = VirtualMachine
        fields = ["id", "name"]


class VMInterfaceMiniSerializer(NumIdModelSerializer):
    """A VM's port with its VM - the ``InterfaceMiniSerializer`` shape."""

    vm = VMMiniSerializer(read_only=True)

    class Meta:
        model = VMInterface
        fields = ["id", "name", "vm"]


class _OwnerFields(serializers.Serializer):
    """The device or VM a routing row runs on (#217). Exactly one is set;
    the model's ``clean()`` says so when a write gives both or neither."""

    device = DeviceMiniSerializer(read_only=True)
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    virtual_machine = VMMiniSerializer(read_only=True)
    virtual_machine_id = TenantScopedPrimaryKeyRelatedField(
        source="virtual_machine", queryset=VirtualMachine.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    site = SiteMiniSerializer(source="owner.site", read_only=True)


_OWNER_FIELDS = ["device", "device_id", "virtual_machine", "virtual_machine_id", "site"]


def _owner_ref(obj) -> dict | None:
    """``{"id", "name", "kind"}`` for the box a routing row runs on."""
    if obj is None:
        return None
    if obj.device_id:
        return {"id": str(obj.device_id), "name": obj.device.name, "kind": "device"}
    vm_id = getattr(obj, "virtual_machine_id", None)
    if vm_id:
        return {"id": str(vm_id), "name": obj.virtual_machine.name, "kind": "vm"}
    return None


class _TagsMixin(TaggableSerializerMixin, serializers.Serializer):
    """Declared-field mixin (a plain class's attributes are not collected
    by DRF's metaclass - ``StatusSerializerMixin`` is built the same way)."""

    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )


# ─── Rule rows ───────────────────────────────────────────────────────────────

class _RuleSerializer(NumIdModelSerializer):
    """Base for a rule row: the parent FK is read-only here (nested writes
    set it; the standalone endpoints take ``<parent>_id``)."""

    parent_field = ""

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = self.Meta.model(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in self.Meta.model._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in self.Meta.model._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        if self.parent_field and self.parent_field not in attrs and self.instance is not None:
            setattr(probe, self.parent_field, getattr(self.instance, self.parent_field))
        _run_clean(probe)
        # clean() normalises text fields (prefix, next hop); keep the result.
        for name in ("prefix", "set_next_hop"):
            if name in attrs:
                attrs[name] = getattr(probe, name)
        return attrs


class PrefixListRuleSerializer(_RuleSerializer):
    parent_field = "prefix_list"
    prefix_list_id = TenantScopedPrimaryKeyRelatedField(
        source="prefix_list", queryset=PrefixList.objects.all(),
        write_only=True, required=False,
    )
    prefix_obj = PrefixMiniSerializer(read_only=True)
    prefix_obj_id = TenantScopedPrimaryKeyRelatedField(
        source="prefix_obj", queryset=Prefix.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    class Meta:
        model = PrefixListRule
        # Nested writes upsert by sequence; the DB constraint answers the
        # standalone endpoint (a 409). DRF's own validator would otherwise
        # demand the parent id on every nested row.
        validators = []
        fields = ["id", "prefix_list_id", "sequence", "action", "prefix",
                  "prefix_obj", "prefix_obj_id", "ge", "le", "description"]
        read_only_fields = ["id"]


class CommunityMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = Community
        fields = ["id", "name", "value", "kind"]


class CommunityListRuleSerializer(_RuleSerializer):
    parent_field = "community_list"
    community_list_id = TenantScopedPrimaryKeyRelatedField(
        source="community_list", queryset=CommunityList.objects.all(),
        write_only=True, required=False,
    )
    communities = CommunityMiniSerializer(many=True, read_only=True)
    community_ids = TenantScopedPrimaryKeyRelatedField(
        source="communities", queryset=Community.objects.all(),
        write_only=True, required=False, many=True,
    )

    class Meta:
        model = CommunityListRule
        # Nested writes upsert by sequence; the DB constraint answers the
        # standalone endpoint (a 409). DRF's own validator would otherwise
        # demand the parent id on every nested row.
        validators = []
        fields = ["id", "community_list_id", "sequence", "action",
                  "communities", "community_ids", "regex", "description"]
        read_only_fields = ["id"]


class ASPathListRuleSerializer(_RuleSerializer):
    parent_field = "as_path_list"
    as_path_list_id = TenantScopedPrimaryKeyRelatedField(
        source="as_path_list", queryset=ASPathList.objects.all(),
        write_only=True, required=False,
    )

    class Meta:
        model = ASPathListRule
        # Nested writes upsert by sequence; the DB constraint answers the
        # standalone endpoint (a 409). DRF's own validator would otherwise
        # demand the parent id on every nested row.
        validators = []
        fields = ["id", "as_path_list_id", "sequence", "action", "regex",
                  "description"]
        read_only_fields = ["id"]


class PrefixListMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = PrefixList
        fields = ["id", "name", "family"]


class CommunityListMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = CommunityList
        fields = ["id", "name", "kind"]


class ASPathListMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ASPathList
        fields = ["id", "name"]


class RoutingPolicyMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = RoutingPolicy
        fields = ["id", "name"]


class RoutingKeychainMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = RoutingKeychain
        fields = ["id", "name", "algorithm"]


class BFDProfileMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = BFDProfile
        fields = ["id", "name", "min_tx", "min_rx", "multiplier"]


class BFDProfileSerializer(CustomFieldsSerializerMixin, _TagsMixin, NumIdModelSerializer):
    cf_model = "bfdprofile"

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = BFDProfile(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in BFDProfile._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in BFDProfile._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        _run_clean(probe)
        return attrs

    class Meta:
        model = BFDProfile
        fields = ["id", "numid", "name", "min_tx", "min_rx", "multiplier", "echo",
                  "description", "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]


class _BFDProfileFields(serializers.Serializer):
    """``bfd_profile`` read nested, ``bfd_profile_id`` on write."""

    bfd_profile = BFDProfileMiniSerializer(read_only=True)
    bfd_profile_id = TenantScopedPrimaryKeyRelatedField(
        source="bfd_profile", queryset=BFDProfile.objects.all(),
        write_only=True, required=False, allow_null=True,
    )


class RoutingPolicyRuleSerializer(_RuleSerializer):
    parent_field = "policy"
    policy_id = TenantScopedPrimaryKeyRelatedField(
        source="policy", queryset=RoutingPolicy.objects.all(),
        write_only=True, required=False,
    )
    match_prefix_lists = PrefixListMiniSerializer(many=True, read_only=True)
    match_prefix_list_ids = TenantScopedPrimaryKeyRelatedField(
        source="match_prefix_lists", queryset=PrefixList.objects.all(),
        write_only=True, required=False, many=True,
    )
    match_community_lists = CommunityListMiniSerializer(many=True, read_only=True)
    match_community_list_ids = TenantScopedPrimaryKeyRelatedField(
        source="match_community_lists", queryset=CommunityList.objects.all(),
        write_only=True, required=False, many=True,
    )
    match_as_path_lists = ASPathListMiniSerializer(many=True, read_only=True)
    match_as_path_list_ids = TenantScopedPrimaryKeyRelatedField(
        source="match_as_path_lists", queryset=ASPathList.objects.all(),
        write_only=True, required=False, many=True,
    )
    match_next_hop = PrefixListMiniSerializer(read_only=True)
    match_next_hop_id = TenantScopedPrimaryKeyRelatedField(
        source="match_next_hop", queryset=PrefixList.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    set_communities = CommunityMiniSerializer(many=True, read_only=True)
    set_community_ids = TenantScopedPrimaryKeyRelatedField(
        source="set_communities", queryset=Community.objects.all(),
        write_only=True, required=False, many=True,
    )

    class Meta:
        model = RoutingPolicyRule
        # Nested writes upsert by sequence; the DB constraint answers the
        # standalone endpoint (a 409). DRF's own validator would otherwise
        # demand the parent id on every nested row.
        validators = []
        fields = ["id", "policy_id", "sequence", "action", "description",
                  "match_prefix_lists", "match_prefix_list_ids",
                  "match_community_lists", "match_community_list_ids",
                  "match_as_path_lists", "match_as_path_list_ids",
                  "match_next_hop", "match_next_hop_id", "match_extra",
                  "set_local_pref", "set_med", "set_weight", "set_origin",
                  "set_next_hop", "set_as_path_prepend",
                  "set_communities", "set_community_ids",
                  "set_communities_additive", "set_metric_type", "set_extra",
                  "continue_seq"]
        read_only_fields = ["id"]


# ─── Lists with nested rules ─────────────────────────────────────────────────

class _ListSerializer(CustomFieldsSerializerMixin, _TagsMixin, NumIdModelSerializer):
    """A catalog whose ``rules`` are read nested and written as a whole."""

    rule_serializer: type[_RuleSerializer]
    rule_parent = ""

    rules = serializers.SerializerMethodField()
    rule_count = serializers.SerializerMethodField()

    def get_rules(self, obj) -> list:
        # The list page does not draw rules; the detail does. Cheap either
        # way, but a 300-list page should not carry 3,000 rule rows.
        view = self.context.get("view")
        if view is not None and getattr(view, "action", None) == "list":
            return []
        return self.rule_serializer(obj.rules.all(), many=True, context=self.context).data

    def get_rule_count(self, obj) -> int:
        annotated = getattr(obj, "rule_count_annotated", None)
        return annotated if annotated is not None else obj.rules.count()

    def _rules_payload(self):
        return self.initial_data.get("rules") if isinstance(self.initial_data, dict) else None

    def _validate_rules(self, payload, parent=None):
        if payload is None:
            return None
        if not isinstance(payload, list):
            raise serializers.ValidationError({"rules": "Expected a list."})
        seen = set()
        cleaned = []
        for i, row in enumerate(payload):
            if not isinstance(row, dict):
                raise serializers.ValidationError({"rules": f"Row {i} is not an object."})
            ser = self.rule_serializer(data=row, context=self.context)
            if not ser.is_valid():
                raise _rule_error(i, ser.errors)
            seq = ser.validated_data.get("sequence")
            if seq in seen:
                raise _rule_error(i, {"sequence": "Duplicate sequence."})
            seen.add(seq)
            cleaned.append(ser.validated_data)
        return cleaned

    def validate(self, attrs):
        attrs = super().validate(attrs)
        self._rules_clean = self._validate_rules(self._rules_payload())
        return attrs

    def _sync_rules(self, obj, rows) -> None:
        """The payload is the whole rule set: a row is matched by sequence
        and rewritten in full (a field left out goes back to its default),
        sequences not in the payload are deleted."""
        if rows is None:
            return
        model = self.rule_serializer.Meta.model
        m2m_names = {f.name for f in model._meta.many_to_many}
        columns = [
            f for f in model._meta.concrete_fields
            if f.name not in ("id", self.rule_parent)
        ]
        existing = {r.sequence: r for r in obj.rules.all()}
        keep = set()
        for i, data in enumerate(rows):
            data = dict(data)
            m2m = {k: data.pop(k) for k in list(data) if k in m2m_names}
            row = existing.get(data["sequence"]) or model(**{self.rule_parent: obj})
            for f in columns:
                setattr(row, f.name, data.get(f.name, f.get_default()))
            # The row-level check ran without a parent (a new list has no
            # id yet); now the family / list checks can run.
            try:
                _run_clean(row)
            except serializers.ValidationError as exc:
                raise _rule_error(i, exc.detail) from exc
            row.save()
            for k, v in m2m.items():
                getattr(row, k).set(v)
            keep.add(row.sequence)
        obj.rules.exclude(sequence__in=keep).delete()

    def create(self, validated_data):
        with transaction.atomic():
            obj = super().create(validated_data)
            self._sync_rules(obj, getattr(self, "_rules_clean", None))
        return obj

    def update(self, instance, validated_data):
        with transaction.atomic():
            obj = super().update(instance, validated_data)
            self._sync_rules(obj, getattr(self, "_rules_clean", None))
        return obj


_LIST_FIELDS = ["id", "numid", "name", "description", "rules", "rule_count",
                "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
_LIST_RO = ["id", "numid", "created_at", "updated_at"]


class PrefixListSerializer(_ListSerializer):
    cf_model = "prefixlist"
    rule_serializer = PrefixListRuleSerializer
    rule_parent = "prefix_list"

    class Meta:
        model = PrefixList
        fields = [*_LIST_FIELDS, "family"]
        read_only_fields = _LIST_RO


class CommunityListSerializer(_ListSerializer):
    cf_model = "communitylist"
    rule_serializer = CommunityListRuleSerializer
    rule_parent = "community_list"

    class Meta:
        model = CommunityList
        fields = [*_LIST_FIELDS, "kind"]
        read_only_fields = _LIST_RO


class ASPathListSerializer(_ListSerializer):
    cf_model = "aspathlist"
    rule_serializer = ASPathListRuleSerializer
    rule_parent = "as_path_list"

    class Meta:
        model = ASPathList
        fields = _LIST_FIELDS
        read_only_fields = _LIST_RO


class RoutingPolicySerializer(_ListSerializer):
    cf_model = "routingpolicy"
    rule_serializer = RoutingPolicyRuleSerializer
    rule_parent = "policy"

    class Meta:
        model = RoutingPolicy
        fields = _LIST_FIELDS
        read_only_fields = _LIST_RO


# ─── Plain catalogs ──────────────────────────────────────────────────────────

class CommunitySerializer(CustomFieldsSerializerMixin, _TagsMixin, NumIdModelSerializer):
    cf_model = "community"

    class Meta:
        model = Community
        fields = ["id", "numid", "name", "value", "kind", "description",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]


class RoutingKeychainSerializer(
    SecretPSKSerializerMixin, CustomFieldsSerializerMixin, _TagsMixin, NumIdModelSerializer
):
    cf_model = "routingkeychain"

    class Meta:
        model = RoutingKeychain
        fields = ["id", "numid", "name", "algorithm", "description",
                  "psk", "psk_set",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "psk_set", "created_at", "updated_at"]


# ─── Static routes ───────────────────────────────────────────────────────────

class StaticRouteSerializer(
    _OwnerFields, CustomFieldsSerializerMixin, StatusSerializerMixin, _TagsMixin,
    NumIdModelSerializer,
):
    cf_model = "staticroute"

    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    vrf = VRFMiniSerializer(read_only=True)
    vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    prefix_obj = PrefixMiniSerializer(read_only=True)
    prefix_obj_id = TenantScopedPrimaryKeyRelatedField(
        source="prefix_obj", queryset=Prefix.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    next_hop_interface = InterfaceMiniSerializer(read_only=True)
    next_hop_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="next_hop_interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    next_hop_vm_interface = VMInterfaceMiniSerializer(read_only=True)
    next_hop_vm_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="next_hop_vm_interface", queryset=VMInterface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    next_hop_vrf = VRFMiniSerializer(read_only=True)
    next_hop_vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="next_hop_vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = StaticRoute(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in StaticRoute._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in StaticRoute._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        _run_clean(probe)
        for name in ("prefix", "next_hop"):
            if name in attrs:
                attrs[name] = getattr(probe, name)
        return attrs

    class Meta:
        model = StaticRoute
        # The path constraint spans nullable columns; DRF's validator would
        # make them all required. The DB answers a duplicate with a 409.
        validators = []
        fields = ["id", "numid", *_OWNER_FIELDS, "vrf", "vrf_id",
                  "prefix", "prefix_obj", "prefix_obj_id", "kind", "kind_display",
                  "next_hop", "next_hop_interface", "next_hop_interface_id",
                  "next_hop_vm_interface", "next_hop_vm_interface_id",
                  "next_hop_vrf", "next_hop_vrf_id",
                  "distance", "metric", "tag", "bfd",
                  "status", "status_id", "description",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]


# ─── BGP ─────────────────────────────────────────────────────────────────────


class ASNMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ASN
        fields = ["id", "asn"]


class _ChildRowSerializer(NumIdModelSerializer):
    """A row written nested under its parent (the parent FK is set by the
    parent's serializer) or on its own (the ``*_id`` field)."""

    parent_field = ""

    def _probe(self, attrs):
        model = self.Meta.model
        probe = model(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in model._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in model._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        return probe

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = self._probe(attrs)
        _run_clean(probe)
        for f in ("networks", "address_families", "remote_address", "router_id",
                  "summary_addresses"):
            if f in attrs:
                attrs[f] = getattr(probe, f)
        return attrs


class _ParentRefMixin:
    """The parent, read-only, on a child row's own endpoint - so a sync can
    tell from the collection which parent a row belongs to."""

    parent_field = ""

    def _parent_ref(self, obj):
        parent = getattr(obj, self.parent_field)
        ref = {"id": str(parent.id)}
        owner = _owner_ref(parent)
        if owner is not None and owner["kind"] == "device":
            ref["device"] = {"id": owner["id"], "name": owner["name"]}
        elif owner is not None:
            ref["virtual_machine"] = {"id": owner["id"], "name": owner["name"]}
        for attr in ("process_id", "process", "asn"):
            if hasattr(parent, attr):
                ref["name"] = str(getattr(parent, attr))
                break
        return ref


class RedistributionSerializer(_ChildRowSerializer):
    parent_field = "bgp_af"
    bgp_af_id = TenantScopedPrimaryKeyRelatedField(
        source="bgp_af", queryset=BGPAddressFamily.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    ospf_instance_id = TenantScopedPrimaryKeyRelatedField(
        source="ospf_instance", queryset=OSPFInstance.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    isis_instance_id = TenantScopedPrimaryKeyRelatedField(
        source="isis_instance", queryset=ISISInstance.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    eigrp_instance_id = TenantScopedPrimaryKeyRelatedField(
        source="eigrp_instance", queryset=EIGRPInstance.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    policy = RoutingPolicyMiniSerializer(read_only=True)
    policy_id = TenantScopedPrimaryKeyRelatedField(
        source="policy", queryset=RoutingPolicy.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    class Meta:
        model = Redistribution
        fields = ["id", "bgp_af_id", "ospf_instance_id", "isis_instance_id", "eigrp_instance_id",
                  "source", "policy", "policy_id", "metric", "level", "family", "extra"]
        read_only_fields = ["id"]

    def validate_level(self, value):
        if value and value not in dict(ISISInstance.LEVEL_CHOICES):
            raise serializers.ValidationError("One of 1, 2 or 1-2.")
        return value


class BGPAddressFamilySerializer(_ParentRefMixin, _ChildRowSerializer):
    parent_field = "instance"
    instance = serializers.SerializerMethodField()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_instance(self, obj):
        return self._parent_ref(obj)
    instance_id = TenantScopedPrimaryKeyRelatedField(
        source="instance", queryset=BGPInstance.objects.all(),
        write_only=True, required=False,
    )
    afi_safi_display = serializers.CharField(source="get_afi_safi_display", read_only=True)
    import_policy = RoutingPolicyMiniSerializer(read_only=True)
    import_policy_id = TenantScopedPrimaryKeyRelatedField(
        source="import_policy", queryset=RoutingPolicy.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    export_policy = RoutingPolicyMiniSerializer(read_only=True)
    export_policy_id = TenantScopedPrimaryKeyRelatedField(
        source="export_policy", queryset=RoutingPolicy.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    redistributions = RedistributionSerializer(many=True, read_only=True)

    class Meta:
        model = BGPAddressFamily
        fields = ["id", "instance", "instance_id", "afi_safi", "afi_safi_display",
                  "advertise_ipv4_unicast", "advertise_ipv6_unicast", "networks",
                  "maximum_paths", "maximum_paths_ibgp",
                  "import_policy", "import_policy_id", "export_policy", "export_policy_id",
                  "redistributions", "extra"]
        read_only_fields = ["id"]
        validators = []

    def _rows(self):
        return self.initial_data.get("redistributions") if isinstance(self.initial_data, dict) else None

    def validate(self, attrs):
        attrs = super().validate(attrs)
        rows = self._rows()
        if rows is not None:
            if not isinstance(rows, list):
                raise serializers.ValidationError({"redistributions": "Expected a list."})
            cleaned = []
            for i, row in enumerate(rows):
                ser = RedistributionSerializer(data=row, context=self.context)
                if not ser.is_valid():
                    raise serializers.ValidationError(
                        {"redistributions": [f"Row {i + 1}: {ser.errors}"]}
                    )
                cleaned.append(ser.validated_data)
            self._redistributions = cleaned
        return attrs

    def _sync(self, af):
        rows = getattr(self, "_redistributions", None)
        if rows is None:
            return
        af.redistributions.all().delete()
        for data in rows:
            data = dict(data)
            data.pop("bgp_af", None)
            Redistribution.objects.create(bgp_af=af, **data)

    def create(self, validated_data):
        with transaction.atomic():
            af = super().create(validated_data)
            self._sync(af)
        return af

    def update(self, instance, validated_data):
        with transaction.atomic():
            af = super().update(instance, validated_data)
            self._sync(af)
        return af


class BGPInstanceSerializer(
    _OwnerFields, _BFDProfileFields, CustomFieldsSerializerMixin, StatusSerializerMixin,
    _TagsMixin, NumIdModelSerializer,
):
    cf_model = "bgpinstance"

    vrf = VRFMiniSerializer(read_only=True)
    vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    asn = ASNMiniSerializer(read_only=True)
    asn_id = TenantScopedPrimaryKeyRelatedField(
        source="asn", queryset=ASN.objects.all(), write_only=True,
    )
    address_families = BGPAddressFamilySerializer(many=True, read_only=True)
    session_count = serializers.SerializerMethodField()

    def get_session_count(self, obj) -> int:
        annotated = getattr(obj, "session_count_annotated", None)
        return annotated if annotated is not None else obj.sessions.count()

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = BGPInstance(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in BGPInstance._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in BGPInstance._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        _run_clean(probe)
        if "router_id" in attrs:
            attrs["router_id"] = probe.router_id
        # `distance bgp` takes all three numbers or none.
        distances = [
            probe.distance_ebgp, probe.distance_ibgp, probe.distance_local
        ]
        if any(d is not None for d in distances) and None in distances:
            raise serializers.ValidationError(
                {"distance_ebgp": "distance bgp needs the eBGP, iBGP and local "
                                  "values together."}
            )
        return attrs

    class Meta:
        model = BGPInstance
        fields = ["id", "numid", *_OWNER_FIELDS, "vrf", "vrf_id", "asn", "asn_id",
                  "router_id", "cluster_id", "graceful_restart",
                  "distance_ebgp", "distance_ibgp", "distance_local",
                  "bestpath_multipath_relax",
                  "vpn_export", "vpn_import", "vpn_label_export", "vpn_nexthop_export",
                  "bfd",
                  "bfd_profile", "bfd_profile_id", "address_families", "session_count",
                  "status", "status_id", "description", "extra",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]
        validators = []


class BGPInstanceMiniSerializer(NumIdModelSerializer):
    device = DeviceMiniSerializer(read_only=True)
    virtual_machine = VMMiniSerializer(read_only=True)
    vrf = VRFMiniSerializer(read_only=True)
    asn = ASNMiniSerializer(read_only=True)

    class Meta:
        model = BGPInstance
        fields = ["id", "device", "virtual_machine", "vrf", "asn"]


class _PeerKnobFields(serializers.Serializer):
    """The shared neighbour settings, on a session and on a peer group."""

    address_families = serializers.ListField(
        child=serializers.ChoiceField(choices=AFI_SAFI_CHOICES), required=False,
    )
    import_policy = RoutingPolicyMiniSerializer(read_only=True)
    import_policy_id = TenantScopedPrimaryKeyRelatedField(
        source="import_policy", queryset=RoutingPolicy.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    export_policy = RoutingPolicyMiniSerializer(read_only=True)
    export_policy_id = TenantScopedPrimaryKeyRelatedField(
        source="export_policy", queryset=RoutingPolicy.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    keychain = RoutingKeychainMiniSerializer(read_only=True)
    keychain_id = TenantScopedPrimaryKeyRelatedField(
        source="keychain", queryset=RoutingKeychain.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    bfd_profile = BFDProfileMiniSerializer(read_only=True)
    bfd_profile_id = TenantScopedPrimaryKeyRelatedField(
        source="bfd_profile", queryset=BFDProfile.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    default_originate_policy = RoutingPolicyMiniSerializer(read_only=True)
    default_originate_policy_id = TenantScopedPrimaryKeyRelatedField(
        source="default_originate_policy", queryset=RoutingPolicy.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    def validate_address_families(self, value):
        try:
            return validate_address_families(value)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.messages) from exc


_KNOB_FIELDS = [
    "address_families", "import_policy", "import_policy_id",
    "export_policy", "export_policy_id", "bfd", "bfd_profile", "bfd_profile_id",
    "ebgp_multihop", "next_hop_self", "route_reflector_client", "send_community",
    "keepalive", "hold_time", "keychain", "keychain_id", "extra",
    "default_originate", "default_originate_policy", "default_originate_policy_id",
    "maximum_prefix", "allowas_in", "as_override",
    "remove_private_as", "soft_reconfiguration",
    "capability_extended_nexthop", "ttl_security_hops",
]


class BGPPeerGroupSerializer(
    _PeerKnobFields, CustomFieldsSerializerMixin, _TagsMixin, NumIdModelSerializer
):
    cf_model = "bgppeergroup"

    local_asn = ASNMiniSerializer(read_only=True)
    local_asn_id = TenantScopedPrimaryKeyRelatedField(
        source="local_asn", queryset=ASN.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    session_count = serializers.SerializerMethodField()

    def get_session_count(self, obj) -> int:
        annotated = getattr(obj, "session_count_annotated", None)
        return annotated if annotated is not None else obj.sessions.count()

    class Meta:
        model = BGPPeerGroup
        fields = ["id", "numid", "name", "description",
                  "remote_asn", "remote_asn_mode", "local_asn", "local_asn_id",
                  "update_source", *_KNOB_FIELDS, "session_count",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]


class BGPPeerGroupMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = BGPPeerGroup
        fields = ["id", "name", "remote_asn", "remote_asn_mode"]


class BGPSessionSerializer(
    _PeerKnobFields, CustomFieldsSerializerMixin, StatusSerializerMixin, _TagsMixin,
    NumIdModelSerializer,
):
    cf_model = "bgpsession"

    instance = BGPInstanceMiniSerializer(read_only=True)
    instance_id = TenantScopedPrimaryKeyRelatedField(
        source="instance", queryset=BGPInstance.objects.all(), write_only=True,
    )
    peer_group = BGPPeerGroupMiniSerializer(read_only=True)
    peer_group_id = TenantScopedPrimaryKeyRelatedField(
        source="peer_group", queryset=BGPPeerGroup.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    local_asn = ASNMiniSerializer(read_only=True)
    local_asn_id = TenantScopedPrimaryKeyRelatedField(
        source="local_asn", queryset=ASN.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    local_address = IPMiniSerializer(read_only=True)
    local_address_id = TenantScopedPrimaryKeyRelatedField(
        source="local_address", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    interface = InterfaceMiniSerializer(read_only=True)
    interface_id = TenantScopedPrimaryKeyRelatedField(
        source="interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vm_interface = VMInterfaceMiniSerializer(read_only=True)
    vm_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="vm_interface", queryset=VMInterface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    remote_address_obj = IPMiniSerializer(read_only=True)
    peer_device = DeviceMiniSerializer(read_only=True)
    peer_device_id = TenantScopedPrimaryKeyRelatedField(
        source="peer_device", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    peer_session = serializers.SerializerMethodField()
    effective = serializers.SerializerMethodField()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_peer_session(self, obj):
        p = obj.peer_session if obj.peer_session_id else None
        if p is None:
            return None
        owner = _owner_ref(p.instance)
        ref = {"id": str(p.id)}
        if owner is not None:
            key = "device" if owner["kind"] == "device" else "virtual_machine"
            ref[key] = {"id": owner["id"], "name": owner["name"]}
        return ref

    def get_effective(self, obj) -> dict:
        eff = obj.effective()
        return {
            **{k: v for k, v in eff.items()
               if k not in ("import_policy", "export_policy", "keychain", "bfd_profile",
                            "default_originate_policy")},
            "bfd_profile": BFDProfileMiniSerializer(eff["bfd_profile"]).data
            if eff["bfd_profile"] else None,
            "default_originate_policy": RoutingPolicyMiniSerializer(
                eff["default_originate_policy"]
            ).data if eff["default_originate_policy"] else None,
            "import_policy": RoutingPolicyMiniSerializer(eff["import_policy"]).data
            if eff["import_policy"] else None,
            "export_policy": RoutingPolicyMiniSerializer(eff["export_policy"]).data
            if eff["export_policy"] else None,
            "keychain": RoutingKeychainMiniSerializer(eff["keychain"]).data
            if eff["keychain"] else None,
        }

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = BGPSession(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in BGPSession._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in BGPSession._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        _run_clean(probe)
        if "remote_address" in attrs:
            attrs["remote_address"] = probe.remote_address
        return attrs

    def create(self, validated_data):
        obj = super().create(validated_data)
        link_remote_address(obj)
        return obj

    def update(self, instance, validated_data):
        obj = super().update(instance, validated_data)
        link_remote_address(obj)
        return obj

    class Meta:
        model = BGPSession
        fields = ["id", "numid", "instance", "instance_id", "name",
                  "peer_group", "peer_group_id",
                  "remote_asn", "remote_asn_mode", "local_asn", "local_asn_id",
                  "local_address", "local_address_id",
                  "remote_address", "interface", "interface_id",
                  "vm_interface", "vm_interface_id", "remote_address_obj",
                  "peer_device", "peer_device_id", "peer_session",
                  *_KNOB_FIELDS, "effective",
                  "status", "status_id", "description",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "remote_address_obj", "created_at", "updated_at"]
        validators = []


# ─── OSPF / IS-IS ────────────────────────────────────────────────────────────

class OSPFAreaSerializer(CustomFieldsSerializerMixin, _TagsMixin, NumIdModelSerializer):
    cf_model = "ospfarea"
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    interface_count = serializers.SerializerMethodField()

    def get_interface_count(self, obj) -> int:
        annotated = getattr(obj, "interface_count_annotated", None)
        return annotated if annotated is not None else obj.interfaces.count()

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if "area_id" in attrs:
            probe = OSPFArea(area_id=attrs["area_id"])
            _run_clean(probe)
            attrs["area_id"] = probe.area_id
        return attrs

    class Meta:
        model = OSPFArea
        fields = ["id", "numid", "name", "area_id", "kind", "kind_display", "description",
                  "interface_count", "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]


class OSPFAreaMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = OSPFArea
        fields = ["id", "name", "area_id", "kind"]


class _RedistributingInstanceSerializer(
    _OwnerFields, _BFDProfileFields, CustomFieldsSerializerMixin, StatusSerializerMixin, _TagsMixin,
    NumIdModelSerializer,
):
    """An IGP instance: nested read of its interfaces and redistributions,
    a ``redistributions`` list on write that replaces the set."""

    parent_key = ""

    vrf = VRFMiniSerializer(read_only=True)
    vrf_id = TenantScopedPrimaryKeyRelatedField(
        source="vrf", queryset=VRF.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    redistributions = RedistributionSerializer(many=True, read_only=True)
    interface_count = serializers.SerializerMethodField()

    def get_interface_count(self, obj) -> int:
        annotated = getattr(obj, "interface_count_annotated", None)
        return annotated if annotated is not None else obj.interfaces.count()

    def _probe(self, attrs):
        model = self.Meta.model
        probe = model(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in model._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in model._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        return probe

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = self._probe(attrs)
        _run_clean(probe)
        for f in ("router_id", "net", "k_values"):
            if f in attrs:
                attrs[f] = getattr(probe, f)
        rows = self.initial_data.get("redistributions") if isinstance(self.initial_data, dict) else None
        if rows is not None:
            if not isinstance(rows, list):
                raise serializers.ValidationError({"redistributions": "Expected a list."})
            cleaned = []
            for i, row in enumerate(rows):
                ser = RedistributionSerializer(data=row, context=self.context)
                if not ser.is_valid():
                    raise serializers.ValidationError(
                        {"redistributions": [f"Row {i + 1}: {ser.errors}"]}
                    )
                cleaned.append(ser.validated_data)
            self._redistributions = cleaned
        return attrs

    def _sync(self, inst):
        rows = getattr(self, "_redistributions", None)
        if rows is None:
            return
        inst.redistributions.all().delete()
        for data in rows:
            data = dict(data)
            for k in ("bgp_af", "ospf_instance", "isis_instance", "eigrp_instance"):
                data.pop(k, None)
            Redistribution.objects.create(**{self.parent_key: inst}, **data)

    def create(self, validated_data):
        with transaction.atomic():
            inst = super().create(validated_data)
            self._sync(inst)
        return inst

    def update(self, instance, validated_data):
        with transaction.atomic():
            inst = super().update(instance, validated_data)
            self._sync(inst)
        return inst


class OSPFInterfaceSerializer(_ParentRefMixin, _BFDProfileFields, _ChildRowSerializer):
    parent_field = "instance"
    instance = serializers.SerializerMethodField()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_instance(self, obj):
        return self._parent_ref(obj)

    instance_id = TenantScopedPrimaryKeyRelatedField(
        source="instance", queryset=OSPFInstance.objects.all(),
        write_only=True, required=False,
    )
    interface = InterfaceMiniSerializer(read_only=True)
    interface_id = TenantScopedPrimaryKeyRelatedField(
        source="interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vm_interface = VMInterfaceMiniSerializer(read_only=True)
    vm_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="vm_interface", queryset=VMInterface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    area = OSPFAreaMiniSerializer(read_only=True)
    area_id = TenantScopedPrimaryKeyRelatedField(
        source="area", queryset=OSPFArea.objects.all(), write_only=True,
    )
    keychain = RoutingKeychainMiniSerializer(read_only=True)
    keychain_id = TenantScopedPrimaryKeyRelatedField(
        source="keychain", queryset=RoutingKeychain.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    class Meta:
        model = OSPFInterface
        fields = ["id", "instance", "instance_id", "interface", "interface_id",
                  "vm_interface", "vm_interface_id", "area", "area_id",
                  "cost", "network_type", "passive", "priority", "hello", "dead",
                  "bfd", "bfd_profile", "bfd_profile_id", "mtu_ignore",
                  "authentication", "keychain", "keychain_id", "extra"]
        read_only_fields = ["id"]
        validators = []


class OSPFInstanceSerializer(_RedistributingInstanceSerializer):
    cf_model = "ospfinstance"
    parent_key = "ospf_instance"
    interfaces = OSPFInterfaceSerializer(many=True, read_only=True)

    class Meta:
        model = OSPFInstance
        fields = ["id", "numid", *_OWNER_FIELDS, "vrf", "vrf_id",
                  "process_id", "version", "router_id", "reference_bandwidth",
                  "passive_by_default", "default_originate", "bfd",
                  "bfd_profile", "bfd_profile_id",
                  "redistributions", "interfaces", "interface_count",
                  "status", "status_id", "description", "extra",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]
        validators = []


class ISISInterfaceSerializer(_ParentRefMixin, _BFDProfileFields, _ChildRowSerializer):
    parent_field = "instance"
    instance = serializers.SerializerMethodField()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_instance(self, obj):
        return self._parent_ref(obj)

    instance_id = TenantScopedPrimaryKeyRelatedField(
        source="instance", queryset=ISISInstance.objects.all(),
        write_only=True, required=False,
    )
    interface = InterfaceMiniSerializer(read_only=True)
    interface_id = TenantScopedPrimaryKeyRelatedField(
        source="interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vm_interface = VMInterfaceMiniSerializer(read_only=True)
    vm_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="vm_interface", queryset=VMInterface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    keychain = RoutingKeychainMiniSerializer(read_only=True)
    keychain_id = TenantScopedPrimaryKeyRelatedField(
        source="keychain", queryset=RoutingKeychain.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    families = serializers.ListField(
        child=serializers.ChoiceField(choices=[("ipv4", "IPv4"), ("ipv6", "IPv6")]),
        required=False,
    )

    def validate(self, attrs):
        attrs = super().validate(attrs)
        # clean() fills an empty list with ipv4 - keep that on a create that
        # never mentioned families.
        probe = self._probe(attrs)
        _run_clean(probe)
        attrs["families"] = probe.families
        return attrs

    class Meta:
        model = ISISInterface
        fields = ["id", "instance", "instance_id", "interface", "interface_id",
                  "vm_interface", "vm_interface_id", "families",
                  "level", "metric", "metric_l2", "network_type", "passive",
                  "hello_interval", "hello_multiplier", "bfd", "bfd_profile", "bfd_profile_id",
                  "authentication", "keychain", "keychain_id", "extra"]
        read_only_fields = ["id"]
        validators = []


class ISISInstanceSerializer(_RedistributingInstanceSerializer):
    cf_model = "isisinstance"
    parent_key = "isis_instance"
    interfaces = ISISInterfaceSerializer(many=True, read_only=True)
    keychain = RoutingKeychainMiniSerializer(read_only=True)
    keychain_id = TenantScopedPrimaryKeyRelatedField(
        source="keychain", queryset=RoutingKeychain.objects.all(),
        write_only=True, required=False, allow_null=True,
    )

    _SPF = ("spf_init_delay", "spf_short_delay", "spf_long_delay",
            "spf_holddown", "spf_time_to_learn")

    def validate(self, attrs):
        attrs = super().validate(attrs)
        # `spf-delay-ietf` takes all five values or none; a partial set is
        # not a stanza FRR accepts, so it is not one Danbyte stores.
        merged = {
            f: attrs.get(f, getattr(self.instance, f, None)) for f in self._SPF
        }
        given = [f for f, v in merged.items() if v is not None]
        if given and len(given) != len(self._SPF):
            missing = ", ".join(f for f in self._SPF if f not in given)
            raise serializers.ValidationError(
                {missing.split(", ")[0]:
                 f"spf-delay-ietf needs all five values; missing {missing}."}
            )
        return attrs

    class Meta:
        model = ISISInstance
        fields = ["id", "numid", *_OWNER_FIELDS, "vrf", "vrf_id",
                  "process", "net", "router_id", "level", "metric_style", "bfd",
                  "bfd_profile", "bfd_profile_id", "authentication", "keychain", "keychain_id",
                  "lsp_gen_interval", "spf_interval", "lsp_mtu",
                  "spf_init_delay", "spf_short_delay", "spf_long_delay",
                  "spf_holddown", "spf_time_to_learn", "log_adjacency_changes",
                  "default_originate_ipv4", "default_originate_ipv6",
                  "redistributions", "interfaces", "interface_count",
                  "status", "status_id", "description", "extra",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]
        validators = []


# ─── Overlay: VTEPs ──────────────────────────────────────────────────────────

class EIGRPInterfaceSerializer(_ParentRefMixin, _BFDProfileFields, _ChildRowSerializer):
    parent_field = "instance"
    instance = serializers.SerializerMethodField()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_instance(self, obj):
        return self._parent_ref(obj)

    instance_id = TenantScopedPrimaryKeyRelatedField(
        source="instance", queryset=EIGRPInstance.objects.all(),
        write_only=True, required=False,
    )
    interface = InterfaceMiniSerializer(read_only=True)
    interface_id = TenantScopedPrimaryKeyRelatedField(
        source="interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    vm_interface = VMInterfaceMiniSerializer(read_only=True)
    vm_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="vm_interface", queryset=VMInterface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    keychain = RoutingKeychainMiniSerializer(read_only=True)
    keychain_id = TenantScopedPrimaryKeyRelatedField(
        source="keychain", queryset=RoutingKeychain.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    summary_addresses = serializers.ListField(
        child=serializers.CharField(), required=False,
    )

    class Meta:
        model = EIGRPInterface
        fields = ["id", "instance", "instance_id", "interface", "interface_id",
                  "vm_interface", "vm_interface_id", "passive", "bfd",
                  "bfd_profile", "bfd_profile_id",
                  "hello_interval", "hold_time", "bandwidth_percent", "split_horizon",
                  "summary_addresses", "authentication", "keychain", "keychain_id", "extra"]
        read_only_fields = ["id"]
        validators = []


class EIGRPInstanceSerializer(_RedistributingInstanceSerializer):
    cf_model = "eigrpinstance"
    parent_key = "eigrp_instance"
    interfaces = EIGRPInterfaceSerializer(many=True, read_only=True)

    class Meta:
        model = EIGRPInstance
        fields = ["id", "numid", *_OWNER_FIELDS, "vrf", "vrf_id",
                  "asn", "name", "router_id", "k_values", "variance", "maximum_paths",
                  "passive_by_default", "stub", "bfd", "bfd_profile", "bfd_profile_id",
                  "redistributions", "interfaces", "interface_count",
                  "status", "status_id", "description", "extra",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]
        validators = []


class L2VPNBriefSerializer(NumIdModelSerializer):
    vrf = VRFMiniSerializer(read_only=True)

    class Meta:
        model = L2VPN
        fields = ["id", "name", "slug", "type", "identifier", "vrf"]


class VTEPMembershipSerializer(_ParentRefMixin, _ChildRowSerializer):
    parent_field = "vtep"
    vtep = serializers.SerializerMethodField()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_vtep(self, obj):
        return self._parent_ref(obj)

    vtep_id = TenantScopedPrimaryKeyRelatedField(
        source="vtep", queryset=VTEP.objects.all(), write_only=True, required=False,
    )
    l2vpn = L2VPNBriefSerializer(read_only=True)
    l2vpn_id = TenantScopedPrimaryKeyRelatedField(
        source="l2vpn", queryset=L2VPN.objects.all(), write_only=True,
    )
    vlan = VLANMiniSerializer(read_only=True)
    vlan_id = TenantScopedPrimaryKeyRelatedField(
        source="vlan", queryset=VLAN.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    #: The VLAN the render resolves for this leaf (own, else the site's).
    resolved_vlan = serializers.SerializerMethodField()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_resolved_vlan(self, obj):
        v = resolve_membership_vlan(obj)
        return VLANMiniSerializer(v).data if v is not None else None

    class Meta:
        model = VTEPMembership
        fields = ["id", "vtep", "vtep_id", "l2vpn", "l2vpn_id", "vlan", "vlan_id", "resolved_vlan",
                  "rd", "ingress_replication", "mcast_group", "extra"]
        read_only_fields = ["id"]
        validators = []


class VTEPSerializer(
    CustomFieldsSerializerMixin, StatusSerializerMixin, _TagsMixin, NumIdModelSerializer
):
    cf_model = "vtep"

    device = DeviceMiniSerializer(read_only=True)
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    source_interface = InterfaceMiniSerializer(read_only=True)
    source_interface_id = TenantScopedPrimaryKeyRelatedField(
        source="source_interface", queryset=Interface.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    source_ip = IPMiniSerializer(read_only=True)
    source_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="source_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    anycast_ip = IPMiniSerializer(read_only=True)
    anycast_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="anycast_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    site = SiteMiniSerializer(source="device.site", read_only=True)
    memberships = VTEPMembershipSerializer(many=True, read_only=True)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = VTEP(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in VTEP._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in VTEP._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        _run_clean(probe)
        if "anycast_gateway_mac" in attrs:
            attrs["anycast_gateway_mac"] = probe.anycast_gateway_mac
        return attrs

    class Meta:
        model = VTEP
        fields = ["id", "numid", "device", "device_id", "site",
                  "source_interface", "source_interface_id", "source_ip", "source_ip_id",
                  "anycast_ip", "anycast_ip_id", "anycast_gateway_mac", "arp_suppression",
                  "memberships", "status", "status_id", "description", "extra",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]
        validators = []


# ─── EVPN multihoming ────────────────────────────────────────────────────────


class EthernetSegmentSerializer(CustomFieldsSerializerMixin, _TagsMixin, NumIdModelSerializer):
    """A segment and the LAG interfaces, on different leaves, that share it.

    Interfaces are set as a whole (``interface_ids``): the segment is the
    thing a reviewer looks at to see that leaf1 swp5 and leaf2 swp5 are the
    same server, so it owns the list rather than each port pointing at it.
    """

    cf_model = "ethernetsegment"

    interfaces = InterfaceMiniSerializer(many=True, read_only=True)
    interface_ids = TenantScopedPrimaryKeyRelatedField(
        source="interfaces", queryset=Interface.objects.all(),
        write_only=True, required=False, many=True,
    )
    device_count = serializers.SerializerMethodField()

    def get_device_count(self, obj) -> int:
        return len({i.device_id for i in obj.interfaces.all()})

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = EthernetSegment(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in EthernetSegment._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in EthernetSegment._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        _run_clean(probe)
        for f in ("esi", "sys_mac"):
            if f in attrs:
                attrs[f] = getattr(probe, f)
        return attrs

    class Meta:
        model = EthernetSegment
        fields = ["id", "numid", "name", "esi", "es_id", "sys_mac", "df_preference",
                  "interfaces", "interface_ids", "device_count", "description",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "device_count", "created_at", "updated_at"]


# ─── MPLS / LDP ──────────────────────────────────────────────────────────────


class LDPInstanceSerializer(
    _BFDProfileFields, CustomFieldsSerializerMixin, StatusSerializerMixin, _TagsMixin,
    NumIdModelSerializer,
):
    cf_model = "ldpinstance"

    device = DeviceMiniSerializer(read_only=True)
    site = SiteMiniSerializer(source="device.site", read_only=True)
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
    interfaces = InterfaceMiniSerializer(many=True, read_only=True)
    interface_ids = TenantScopedPrimaryKeyRelatedField(
        source="interfaces", queryset=Interface.objects.all(),
        write_only=True, required=False, many=True,
    )

    def validate(self, attrs):
        attrs = super().validate(attrs)
        probe = LDPInstance(**{
            k: v for k, v in attrs.items()
            if k in {f.name for f in LDPInstance._meta.concrete_fields}
        })
        if self.instance is not None:
            for f in LDPInstance._meta.concrete_fields:
                if f.name not in attrs:
                    setattr(probe, f.name, getattr(self.instance, f.name))
        _run_clean(probe)
        for f in ("router_id", "transport_address"):
            if f in attrs:
                attrs[f] = getattr(probe, f)
        # Every port must be the instance's own device's.
        device = attrs.get("device", getattr(self.instance, "device", None))
        taken = LDPInstance.objects.filter(device=device)
        if self.instance is not None:
            taken = taken.exclude(pk=self.instance.pk)
        if device is not None and taken.exists():
            raise serializers.ValidationError(
                {"device_id": f"{device.name} already runs LDP - edit that instance."}
            )
        for iface in attrs.get("interfaces", []):
            if device is not None and iface.device_id != device.id:
                raise serializers.ValidationError(
                    {"interface_ids": f"{iface.name} is not on {device.name}."}
                )
        return attrs

    class Meta:
        model = LDPInstance
        fields = ["id", "numid", "device", "device_id", "site", "router_id",
                  "transport_address", "label_allocation", "interfaces", "interface_ids",
                  "bfd", "bfd_profile", "bfd_profile_id",
                  "status", "status_id", "description", "extra",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]
