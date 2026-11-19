"""The ``api_lifecycle_entry`` view behind :class:`api.models.LifecycleEntry`
(#535): one row per device hardware, device OS, device coverage, VM OS and
installed application, with what every row is sorted and filtered by
picked per source in the source's own branch - its object's name, site and
role, the item and its manufacturer, the dates someone entered, the
end-of-life mapping that may fill them, and for coverage the device's latest
contract end (9999-12-31 open-ended) and the contract with it (by
``support_coverage.contract_order``). What depends on today and on the
settings (the effective dates, days left, window, status) is worked out at
read (``api.lifecycle_list``).

PostgreSQL refuses to alter a column a view reads. A migration that alters a
column of ``api_device``, ``api_devicetype``, ``api_platform``,
``api_virtualmachine``, ``api_installedsoftware``, ``api_application``,
``compliance_eolmapping`` (``platform_id``), ``api_supportcoverage`` or
``api_supportcontract`` that the SQL below names runs ``DROP_SQL`` before
it and ``CREATE_SQL`` after (``core.tests_migration_safety`` checks it).
"""

#: The columns the view reads, by table - what the migration check guards.
READS = {
    "api_device": {"id", "tenant_id", "name", "site_id", "role_id", "device_type_id",
                   "platform_id", "warranty_end"},
    "api_devicetype": {"id", "name", "manufacturer_id", "release_date", "end_of_support"},
    "api_platform": {"id", "name", "release_date", "end_of_support"},
    "api_virtualmachine": {"id", "tenant_id", "name", "site_id", "role_id", "platform_id"},
    "api_installedsoftware": {"id", "tenant_id", "device_id", "virtual_machine_id",
                              "application_id", "version", "release_date", "end_of_support",
                              "eol_mapping_id"},
    "api_application": {"id", "name", "manufacturer_id"},
    "compliance_eolmapping": {"id", "platform_id"},
    "api_supportcoverage": {"device_id", "contract_id"},
    "api_supportcontract": {"id", "end_date", "contract_number"},
}

CREATE_SQL = """
CREATE OR REPLACE VIEW api_lifecycle_entry AS
SELECT 'hardware:' || d.id::text AS id, d.tenant_id, 'device'::varchar AS kind,
       'hardware'::varchar AS source, d.id AS device_id,
       NULL::uuid AS virtual_machine_id, NULL::uuid AS install_id,
       d.name::varchar AS name, d.site_id, d.role_id, dt.manufacturer_id,
       dt.id AS item_id, dt.name::varchar AS item_name, NULL::uuid AS application_id,
       ''::varchar AS version, dt.release_date AS entered_start,
       dt.end_of_support AS entered_end, NULL::uuid AS mapping_id,
       NULL::date AS warranty_end, NULL::date AS cov_contract_end,
       NULL::uuid AS cov_contract_id
  FROM api_device d JOIN api_devicetype dt ON dt.id = d.device_type_id
UNION ALL
SELECT 'os:' || d.id::text, d.tenant_id, 'device', 'os', d.id, NULL, NULL,
       d.name, d.site_id, d.role_id, dt.manufacturer_id, p.id, p.name, NULL, '',
       p.release_date, p.end_of_support, m.id, NULL, NULL, NULL
  FROM api_device d JOIN api_platform p ON p.id = d.platform_id
  LEFT JOIN api_devicetype dt ON dt.id = d.device_type_id
  LEFT JOIN compliance_eolmapping m ON m.platform_id = p.id
UNION ALL
SELECT 'coverage:' || d.id::text, d.tenant_id, 'device', 'coverage', d.id, NULL, NULL,
       d.name, d.site_id, d.role_id, dt.manufacturer_id, NULL, NULL, NULL, '',
       NULL, NULL, NULL, d.warranty_end, g.contract_end, g.contract_id
  FROM api_device d
  LEFT JOIN api_devicetype dt ON dt.id = d.device_type_id
  LEFT JOIN (
    SELECT DISTINCT ON (sc.device_id) sc.device_id, sc.contract_id,
           MAX(COALESCE(c.end_date, DATE '9999-12-31')) OVER (PARTITION BY sc.device_id)
             AS contract_end
      FROM api_supportcoverage sc JOIN api_supportcontract c ON c.id = sc.contract_id
     ORDER BY sc.device_id, COALESCE(c.end_date, DATE '9999-12-31') DESC,
              c.contract_number, c.id
  ) g ON g.device_id = d.id
UNION ALL
SELECT 'vmos:' || v.id::text, v.tenant_id, 'virtualmachine', 'os', NULL, v.id, NULL,
       v.name, v.site_id, v.role_id, NULL, p.id, p.name, NULL, '',
       p.release_date, p.end_of_support, m.id, NULL, NULL, NULL
  FROM api_virtualmachine v JOIN api_platform p ON p.id = v.platform_id
  LEFT JOIN compliance_eolmapping m ON m.platform_id = p.id
UNION ALL
SELECT 'software:' || i.id::text, i.tenant_id,
       CASE WHEN i.device_id IS NOT NULL THEN 'device' ELSE 'virtualmachine' END,
       'software', i.device_id,
       CASE WHEN i.device_id IS NULL THEN i.virtual_machine_id END, i.id,
       COALESCE(d.name, v.name), COALESCE(d.site_id, v.site_id),
       COALESCE(d.role_id, v.role_id), a.manufacturer_id, a.id,
       TRIM(a.name || ' ' || i.version), a.id, i.version,
       i.release_date, i.end_of_support, i.eol_mapping_id, NULL, NULL, NULL
  FROM api_installedsoftware i JOIN api_application a ON a.id = i.application_id
  LEFT JOIN api_device d ON d.id = i.device_id
  LEFT JOIN api_virtualmachine v ON v.id = i.virtual_machine_id AND i.device_id IS NULL
 WHERE i.device_id IS NOT NULL OR i.virtual_machine_id IS NOT NULL
"""

DROP_SQL = "DROP VIEW IF EXISTS api_lifecycle_entry"
