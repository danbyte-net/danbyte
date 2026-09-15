"""Routing serializers. A list (prefix list, community list, AS-path list,
routing policy) reads its rules nested and accepts a ``rules`` list on
write that replaces the set - upsert by sequence, delete the rest, in one
transaction - so the form is one page with a rules table. The rule rows
also have plain serializers of their own for scripts and CSV.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from rest_framework import serializers

from api.models import VRF, Device, Interface, Prefix
from api.serializers import (
    CustomFieldsSerializerMixin,
    DeviceMiniSerializer,
    InterfaceMiniSerializer,
    NumIdModelSerializer,
    PrefixMiniSerializer,
    SecretPSKSerializerMixin,
    StatusSerializerMixin,
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
    VRFMiniSerializer,
)
from core.models import Tag

from .models import (
    ASPathList,
    ASPathListRule,
    Community,
    CommunityList,
    CommunityListRule,
    PrefixList,
    PrefixListRule,
    RoutingKeychain,
    RoutingPolicy,
    RoutingPolicyRule,
    StaticRoute,
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
    CustomFieldsSerializerMixin, StatusSerializerMixin, _TagsMixin, NumIdModelSerializer
):
    cf_model = "staticroute"

    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    device = DeviceMiniSerializer(read_only=True)
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )
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
        fields = ["id", "numid", "device", "device_id", "vrf", "vrf_id",
                  "prefix", "prefix_obj", "prefix_obj_id", "kind", "kind_display",
                  "next_hop", "next_hop_interface", "next_hop_interface_id",
                  "next_hop_vrf", "next_hop_vrf_id",
                  "distance", "metric", "tag", "bfd",
                  "status", "status_id", "description",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]
