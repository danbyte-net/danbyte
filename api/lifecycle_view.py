"""The ``api_lifecycle_entry`` view behind :class:`api.models.LifecycleEntry`
(#535): one row per device hardware, device OS, device coverage, VM OS and
installed application - which rows exist, and the keys to join the rest by.

It reads only key columns: ``id``, ``tenant_id``, ``device_type_id`` and
``platform_id`` of ``api_device``, ``id``, ``tenant_id`` and ``platform_id``
of ``api_virtualmachine``, ``id``, ``tenant_id``, ``device_id`` and
``virtual_machine_id`` of ``api_installedsoftware``. PostgreSQL refuses to
alter a column a view reads, so a migration that changes one of them runs
``DROP_SQL`` first and ``CREATE_SQL`` after.
"""

CREATE_SQL = """
CREATE OR REPLACE VIEW api_lifecycle_entry AS
SELECT 'hardware:' || d.id::text AS id, d.tenant_id, 'device'::varchar AS kind,
       'hardware'::varchar AS source, d.id AS device_id,
       NULL::uuid AS virtual_machine_id, NULL::uuid AS install_id
  FROM api_device d WHERE d.device_type_id IS NOT NULL
UNION ALL
SELECT 'os:' || d.id::text, d.tenant_id, 'device', 'os', d.id, NULL, NULL
  FROM api_device d WHERE d.platform_id IS NOT NULL
UNION ALL
SELECT 'coverage:' || d.id::text, d.tenant_id, 'device', 'coverage', d.id, NULL, NULL
  FROM api_device d
UNION ALL
SELECT 'vmos:' || v.id::text, v.tenant_id, 'virtualmachine', 'os', NULL, v.id, NULL
  FROM api_virtualmachine v WHERE v.platform_id IS NOT NULL
UNION ALL
SELECT 'software:' || i.id::text, i.tenant_id,
       CASE WHEN i.device_id IS NOT NULL THEN 'device' ELSE 'virtualmachine' END,
       'software', i.device_id,
       CASE WHEN i.device_id IS NULL THEN i.virtual_machine_id END, i.id
  FROM api_installedsoftware i
 WHERE i.device_id IS NOT NULL OR i.virtual_machine_id IS NOT NULL
"""

DROP_SQL = "DROP VIEW IF EXISTS api_lifecycle_entry"
