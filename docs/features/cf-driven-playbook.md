---
icon: lucide/toggle-right
---

# Advanced: drive a playbook from a custom field

A per-device **custom field** can act as a feature flag your runner reads
straight out of Danbyte's Ansible inventory. Flip a boolean on a device in the
UI, and the next playbook run does (or skips) the work — no playbook edit, no
inventory file change.

The worked example: a boolean custom field **`install_btop`**. Set it `true` on
a device and a runner installs [btop](https://github.com/aristocratos/btop); set
it back to `false` (or never set it) and the device is left alone.

!!! note "Same rules as the rest of config drift"
    Danbyte stores only the *flag*. The runner holds the device credentials and
    does the install — Danbyte never touches the device. See the
    [config-drift guide](iac-runner.md) for the full model.

## 1 — define the custom field

**Customize → Custom fields → Add**:

| Field | Value |
|---|---|
| **Name** | `install_btop` |
| **Type** | Boolean |
| **Applies to** | Device |
| **Label** | *Install btop* (optional, friendlier UI label) |

The **name** (`install_btop`) is the key you'll read in the playbook — keep it
lowercase with underscores so it's a clean Ansible variable and group name.

## 2 — set it on a device

Open a device → edit → toggle **Install btop** on → save. (Or bulk-set it on
many devices at once, or via `PATCH /api/devices/<id>/`
`{"custom_fields": {"install_btop": true}}`.)

## 3 — it shows up in the inventory

`GET /api/inventory/ansible/` now carries the flag two ways for the devices you
set it on:

```json
{
  "cf_install_btop": { "hosts": ["sw1", "edge-fw-demo"] },   // ← a ready-made group
  "_meta": {
    "hostvars": {
      "sw1": {
        "ansible_host": "10.0.0.5",
        "danbyte": {
          "id": "…",
          "role": "leaf",
          "custom_fields": { "install_btop": true }            // ← and a hostvar
        }
      }
    }
  }
}
```

- Every **boolean** custom field that's **on** becomes a `cf_<name>` **group** —
  so you can target `hosts: cf_install_btop` directly.
- *All* custom fields (any type) are also readable per host at
  `danbyte.custom_fields.<name>`.

## 4 — the playbook

Two equivalent styles — pick one.

**a) Target the group** (cleanest when the flag *is* the audience):

```yaml
# install_btop.yml
- hosts: cf_install_btop
  become: true
  tasks:
    - name: Install btop
      ansible.builtin.package:
        name: btop
        state: present
```

```bash
ansible-playbook -i inventory.py install_btop.yml
```

Only devices with the flag on are in `cf_install_btop`, so the play simply has
nothing to do elsewhere.

**b) Run everywhere, gate per host** (handy when one play handles several
flags, or you also want the *off* case to actively uninstall):

```yaml
- hosts: all
  become: true
  tasks:
    - name: Ensure btop matches the Danbyte flag
      ansible.builtin.package:
        name: btop
        state: "{{ 'present' if danbyte.custom_fields.install_btop | default(false) else 'absent' }}"
```

Because the task is idempotent (`state: present`), re-running is safe — it only
acts on devices that have drifted from the flag.

## 5 — run it

Same three options as any runner work (Danbyte never schedules it):

- **Cron / systemd timer** on the runner host — converge the fleet every N minutes.
- **On demand** — `ansible-playbook …` by hand or from CI after you flip a flag.
- **Danbyte "Deploy"** — register an [automation target](iac-runner.md#how-the-runner-actually-runs)
  (AWX job template or webhook) and hit a device's **Deploy** button; Danbyte
  tells that system to launch the run.

## Why this is nice

- **Self-service** — a non-Ansible operator flips a checkbox in Danbyte; the
  automation owner never edits inventory or playbooks.
- **Auditable** — the flag change is in Danbyte's [change log](change-log.md):
  who turned btop on, and when.
- **Composable** — add `enable_netdata`, `harden_ssh`, `monitoring_agent`… each
  a boolean CF and a `cf_<name>` group. One inventory, many feature flags.

!!! tip "Beyond booleans"
    Non-boolean custom fields don't create groups but are still readable as
    hostvars — e.g. a text CF `syslog_profile` at
    `danbyte.custom_fields.syslog_profile` can select which template a play
    applies. Reach for a [config context](config-contexts.md) instead when the
    value is shared network-wide policy data rather than a per-device toggle.
