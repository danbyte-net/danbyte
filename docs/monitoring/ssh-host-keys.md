# SSH host keys

Danbyte records a device's expected SSH **host key** and compares it to the key
actually presented on port 22. A device serving a key you didn't record is
drift - key rotation, a reinstall, or a man-in-the-middle. This is the same
observe → source-of-truth → drift model as the [certificate inventory](certificates.md),
scoped to a device.

!!! danger "Public keys only"
    A private key is never stored, requested, or accepted. There is no field for
    one, and the model refuses to persist anything that looks like key material.
    Upload only the **public** host key.

## Virtual machines and discovery

A VM keeps host keys too (`"virtual_machine": "<vm-id>"` in place of
`device`, `?virtual_machine=` on the list; the panel is on the VM's
**Certificates** tab). Drift alerts attach to a device's address, so a VM's
keys raise none. They pin the VM's [in-browser SSH
terminal](../features/device-access.md#the-in-browser-ssh-terminal) the same
way a device's keys pin its own: every recorded key is trusted, any other
key aborts the session, and a VM with none asks you to accept the new host.

[Discovery](../features/discovery.md#host-keys-and-credentials) reads a host
only when it presents an **accepted** key - uploaded, or observed and then
accepted. A host it refuses has the key it presented recorded as observed,
so you can check the fingerprint and accept it here.

### Accepting many at once, and on first use

A discovery profile's and a run's **Host keys** tab lists the keys its hosts
presented that nobody accepted yet - host, address, type, SHA256
fingerprint, first seen - with a box per row and **Accept N keys**
(`POST /api/discovery/host-keys/accept/`, `{ids: [...]}`). It needs *change*
on SSH host keys, inside your site scope, and each key accepted is
change-logged. A key that differs from one already accepted for the same
host and type is shown as **Differs from accepted key** and is never
accepted from that list - check the host, then accept it here on its own.

**Run now** can also *Accept new host keys*: for a host with no accepted key
at all, the key it presents on that run is accepted and the login goes on
over that same connection. This is **not advised** - if something sits
between Danbyte and the host on that first contact, it is the one trusted.
It is unticked every time, never used by scheduled runs, needs *change* on
SSH host keys, and a deployment can switch it off
(`DANBYTE_DISCOVERY_ALLOW_FIRST_USE_KEYS`). A host whose key differs from an
accepted one is still refused. Each key accepted this way is change-logged
as the person who started the run, with the run named as the cause.

## Recording an expected key

`POST /api/monitoring/ssh-host-keys/` with a device and a pasted OpenSSH
public-key line:

```json
{"device": "<device-id>", "public_key_line": "ssh-ed25519 AAAAC3Nza… host"}
```

The type, blob, comment and `SHA256:…` fingerprint are parsed from the line -
never trusted from the payload. Returns **201** for a new key, or **200** if the
fingerprint already exists (e.g. it was already observed): the same key seen on
the wire and declared by hand is one row, marked both `observed` and `uploaded`.

A private key, a PEM certificate, or anything that isn't a public SSH key is a
clean **400** (a pasted certificate is pointed at the [certificate](certificates.md)
page instead).

The device must be in the active tenant - any other id is a **400** on
`device` (`Not found in this tenant.`) - and, for a site-scoped user, in one of
their sites (otherwise **403**).

A key belongs to the device it was recorded on, so there is no edit: `PUT` and
`PATCH` answer **405**. To move a key, delete it and upload it on the other
device.

## Observation and drift

The SSH check captures the host key the device presents and records it as an
`observed` key. When a device presents a key that no **uploaded** (expected) key
of the same type matches, `ssh_host_key_mismatch` fires through the normal alert
engine - ack, silence, renotify and every channel apply. It resolves when the
presented key matches an expected one, or once you **accept** the served key
(`POST /api/monitoring/ssh-host-keys/{id}/accept-observed/`), which declares that
observed key as expected. Observation never changes intent on its own.

Filters on the list: `?device=<id>`, `?origin=observed|uploaded|both`,
`?key_type=ssh-ed25519`.

## In the UI

A device's **Certificates & keys** tab has an **SSH host keys** section: the
expected and observed keys with their type, fingerprint and origin, a drift
banner when they disagree, an **Add host key** paste dialog, and an **Accept**
action on an observed key to adopt it as expected.
