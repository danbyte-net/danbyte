---
icon: lucide/git-compare-arrows
---

# Config drift & sync with Ansible / Terraform

Danbyte is the **source of truth**. You describe how a device *should* be
configured in Danbyte; an external runner (Ansible, Terraform, Nornir, …) reads
the **actual** config off the real device and hands it back; Danbyte renders the
**intended** config from your data, diffs the two, and shows **drift** vs
**in&nbsp;sync** on the device's **Config** tab and the tenant drift board.

!!! note "Credentials never live in Danbyte"
    The runner holds the device credentials. Danbyte stores only *intent* and
    the *reported* state — a Danbyte breach can never reconfigure your fleet.

## Where do I click? (orientation)

Most of the confusion is "this is configured *where*?". Every piece is one of
these five spots in the Danbyte UI — the **How automation works** panel on the
**Integrations → Automation targets** page shows the same map in-app:

| To… | Go to |
|---|---|
| Define what the config **should** be | **Customize → Config contexts** + **Export templates** |
| Connect the system that runs your playbooks | **Integrations → Automation targets** |
| Fire a deploy for one device | a **device → Config tab → Deploy** |
| See past dispatches (read-only history) | **Integrations → Deploy runs** |
| Turn the scheduled drift check on/off | **Admin → Settings** |

!!! tip "Guided setup"
    First time? **Integrations → Automation targets → Guided setup** walks you
    through connecting a target (AWX/AAP or a webhook) in three steps and tells
    you what to do next. It creates the exact same target as the manual form.

!!! info "The Deploy runs page is just history"
    **Deploy runs** is a read-only log of "Danbyte handed off to a runner at
    14:32, got a 200 back" — like the audit log, nothing is editable there. To
    change *how* a deploy is dispatched, edit its **automation target**.

## What lives where

Two systems, on purpose — **Danbyte does not run Ansible**:

| | Danbyte | The runner (Ansible / Terraform) |
|---|---|---|
| **Role** | Source of truth + drift dashboard | The hands that touch devices |
| **Holds** | Intent (config contexts, export templates) + reported state | Device credentials (SSH keys, secrets) |
| **Touches devices** | Never | Yes — over SSH / API |
| **Lives** | Your Danbyte server | A box *you* control (a runner host, CI, AWX) |
| **You click here** | Customize → Config contexts / Export templates; the device **Config** tab | A cron job / pipeline — outside Danbyte |

The **"via ansible"** on a drift result is just the `source` label the runner
stamped on its report — it tells you *who reported*, not that Danbyte ran
anything. Ansible talks to Danbyte over the API like any other client.

!!! tip "Changing a value is a one-place edit"
    To change a device's NTP server (or DNS, domain, an IP …) you edit the
    **config context** — never the runner:
    **Customize → Config contexts → `network-baseline` → set `ntp_servers` → Save.**
    The next runner pass renders the new intent and flags any device that hasn't
    caught up as drift. Modularity comes from **scope**: a config context applies
    to *all* devices, or only `site = AMS` / `role = firewall` / a platform / a
    tag, and they stack by weight — a site override layers on top of a global
    baseline.

## The flow

```text
 ┌──────────┐   1. GET inventory (Danbyte data) ┌──────────────┐
 │  Danbyte │ ─────────────────────────────────▶│    Runner    │
 │ (truth)  │                                    │ Ansible / TF │
 │          │◀──────────────────────────────────│              │
 └──────────┘   3. POST actual + template id     └──────┬───────┘
       ▲        Danbyte renders intent & diffs           │ 2. read running
       │                                                 ▼   config (SSH/API)
       │ 4. drift shown on the Config tab          ┌──────────┐
       └───────────────────────────────────────────│  device  │
                                                   └──────────┘
```

## Step 1 — describe the intent *in Danbyte*

The "intended config" is built from two things you create in **Customize**, so
you never hard-code values in the runner:

**Config context** — the *data* (variables). This is where a value like the NTP
server lives. Scope it to *all* devices, or by site / role / platform / tags:

```json
{ "ntp_servers": ["192.168.0.1", "192.168.0.2"],
  "dns_servers": ["192.168.0.1"],
  "syslog_host": "192.168.0.10",
  "domain":      "lab.acme.internal" }
```

**Export template** (object type `device`) — Jinja that turns that data, the
device's fields, and its [assigned IPs](../dcim/ip-assignment.md) into config
text:

```jinja
hostname {{ device.name }}
ip domain-name {{ config_context.domain | default('example.com') }}
!
{% for s in config_context.ntp_servers | default([]) %}
ntp server {{ s }}
{% endfor %}
{% for s in config_context.dns_servers | default([]) %}
ip name-server {{ s }}
{% endfor %}
{% if config_context.syslog_host %}
logging host {{ config_context.syslog_host }}
{% endif %}
!
{% for i in interfaces %}
interface {{ i.name }}
{% for ip in ip_addresses %}
{% if ip.assigned_interface_id == i.id %}
 ip address {{ ip.ip_address }}
{% endif %}
{% endfor %}
{% endfor %}
```

Template context: `device`, `config_context` (merged), `interfaces`,
`ip_addresses`. The device's **Config → Render config** box renders this on
demand — and you can [bind the template](export-templates.md#config-template-bindings)
to the device, its role, or its platform so the box (and
`GET /api/devices/<id>/render/`) picks it automatically. For `edge-fw-demo` it produces:

```text
hostname edge-fw-demo
ip domain-name lab.acme.internal
!
ntp server 192.168.0.1      ← from the config context
ntp server 192.168.0.2      ← from the config context
ip name-server 192.168.0.1  ← from the config context
logging host 192.168.0.10   ← from the config context
!
interface eth0
 ip address 192.168.0.50    ← from IPAM (the assigned IP object)
```

So **the NTP server is a config-context value** (not a Service — Services
document the *ports a device exposes*, for monitoring). Change it in the UI and
the rendered intent changes with it.

## Step 2 — authenticate the runner

Mint a token under **Settings → API tokens** (scoped to one tenant):

```bash
export DANBYTE_URL=https://danbyte.example.com
export DANBYTE_TOKEN=dbt_xxxxxxxxxxxxxxxxxxxxxxxx
```

## Step 3 — the two endpoints a runner needs

| Endpoint | Purpose |
|---|---|
| `GET /api/inventory/ansible/` | Native Ansible dynamic inventory — hosts, `ansible_host` (primary IP), `danbyte` metadata (incl. `danbyte.custom_fields` and `danbyte.interfaces`), merged `config_context`, and `role_<slug>` / `site_<name>` / `platform_<slug>` / `status_<slug>` / `tag_<slug>` / `cf_<name>` groups. Filter with `?status=active&site=AMS&role=leaf&has_primary_ip=1`. |
| `POST /api/devices/<id>/config-state/` | Report a device's config. Send `actual_config` + a `template` id and **Danbyte renders the intent** (config context + IPAM) and diffs it → `status` ∈ `in_sync \| drift \| unknown`, the unified `diff`, and a history snapshot on change. (Or send `intended_config` yourself if the runner does the templating.) |

## Ansible demo

`inventory.py` proxies Danbyte's inventory:

```python
#!/usr/bin/env python3
import os, sys, urllib.request
req = urllib.request.Request(f"{os.environ['DANBYTE_URL']}/api/inventory/ansible/",
        headers={"Authorization": f"Token {os.environ['DANBYTE_TOKEN']}"})
print("{}" if "--host" in sys.argv else urllib.request.urlopen(req).read().decode())
```

`drift_check.yml` — pull the actual config and let Danbyte render + diff:

```yaml
- hosts: all
  gather_facts: false
  vars:
    base: "{{ lookup('env','DANBYTE_URL') }}"
    tok:  "{{ lookup('env','DANBYTE_TOKEN') }}"
  tasks:
    - name: Resolve the export template id by name
      ansible.builtin.uri:
        url: "{{ base }}/api/export-templates/?page_size=200"
        headers: { Authorization: "Token {{ tok }}" }
      delegate_to: localhost
      register: ets
    - ansible.builtin.set_fact:
        template_id: "{{ (ets.json.results | selectattr('name','equalto','baseline-config') | list | first).id }}"

    - name: Read the running config off the device
      ansible.builtin.raw: cat /etc/netdev/running.conf   # or: show running-config
      register: running
      changed_when: false

    - name: Report actual — Danbyte renders intent from the template and diffs
      ansible.builtin.uri:
        url: "{{ base }}/api/devices/{{ danbyte.id }}/config-state/"
        method: POST
        headers: { Authorization: "Token {{ tok }}" }
        body_format: json
        body:
          actual_config: "{{ running.stdout }}"
          template: "{{ template_id }}"
          source: ansible
        status_code: [200, 201, 202]
      delegate_to: localhost
```

```bash
ansible-playbook -i inventory.py drift_check.yml
```

### Editing data in the UI shows up as drift

Because Danbyte renders the intent, you don't touch the runner to change a
policy. Bump the NTP server in the config context from `192.168.0.1` →
`192.168.0.99` and re-run — the device is unchanged, so Danbyte flags drift:

```diff
--- intended
+++ actual
-ntp server 192.168.0.99
+ntp server 192.168.0.1
 ntp server 192.168.0.2
```

A *push/remediate* playbook would then apply the new NTP server to the device,
and the next check returns to **in&nbsp;sync**. (Danbyte itself never touches the
device — that's the runner's job, with the runner's credentials.)

## Terraform demo

Terraform's role is **provisioning from Danbyte's allocations** — read an
object's reserved address out of the API and stand the resource up at it:

```hcl
terraform {
  required_providers {
    docker = { source = "kreuzwerker/docker" }
    http   = { source = "hashicorp/http" }
  }
}
variable "danbyte_url"   { default = "https://danbyte.example.com" }
variable "danbyte_token" { type = string, sensitive = true }
variable "device_id"     { type = string }

data "http" "ips" {                                   # Danbyte = source of truth
  url             = "${var.danbyte_url}/api/devices/${var.device_id}/ips/"
  request_headers = { Authorization = "Token ${var.danbyte_token}" }
}
locals { device_ip = jsondecode(data.http.ips.response_body).results[0].ip_address }

resource "docker_network" "lan" {
  name    = "danbyte-lan"
  driver  = "macvlan"
  options = { parent = "eno2" }
  ipam_config { subnet = "192.168.0.0/24", gateway = "192.168.0.1" }
}
resource "docker_container" "device" {
  name  = "edge-fw-demo"
  image = "danbyte-netdev:demo"
  networks_advanced {
    name         = docker_network.lan.name
    ipv4_address = local.device_ip   # ← the IP Danbyte allocated
  }
}
```

```bash
terraform apply -var device_id=<uuid> -var danbyte_token=$DANBYTE_TOKEN
```

You now have a real host at the address Danbyte reserved — point the Ansible
playbook at it to close the loop.

## How the runner actually runs

Danbyte never schedules it — *you* do. Pick what fits:

- **Cron / systemd timer** on the runner host — `ansible-playbook drift_check.yml`
  every few minutes for continuous, hands-off drift detection.
- **On demand** — run it by hand, or from CI right after a change.
- **Danbyte "Deploy"** — register an **automation target** (an AWX job template or
  a webhook). A device's **Deploy** button (or `POST /api/devices/<id>/deploy/`)
  then tells *that* system to launch the run. Danbyte hands off the work; it still
  never touches the device itself.

### Deploy runs, retries, and remediate

Every dispatch is recorded as a **deploy run** (Integrations → Deploy runs, and
the device's Config tab). Each run carries its `event`, `attempt`, dispatch
`duration`, and the target's response in `detail`.

- **A run that fails** (target unreachable, non-2xx, disabled) is marked
  `failed` with the reason. Hit **Retry** on the row (or
  `POST /api/deploy-runs/<id>/retry/`) to re-fire the *same* target + devices as
  a new run — linked back via `retry_of`, with `attempt` bumped. Retry is
  offered only while the target still exists and is enabled.
- **Remediate** is just a deploy whose playbook *pushes* the intended config and
  then re-checks drift, so a drifted/failed device returns to **in sync** in one
  run. The companion runner ships a `remediate.yml` (`sync.yml` →
  `drift_check.yml`); trigger it with a `remediate` event from the Deploy button
  or run `ansible-playbook -i inventory.py remediate.yml` by hand.

## Groups and interfaces (network automation)

The inventory is pre-grouped the way you'd group hosts by hand — so a play can
target a slice of the fleet with no `when:`:

| Group | From |
|---|---|
| `role_<slug>` | Device role (`role_leaf`, `role_firewall`) |
| `site_<name>` · `region_<name>` | Site / region |
| `platform_<slug>` | Platform (`platform_ios`) |
| `status_<slug>` | Status (`status_active`) |
| `tag_<slug>` | Each tag |
| `cf_<name>` | Each boolean custom field that's **on** |

Each host also carries its **interfaces** at `danbyte.interfaces` — name, type,
MTU, MAC, enabled, VLAN, and assigned IPs (bare `address` + `cidr`) — so a
network play can render per-interface config straight from Danbyte + IPAM:

```yaml
- hosts: role_leaf
  gather_facts: false
  tasks:
    - name: Show the intended L3 interfaces
      ansible.builtin.debug:
        msg: "{{ item.name }} → {{ item.ip_addresses | map(attribute='cidr') | join(', ') }}"
      loop: "{{ danbyte.interfaces | selectattr('ip_addresses') | list }}"
      loop_control: { label: "{{ item.name }}" }
```

```jsonc
// danbyte.interfaces for one host
[
  { "name": "eth0", "type": "1000base-t", "enabled": true, "mtu": 1500,
    "mac_address": "00:11:22:33:44:55", "virtual": false,
    "vlan": { "vid": 100, "name": "prod" },
    "ip_addresses": [ { "address": "10.0.0.5", "cidr": "10.0.0.5/24" } ],
    "tags": [], "custom_fields": {} }
]
```

## Advanced: feature-flag a playbook from a custom field

A per-device boolean custom field can gate a play — flip it in the UI, the next
run installs (or removes) the thing. See
[Advanced: custom-field-driven playbook](cf-driven-playbook.md) for the full
`install_btop` worked example.

## Where it shows up

- **Device → Config tab** — status badge, the rendered intent, and the diff.
- **Device → Config tab → Ansible inventory** — a read-only preview of the
  groups + hostvars a runner sees for this device (its slice of
  `/api/inventory/ansible/`), with a Copy button. Verify the export without
  curling the API. Per-device endpoint: `GET /api/devices/<id>/inventory/`.
- **Config drift board** — `GET /api/config-states/?status=drift`, by status.
- **History** — `GET /api/config-snapshots/?device=<id>` — the drift→sync timeline.
