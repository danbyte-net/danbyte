"""The ``api_inventory_entry`` view behind :class:`api.models.InventoryEntry`
(docs/dcim/stock.md): the tenant's whole inventory in one list - every
inventory item (seated in a port, loose on a device, or in stock at a site
and location) and every module installed in a bay. A unit is one row in
whichever form it has now: a module taken out of its bay becomes an
inventory item with the same id (api.stock), so nothing is counted twice.

``home`` says where the row is: ``port`` (a transceiver seated in an
interface), ``bay`` (an installed module), ``device`` (loose on a device) or
``stock`` (at a site, maybe a location). ``site_id`` is the device's site
for a part on a device, else the stock site; ``location_id`` the device's
location, else the stock location.

PostgreSQL refuses to alter a column a view reads. A migration that alters a
column of ``api_inventoryitem``, ``api_module``, ``api_device``,
``api_site`` or ``api_moduletype`` that the SQL below names runs
``DROP_SQL`` before it and ``CREATE_SQL`` after
(``core.tests_migration_safety`` checks it).
"""

#: The columns the view reads, by table - what the migration check guards.
READS = {
    "api_inventoryitem": {"id", "device_id", "site_id", "location_id", "interface_id",
                          "name", "kind", "manufacturer_id", "part_id", "serial_number",
                          "asset_tag", "status_id", "module_type_id", "description",
                          "created_at", "updated_at"},
    "api_module": {"id", "device_id", "module_bay_id", "module_type_id", "status_id",
                   "serial_number", "asset_tag", "description", "created_at", "updated_at"},
    "api_device": {"id", "tenant_id", "site_id", "location_id"},
    "api_site": {"id", "tenant_id"},
    "api_moduletype": {"id", "name", "manufacturer_id", "part_number"},
}

CREATE_SQL = """
CREATE OR REPLACE VIEW api_inventory_entry AS
SELECT i.id, 'item'::varchar AS source, COALESCE(d.tenant_id, s.tenant_id) AS tenant_id,
       CASE WHEN i.device_id IS NULL THEN 'stock'
            WHEN i.interface_id IS NOT NULL THEN 'port'
            ELSE 'device' END::varchar AS home,
       i.device_id, COALESCE(d.site_id, i.site_id) AS site_id,
       COALESCE(d.location_id, i.location_id) AS location_id,
       i.interface_id, NULL::uuid AS module_bay_id, i.module_type_id,
       i.name::varchar AS name, i.kind::varchar AS kind, i.manufacturer_id,
       i.part_id::varchar AS part_id, i.serial_number::varchar AS serial_number,
       i.asset_tag::varchar AS asset_tag, i.status_id,
       i.description::varchar AS description, i.created_at, i.updated_at
  FROM api_inventoryitem i
  LEFT JOIN api_device d ON d.id = i.device_id
  LEFT JOIN api_site s ON s.id = i.site_id
UNION ALL
SELECT m.id, 'module', d.tenant_id, 'bay', m.device_id, d.site_id, d.location_id,
       NULL, m.module_bay_id, m.module_type_id, mt.name, 'module', mt.manufacturer_id,
       mt.part_number, m.serial_number, m.asset_tag, m.status_id, m.description,
       m.created_at, m.updated_at
  FROM api_module m
  JOIN api_device d ON d.id = m.device_id
  JOIN api_moduletype mt ON mt.id = m.module_type_id
"""

DROP_SQL = "DROP VIEW IF EXISTS api_inventory_entry"
