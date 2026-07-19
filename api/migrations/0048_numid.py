"""Add per-tenant human-readable object numbers (``numid``) + the sequence that
allocates them, plus a free-form ``label`` on Cable. See issue #82.

The UUID PKs are untouched — ``numid`` is a separate, nullable, human-facing
number assigned on create (and backfilled for existing rows by
``manage.py assign_numids``). Uniqueness per (tenant, model) is enforced by the
``NumIdSequence`` allocator, not a DB constraint, so this migration is purely
additive.
"""
from __future__ import annotations

import django.db.models.deletion
from django.db import migrations, models

# Lowercased model names that gain a ``numid`` field (every tenant-scoped
# concrete model). Mirror api.models.NumIdMixin application — keep in sync.
NUMID_MODELS = [
    "routetarget", "vrf", "site", "manufacturer", "devicetype", "device",
    "vlan", "prefix", "ipaddress", "cable", "clustertype", "clustergroup",
    "cluster", "virtualmachine", "rackrole", "rack", "devicerole", "platform",
    "service", "servicetemplate", "iprange", "rir", "aggregate", "asn",
    "vlangroup", "fhrpgroup", "contactgroup", "contactrole", "contact",
    "contactassignment", "provider", "circuittype", "circuit", "powerpanel",
    "powerfeed", "wirelesslangroup", "wirelesslan", "tunnelgroup",
    "ipsecprofile", "tunnel", "region", "location", "configcontext",
    "exporttemplate",
]


def _numid_field():
    return models.PositiveIntegerField(
        blank=True, db_index=True, editable=False, null=True,
        help_text="Per-tenant human-readable number (see NumIdSequence).",
    )


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0047_unified_status"),
        ("core", "0009_deploymentsettings_device_field_visibility"),
    ]

    operations = [
        migrations.CreateModel(
            name="NumIdSequence",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("model_label", models.CharField(max_length=100)),
                ("last_value", models.PositiveIntegerField(default=0)),
                ("tenant", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="numid_sequences", to="core.tenant")),
            ],
        ),
        migrations.AddConstraint(
            model_name="numidsequence",
            constraint=models.UniqueConstraint(fields=("tenant", "model_label"), name="uniq_numidseq_tenant_model"),
        ),
        *[
            migrations.AddField(model_name=mn, name="numid", field=_numid_field())
            for mn in NUMID_MODELS
        ],
        migrations.AddField(
            model_name="cable",
            name="label",
            field=models.CharField(
                blank=True, default="", max_length=255,
                help_text="Free-form physical label (matches NetBox's cable label) — "
                "what's printed on the cable's tag.",
            ),
        ),
    ]
