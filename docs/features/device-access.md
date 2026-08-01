---
icon: lucide/plug
---

# Device access — Connect & the SSH terminal

Danbyte can take you from a device record to a live session on the device. Two
independent pieces do this:

- **Connect protocols** — user-defined launch buttons (`ssh://`, `telnet://`,
  `rdp://`, a web UI, or any custom scheme) that hand off to an app on your
  machine.
- **The in-browser SSH terminal** — an opt-in shell to the device, brokered by
  Danbyte, that runs in the browser.

Both live on a device's action bar under the **Connect** button, and both are
gated on the device **connect** permission (see [Permissions](permissions.md)).

## Device credentials

A **device credential** links a device to a secret an operator manages
elsewhere. Danbyte stores only a *reference* — the provider (the local encrypted
store or Vault) and a path — never the secret value. Add credentials on the
device's **Monitoring** tab.

- The value is returned only by the **reveal** action, which is gated on its own
  **reveal** permission (independent of *change* — being able to edit a
  credential does not let you read its secret) and is written to the change log.
- SSH credentials (password or key) are what the in-browser terminal
  authenticates with; the secret is fetched at connect time and never sent to
  the browser.

## Connect protocols

A **connect protocol** is a launch-URL template. Manage the catalog under
**Settings → Connect protocols**. Each has:

- a **name** and **icon**,
- a **URL template** with `{placeholders}` — `{host}`, `{username}`, `{port}`,
  `{name}`,
- an optional **default port** and a **weight** (lower sorts first),
- **enabled** on/off,
- optional **targeting** (see below).

A fresh tenant starts with an editable **SSH / Telnet / RDP / HTTP / HTTPS**
catalog; rename, edit, disable, or delete them and add your own freely.

When you open **Connect** on a device, Danbyte fills the placeholders from the
device (primary IP → OOB IP → name for `{host}`; a chosen credential's username
for `{username}`) and hands the result to your operating system's protocol
handler — so `ssh://…` opens your SSH client, `rdp://…` your remote-desktop
client, and a web URL opens in a new tab. Each entry also offers **Copy URL**
and, for SSH, **Copy SSH command** (handy for pasting into an external label or
terminal program).

Custom schemes work as long as your OS has a handler registered for them (for
example a `myproto://` handler in the Windows registry).

### Targeting by device type or role

By default a protocol shows on every device. Under **Applies to** you can
restrict it to specific **device types** and/or **roles**. A device then sees a
protocol when it is untargeted, **or** its device type is in the list, **or**
its role is — so you can offer, say, an `rdp://` button only on Windows-server
roles and a serial-console URL only on a console-server type.

## The in-browser SSH terminal

The terminal opens a real SSH session to the device and renders it in the
browser. It is **off by default** — a deployment admin enables it under
**Settings → Security → In-browser SSH terminal**, because bridging a browser to
a device shell is a high-trust capability.

When enabled, an **Open web terminal** entry appears in the **Connect** menu for
users who hold the device *connect* permission. Pick an SSH credential and
connect.

Security properties, enforced server-side on every session:

- **Authorized at connect time** — the session re-checks your login, active
  tenant, the device *connect* permission, and view access to that specific
  device.
- **Credential stays server-side** — the secret is fetched through the
  tenant-scoped, audited credential store and used only to authenticate the
  outbound SSH; it never reaches the browser.
- **Connects only to the device's own management IP** — never a
  caller-supplied host, so the terminal can't be turned into a way to reach
  arbitrary hosts.
- **Host key verified** — the device's recorded [SSH host
  keys](../monitoring/ssh-host-keys.md) pin the connection, so a changed or
  wrong key aborts the session *before* the credential is sent. A device with no
  recorded key requires you to explicitly **accept the new host** first
  (trust-on-first-use), exactly like a normal SSH client.
- **Audited** — opening a session is recorded in the change log (who connected
  to which device, and when).

Idle and maximum-duration limits close forgotten sessions automatically.

!!! note "WebSockets must be reachable"
    The terminal uses a WebSocket to the `daphne` ASGI process. In a standard
    install nginx already proxies `/ws/` to it; if the terminal can't connect,
    confirm that route is in place.
