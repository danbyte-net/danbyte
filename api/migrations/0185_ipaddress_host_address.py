# IP addresses are stored as bare hosts. PostgreSQL's inet keeps a mask it is
# given, and an ORM write outside the API (a shell, a script) could store
# "10.0.0.5/24", which the code reading the address then rejects. The field
# now drops the mask on write. This step does the same for rows already
# stored with one: the host stays, a length that differs from the prefix
# moves to mask_length. A row whose bare form another row in the same tenant
# and VRF already holds is left as it is and logged; nothing is merged.
# Running it again finds nothing to do. AlterField emits no SQL: the column
# is inet before and after.

import ipaddress
import logging

from django.db import migrations
from django.db.models import F, Func, IntegerField, Q, TextField

import api.fields

logger = logging.getLogger("danbyte.migrations")


def _prefix_length(cidr):
    try:
        return ipaddress.ip_network(cidr, strict=False).prefixlen
    except (TypeError, ValueError):
        return None


def masked_rows(IPAddress):
    """Rows whose stored value carries a mask shorter than a host's."""
    return (
        IPAddress.objects.annotate(
            _family=Func(F("ip_address"), function="family", output_field=IntegerField()),
            _length=Func(F("ip_address"), function="masklen", output_field=IntegerField()),
            _host=Func(F("ip_address"), function="host", output_field=TextField()),
            _stored=Func(F("ip_address"), function="text", output_field=TextField()),
        )
        .filter(Q(_family=4, _length__lt=32) | Q(_family=6, _length__lt=128))
        .order_by("created_at", "id")
        .values(
            "id", "tenant_id", "vrf_id", "mask_length", "prefix__cidr",
            "_host", "_length", "_stored",
        )
    )


def normalise(apps, schema_editor):
    IPAddress = apps.get_model("api", "IPAddress")
    fixed = 0
    for row in masked_rows(IPAddress):
        host, length = row["_host"], row["_length"]
        other = (
            IPAddress.objects.filter(
                tenant_id=row["tenant_id"], vrf_id=row["vrf_id"], ip_address=host
            )
            .exclude(pk=row["id"])
            .values_list("id", flat=True)
            .first()
        )
        if other is not None:
            logger.warning(
                "IP address %s is stored as %s and was left as it is: address "
                "%s already holds %s in the same tenant and VRF. Delete or "
                "renumber one of the two.",
                row["id"], row["_stored"], other, host,
            )
            continue
        changes = {"ip_address": host}
        if row["mask_length"] is None and length != _prefix_length(row["prefix__cidr"]):
            changes["mask_length"] = length
        IPAddress.objects.filter(pk=row["id"]).update(**changes)
        fixed += 1
    if fixed:
        logger.info("Stored %d IP address(es) that carried a mask as bare hosts.", fixed)


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0184_ipaddress_db_defaults'),
    ]

    operations = [
        migrations.AlterField(
            model_name='ipaddress',
            name='ip_address',
            field=api.fields.HostAddressField(),
        ),
        migrations.RunPython(normalise, migrations.RunPython.noop),
    ]
