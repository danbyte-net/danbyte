"""Flag discovered virtual interfaces as virtual.

SNMP discovery used to create loopbacks, SVIs, tunnels and VLAN interfaces
with a blank type and ``virtual=False``, so a 48-port switch with 100 SVIs
counted 148 ports. Discovery now types them "virtual"; this fixes the rows it
created before, from the type each port's last poll reported
(``DeviceSnmp.interfaces``).

Only interfaces with a blank type that are not virtual yet are touched - a
type somebody chose is left alone - and only the flag changes. A row matches
an observed port the way discovery matches them: its name or SNMP name
against the port's ifName or ifDescr, case-insensitively, within the device
that was polled - or its whole stack, since a virtual chassis answers SNMP as
one box and its SVIs live on the master.

One set-based UPDATE, equality joins only so it stays linear on large
tables, and it only touches the rows it changes, so running it again changes
nothing.
"""

from django.db import migrations

# The observed ifType names (danbyte_checks.snmp_facts) of ports with no
# physical connector, frozen as of this migration: monitoring.snmp_drift's
# VIRTUAL_IFTYPES plus "lag", an aggregate.
FLAG_OBSERVED_VIRTUAL = r"""
WITH observed AS (
    SELECT DISTINCT
           s.tenant_id,
           coalesce('vc:' || sd.virtual_chassis_id::text, 'dev:' || sd.id::text) AS scope,
           lower(btrim(v.name, E' \t\r\n')) AS name
      FROM monitoring_devicesnmp AS s
      JOIN api_device AS sd ON sd.id = s.device_id
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(s.interfaces) = 'array'
                  THEN s.interfaces ELSE '[]'::jsonb END
           ) AS o
     CROSS JOIN LATERAL (VALUES (o ->> 'name'), (o ->> 'descr')) AS v(name)
     WHERE o ->> 'type_name' IN ('loopback', 'virtual', 'tunnel', 'l3vlan', 'l2vlan', 'lag')
       AND btrim(coalesce(v.name, ''), E' \t\r\n') <> ''
),
candidates AS (
    SELECT i.id,
           d.tenant_id,
           coalesce('vc:' || d.virtual_chassis_id::text, 'dev:' || d.id::text) AS scope,
           k.name
      FROM api_interface AS i
      JOIN api_device AS d ON d.id = i.device_id
     CROSS JOIN LATERAL (
             VALUES (lower(btrim(i.name, E' \t\r\n'))),
                    (lower(btrim(i.snmp_name, E' \t\r\n')))
           ) AS k(name)
     WHERE i.type = ''
       AND NOT i.virtual
       AND k.name <> ''
)
UPDATE api_interface AS i
   SET virtual = TRUE
  FROM candidates AS c
  JOIN observed AS ob
    ON ob.tenant_id = c.tenant_id
   AND ob.scope = c.scope
   AND ob.name = c.name
 WHERE i.id = c.id
"""


def flag_observed_virtual(apps, schema_editor):
    schema_editor.execute(FLAG_OBSERVED_VIRTUAL)


def noop(apps, schema_editor):
    """Nothing to undo - the prior state was inconsistent, not meaningful."""


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0193_interface_virtual_types"),
        ("monitoring", "0106_snmp_sample_sampled_at"),
    ]

    operations = [
        migrations.RunPython(flag_observed_virtual, noop),
    ]
