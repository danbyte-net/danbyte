---
icon: lucide/package
---

# Software bill of materials (SBOM)

Danbyte exports a **CycloneDX 1.6** JSON SBOM of your devices and virtual
machines: each host, the operating system it runs and every application
installed on it, with name, version, supplier and licence. Regenerate it
whenever you need it - just before a hand-in, for example - so it shows what
is recorded at that moment.

## Where the software list comes from

The SBOM lists what Danbyte has recorded; it does not scan hosts. Each host
contributes:

- its **platform** (the OS), at the host's *Software version*, as an
  `operating-system` component;
- its [installed software](applications.md#installed-software), each as an
  `application` component.

Installs are recorded in any of three ways:

- **By hand** on the device's or VM's **Software** tab, or by assigning an
  [application group](applications.md#application-groups).
- **CSV import** of installed software - see
  [Import & export](applications.md#import-export).
- **The REST API** - `POST /api/installed-software/`, for example from
  Ansible after gathering `package_facts` over SSH.

No agent runs on the host and the host needs no access to a package
repository: Ansible reads the package list over its usual SSH connection and
posts it to Danbyte.

### Example: post installed packages from Ansible

The play reads the package list, makes sure each package exists in the
application catalog, then records the install. Danbyte answers `400` for a
version already recorded on the host, so a re-run changes nothing.

```yaml
- hosts: all
  gather_facts: false
  vars:
    danbyte: https://danbyte.example
    headers:
      Authorization: "Token {{ lookup('env', 'DANBYTE_TOKEN') }}"
    # The packages to report; leave it out to report all of them.
    report: [openssh-server, nginx, postgresql-16]
  tasks:
    - name: Read the installed packages
      ansible.builtin.package_facts:

    - name: Find the host in Danbyte
      ansible.builtin.uri:
        url: "{{ danbyte }}/api/devices/?search={{ inventory_hostname | urlencode }}&picker=1"
        headers: "{{ headers }}"
      register: host
      delegate_to: localhost

    - name: Add the applications to the catalog
      ansible.builtin.uri:
        url: "{{ danbyte }}/api/applications/"
        method: POST
        headers: "{{ headers }}"
        body_format: json
        body: { name: "{{ item }}", slug: "{{ item }}" }
        status_code: [201, 400]   # 400: already in the catalog
      loop: "{{ report | intersect(ansible_facts.packages.keys()) }}"
      delegate_to: localhost
      run_once: true

    - name: Look up the application ids
      ansible.builtin.uri:
        url: "{{ danbyte }}/api/applications/?search={{ item }}&picker=1"
        headers: "{{ headers }}"
      loop: "{{ report | intersect(ansible_facts.packages.keys()) }}"
      register: apps
      delegate_to: localhost

    - name: Record what is installed
      ansible.builtin.uri:
        url: "{{ danbyte }}/api/installed-software/"
        method: POST
        headers: "{{ headers }}"
        body_format: json
        body:
          application_id: >-
            {{ (item.json.results | selectattr('slug', 'equalto', item.item)
                | first).id }}
          device_id: >-
            {{ (host.json.results | selectattr('name', 'equalto', inventory_hostname)
                | first).id }}
          version: "{{ ansible_facts.packages[item.item][0].version }}"
        status_code: [201, 400]   # 400: this version is already recorded
      loop: "{{ apps.results }}"
      delegate_to: localhost
```

For a virtual machine, look it up on `/api/virtual-machines/` and post
`virtual_machine_id` instead of `device_id`. The token needs `add` on
installed software (and on applications for the catalog step).

## Licences

Every component carries a licence when one is known. A licence is an
[SPDX licence expression](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/):
an identifier such as `MIT` or `Apache-2.0`, a `LicenseRef-…` for a licence
not on the SPDX list, or identifiers joined with `AND`, `OR`, `WITH` and
parentheses - `(MIT OR Apache-2.0) AND BSD-3-Clause`. Danbyte checks the
form, not the SPDX list, so a new identifier works straight away.

| Where | |
|---|---|
| **Application** | *License* on the application form and its Overview. Every install of it inherits it. |
| **Install** | *License* in the Software tab's dialog: an override for this install only, e.g. a dual-licensed product run under its commercial licence. Blank uses the application's. |
| **Platform** | *License* on the platform form: the OS's licence. |

The Software tab's *License* column shows the licence the SBOM reports,
with an *override* chip where the install sets its own. All three fields
are in [import and export](import-export.md) as the `license` column.

An unknown licence is left out of the SBOM, never guessed. The document
counts the gaps so you can fill them before you hand it in (see
[Metadata](#metadata)).

## Export

- **Devices** and **Virtual machines** lists: **Import / Export → SBOM
  (CycloneDX)** exports the rows the list shows now, with its filters and
  search applied.
- **Site** page: **Export SBOM** exports the site's devices and VMs.
- **API**: `GET /api/sbom/` (below).

The file is named `sbom-<site name>-<date>.cdx.json` for one site and
`sbom-selection-<date>.cdx.json` otherwise.

## The document

```json
{
  "$schema": "http://cyclonedx.org/schema/bom-1.6.schema.json",
  "bomFormat": "CycloneDX",
  "specVersion": "1.6",
  "serialNumber": "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
  "version": 1,
  "metadata": {
    "timestamp": "2026-11-03T09:30:00Z",
    "tools": {"components": [
      {"type": "application", "name": "Danbyte", "version": "0.19.0"}
    ]},
    "component": {"type": "platform", "bom-ref": "danbyte:site:…", "name": "AMS"},
    "properties": [
      {"name": "danbyte:hosts", "value": "2"},
      {"name": "danbyte:components", "value": "3"},
      {"name": "danbyte:components_without_license", "value": "1"},
      {"name": "danbyte:unlicensed", "value": "IOS-XE"}
    ]
  },
  "components": [
    {
      "type": "device", "bom-ref": "danbyte:device:…", "name": "rtr-01",
      "supplier": {"name": "Cisco"},
      "properties": [{"name": "danbyte:kind", "value": "device"}, …],
      "components": [
        {"type": "operating-system", "bom-ref": "danbyte:device:…:os",
         "name": "IOS-XE", "version": "17.9.4", "supplier": {"name": "Cisco"}}
      ]
    },
    {
      "type": "platform", "bom-ref": "danbyte:virtual_machine:…", "name": "db-01",
      "components": [
        {"type": "operating-system", "bom-ref": "danbyte:virtual_machine:…:os",
         "name": "Ubuntu", "version": "24.04", "supplier": {"name": "Canonical"},
         "licenses": [{"license": {"id": "GPL-2.0-only"}}]},
        {"type": "application", "bom-ref": "danbyte:installedsoftware:…",
         "name": "PostgreSQL", "version": "16.4", "supplier": {"name": "PGDG"},
         "licenses": [{"license": {"id": "PostgreSQL"}}]}
      ]
    }
  ],
  "dependencies": [
    {"ref": "danbyte:site:…", "dependsOn": ["danbyte:device:…", "danbyte:virtual_machine:…"]},
    {"ref": "danbyte:device:…", "dependsOn": ["danbyte:device:…:os"]},
    {"ref": "danbyte:virtual_machine:…", "dependsOn": ["danbyte:virtual_machine:…:os", "danbyte:installedsoftware:…"]}
  ]
}
```

- A **device** is a `device` component, its supplier the device type's
  manufacturer; a **virtual machine** is a `platform` component. Their
  properties carry the kind, id, site, role, cluster and device type.
- The **platform** is a nested `operating-system` component at the host's
  *Software version*, its supplier the platform's manufacturer.
- Each **install** is a nested `application` component at its version, its
  supplier the application's manufacturer.
- A licence that is one SPDX identifier is written as
  `{"license": {"id": …}}`; an expression or a `LicenseRef-…` as
  `{"expression": …}`.
- `dependencies` links the site (or the selection) to its hosts, and each
  host to what runs on it.
- Blank facts - no version, no manufacturer, no licence - are left out.

### Metadata

`metadata.component` is the site when the export covers exactly one, else
`selection`. `metadata.properties` reports:

| Property | |
|---|---|
| `danbyte:hosts` | Devices and VMs in the document. |
| `danbyte:components` | Operating-system and application components. |
| `danbyte:components_without_license` | Of those, how many have no licence. |
| `danbyte:unlicensed` | Their names, de-duplicated - the applications and platforms to fix. |

## API

`GET /api/sbom/` answers the document as an attachment
(`application/vnd.cyclonedx+json`). Filters take ids, repeated or
comma-separated; several values of one filter match any of them, and
filters combine:

| Filter | |
|---|---|
| `site` | Site ids. |
| `tag` | Tag ids or slugs. |
| `role` | Device role ids. |
| `device` | Device ids. |
| `virtual_machine` | Virtual machine ids. |

Given `device` or `virtual_machine`, only the listed hosts of each kind are
included; without either, every device and VM that matches the other
filters. `POST /api/sbom/` takes the same filters as a JSON body
(`{"device": ["…", "…"]}`) for a selection longer than a URL holds; a
read-only API token uses `GET`.

```bash
curl -H "Authorization: Token $TOKEN" -o sbom.cdx.json \
  "https://danbyte.example/api/sbom/?site=…&tag=openstack,proxmox"
```

The document covers the active tenant only, and only the devices and VMs
you may view; the installs need `view` on installed software too. Another
tenant's ids, or hosts outside your sites, are left out.
