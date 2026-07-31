# SSH host keys

Danbyte records a device's expected SSH **host key** and compares it to the key
actually presented on port 22. A device serving a key you didn't record is
drift — key rotation, a reinstall, or a man-in-the-middle. This is the same
observe → source-of-truth → drift model as the [certificate inventory](certificates.md),
scoped to a device.

!!! danger "Public keys only"
    A private key is never stored, requested, or accepted. There is no field for
    one, and the model refuses to persist anything that looks like key material.
    Upload only the **public** host key.

## Recording an expected key

`POST /api/monitoring/ssh-host-keys/` with a device and a pasted OpenSSH
public-key line:

```json
{"device": "<device-id>", "public_key_line": "ssh-ed25519 AAAAC3Nza… host"}
```

The type, blob, comment and `SHA256:…` fingerprint are parsed from the line —
never trusted from the payload. Returns **201** for a new key, or **200** if the
fingerprint already exists (e.g. it was already observed): the same key seen on
the wire and declared by hand is one row, marked both `observed` and `uploaded`.

A private key, a PEM certificate, or anything that isn't a public SSH key is a
clean **400** (a pasted certificate is pointed at the [certificate](certificates.md)
page instead).

## Observation and drift

The SSH check captures the host key the device presents and records it as an
`observed` key. When a device presents a key that no **uploaded** (expected) key
of the same type matches, `ssh_host_key_mismatch` fires through the normal alert
engine — ack, silence, renotify and every channel apply. It resolves when the
presented key matches an expected one, or once you **accept** the served key
(`POST /api/monitoring/ssh-host-keys/{id}/accept-observed/`), which declares that
observed key as expected. Observation never changes intent on its own.

Filters on the list: `?device=<id>`, `?origin=observed|uploaded|both`,
`?key_type=ssh-ed25519`.
