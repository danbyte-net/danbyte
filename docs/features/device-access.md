---
icon: lucide/plug
---

# Device access - Connect & the SSH terminal

Danbyte can take you from a device or virtual machine record to a live session
on it. Two independent pieces do this:

- **Connect protocols** - user-defined launch buttons (`ssh://`, `telnet://`,
  `rdp://`, a web UI, or any custom scheme) that hand off to an app on your
  machine.
- **The in-browser SSH terminal** - an opt-in shell to the device or VM,
  brokered by Danbyte, that runs in the browser.

Both live on a device's or VM's action bar under the **Connect** button, and
both are gated on the **connect** permission for that type - *Devices* or
*Virtual machines* (see [Permissions](permissions.md)). One does not imply the
other.

## Device credentials

A **device credential** links a device - or a virtual machine - to a login
secret. Add and manage them in the **Credentials** card on a device's
**Access** tab or a VM's **Monitoring** tab (SSH password, SSH key, HTTPS
login, Windows login, Proxmox API token, VMware login or WinRM certificate).
[Discovery](discovery-credentials.md) logs in with the SSH ones and the
*WinRM certificate*, a client certificate and its private key (PEM) for
[WinRM over HTTPS](discovery-windows.md#over-winrm). Windows login, Proxmox
API token and VMware login are what PRTG's sensors get when a sensor profile
sets credentials **on the device** with none picked (see
[PRTG](prtg.md#where-credentials-go)): Windows takes `DOMAIN\user` as the
username, Proxmox `user@realm!tokenid` with the token secret as the password.

An SSH password or SSH key needs a **Username**: nothing logs in as a
guessed `root`. Other kinds may leave it blank.

Each credential sources its secret one of two ways:

- **Managed** (the default): you type the secret once and Danbyte stores it in
  the configured [secret store](../monitoring/certificates.md) - the local
  encrypted store **or** Vault (Vault KV holds the `{username, password}` /
  `{private_key}` JSON). Danbyte keeps only its own reference, always
  `device-credentials/<credential id>` inside the tenant's own folder; a
  `secret_path` sent with a managed credential is ignored.
- **External**: you point at an existing path you manage yourself (e.g. a Vault
  path your team already populates). Danbyte reads it at use-time and stores
  nothing. Only a **deployment administrator** can create an external
  credential, turn a managed one external, or change an external path: the path
  is read with the deployment's one store token, which every tenant shares, so
  naming one is a deployment-level act. Anyone with *change* on the credential
  can still edit its name, username and port.

An external path must be relative and slash-separated, with no `..`, empty or
`.` segments, backslashes, `?`, `#` or control characters, and it may not lie
inside Danbyte's own managed namespace of **any** tenant - on Vault that is
`<mount>/data/<tenant id>/…` in every KV v2 form (`data`, `metadata`,
`subkeys`, …), on Azure Key Vault a `danbyte-<tenant id>-…` name, and on the
local store a `device-credentials/`, `wireless-lans/`, `ipsec-profiles/`,
`routing-keychains/`, `shared-credentials/`, `csr/` or `issuer/` ref. Paths are compared after
percent-decoding. A credential saved before these rules whose path breaks them
is refused at reveal and connect time with the reason; one that follows them
keeps working.

Either way the value is never returned in the API.

- The value is returned only by the **reveal** action, which is gated on its own
  **reveal** permission (independent of *change* - being able to edit a
  credential does not let you read its secret) and is written to the change log.
- SSH credentials (password or key) are what the in-browser terminal
  authenticates with; the secret is fetched at connect time and never sent to
  the browser.

## Shared credentials

A **shared credential** is one login for many hosts: "the ops account on
every Linux VM at HQ". Manage them under **Settings → Devices & polling →
Credentials**. Each has a kind, user name (required for the SSH kinds)
and port like a device credential, and its secret is held exactly the same way - managed or
external, write-only, in the secret store under
`shared-credentials/<credential id>`, readable only through **reveal** with
the *reveal* permission, change-logged without the value.

**Scope** decides which hosts it is for:

- **Devices** and **Virtual machines** say which kinds of host it applies to.
- **Roles**, **Device types**, **Platforms**, **Sites** and **Tags** each
  narrow it: a host matches when it has one of the picked values in *every*
  list you filled in. A VM has no device type, so a set naming device types
  never matches a VM.
- With every list empty it matches **nothing**, unless **All hosts** is on.
  A shared credential never applies everywhere by accident.

The dialog shows how many hosts the scope matches as you edit it
(`POST /api/monitoring/shared-credentials/preview/`; a saved one answers
`GET …/<id>/matches/`).

### Which login a host gets

One rule, in `monitoring/credentials.py`, picks the logins for a host: its
own device credentials, then a shared credential a consumer pinned, then the
enabled shared credentials whose scope matches, lowest **Weight** first. At
most three are tried, and a refused password is followed by another only when
its shared credential has **Try the next if refused** on. Today [Discovery](discovery-credentials.md#which-login-a-host-gets)
uses this rule, and documents it in full; Connect and the terminal still use
the device's own credentials.

### Permissions

Shared credentials are their own permission type (**Shared credentials**),
with the **reveal** verb like device credentials. A person whose grant is
limited to sites sees and changes only shared credentials scoped to those
sites, must name at least one of them, and cannot set **All hosts**.

## Connect protocols

A **connect protocol** is a launch-URL template. Manage the catalog under
**Settings → Connect protocols**. Each has:

- a **name** and **icon**,
- a **URL template** with `{placeholders}` - `{host}`, `{username}`, `{port}`,
  `{name}`,
- an optional **default port** and a **weight** (lower sorts first),
- **enabled** on/off,
- optional **targeting** (see below).

A fresh tenant starts with an editable **SSH / Telnet / RDP / HTTP / HTTPS**
catalog; rename, edit, disable, or delete them and add your own freely.

When you open **Connect** on a device, Danbyte fills the placeholders from the
device (primary IP → OOB IP → name for `{host}`; a chosen credential's username
for `{username}`). On a VM `{host}` is its primary IP, else its name, and the
usernames come from the VM's own credentials. Danbyte then hands the result
to your operating system's protocol handler - so `ssh://…` opens your SSH
client, `rdp://…` your remote-desktop client, and a web URL opens in a new
tab. Each entry also offers **Copy URL**
and, for SSH, **Copy SSH command** (handy for pasting into an external label or
terminal program).

Custom schemes work as long as your OS has a handler registered for them (for
example a `myproto://` handler in the Windows registry).

### Targeting by device type or role

By default a protocol shows on every device and VM. Under **Applies to** you can
restrict it to specific **device types** and/or **roles**. A device then sees a
protocol when it is untargeted, **or** its device type is in the list, **or**
its role is - so you can offer, say, an `rdp://` button only on Windows-server
roles and a serial-console URL only on a console-server type.

A VM sees untargeted protocols and those whose roles include its role. A VM
has no device type, so the device-type half never matches it
(`GET /api/monitoring/connect-protocols/?enabled=1&virtual_machine=<id>`).

## The in-browser SSH terminal

The terminal opens a real SSH session to the device or VM and renders it in
the browser. It is **off by default** - a deployment admin enables it under
**Settings → Security → In-browser SSH terminal**, because bridging a browser to
a device shell is a high-trust capability.

When enabled, an **Open web terminal** entry appears in the **Connect** menu for
users who hold the *connect* permission on that type. Choose how to
authenticate:

- **Stored credential** - use one of the host's own saved SSH credentials (a
  device's **Access** tab, a VM's **Credentials** card on its **Monitoring**
  tab). [Shared credentials](#shared-credentials) are not offered here.
- **My login** - type your own username (defaulting to your Danbyte account) and
  password. They are sent once over the (TLS) WebSocket, used only for that
  session, and never stored - for environments where each operator has their own
  device account (e.g. an LDAP/AD-backed switch).

Security properties, enforced server-side on every session:

- **Authorized at connect time** - the session re-checks your login, active
  tenant, the *connect* permission and view access on that specific device or
  VM (a grant limited to sites must cover its site).
- **Credential stays server-side** - the secret is fetched through the
  tenant-scoped, audited credential store and used only to authenticate the
  outbound SSH; it never reaches the browser.
- **Connects only to the host's own recorded address** - a device's primary IP,
  else its OOB IP; a VM's primary IP. Never a caller-supplied host, so the
  terminal can't be turned into a way to reach arbitrary hosts. Management
  addresses are usually private, so the outbound address policy that guards
  webhooks and integrations is not applied here; the recorded-address rule is
  the guard, the same for devices and VMs.
- **Host key verified** - the host's recorded [SSH host
  keys](../monitoring/ssh-host-keys.md) pin the connection, so a changed or
  wrong key aborts the session *before* the credential is sent. A host with no
  recorded key requires you to explicitly **accept the new host** first
  (trust-on-first-use), exactly like a normal SSH client; the error links to
  the host's **Certificates** tab, where its keys are listed.
- **Audited** - opening a session is recorded in the change log against the
  device or VM (who connected, to which address, and when).

Idle and maximum-duration limits close forgotten sessions automatically. A
session already open is not closed when a permission, the setting or the host
is removed; the next connect is refused.

Sessions run from the Danbyte server. The terminal is not relayed through an
[Outpost](../monitoring/outposts.md), for devices or VMs, so the server needs
SSH reach to the host.

The WebSocket is `/ws/ssh/<device id>/` for a device and
`/ws/ssh/vm/<vm id>/` for a VM.

!!! note "WebSockets must be reachable"
    The terminal uses a WebSocket to the `daphne` ASGI process. In a standard
    install nginx already proxies `/ws/` to it; if the terminal can't connect,
    confirm that route is in place.
