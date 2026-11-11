---
icon: lucide/key-round
---

# Discovery: credentials and host keys

A package inventory sends a credential to every host it reads. This page
says which credential a host gets, where the secret lives, and how Danbyte
makes sure it sends it to the right host. A service scan sends no credential
and uses none of this.

!!! info "Where to find it"
    - A host's own credentials: the **Credentials** card on a device's
      **Access** tab or a VM's **Monitoring** tab.
    - Shared credentials: **Settings → Devices & polling → Credentials**.
    - Pinning one on a profile: **Credential** in the profile dialog.
    - Keys to review: the **Host keys** tab of a profile or a run.
    - All recorded keys of one host: the **SSH host keys** panel on a
      device's **Certificates & keys** tab, a VM's **Certificates** tab.
    - The transport switches: **Host discovery** (**Monitoring** page →
      **Settings** tab).

## Host credentials and shared credentials

Discovery logs in with three credential kinds: **SSH key**, **SSH password**
and **WinRM certificate**. Each can be held two ways:

- a **device credential** on one device or VM - its own login;
- a **shared credential** for many hosts, with a **Scope** of **Devices**,
  **Virtual machines**, **Roles**, **Device types**, **Platforms**,
  **Sites** and **Tags**. A host matches when it has one of the picked
  values in every list that is filled in; with every list empty it matches
  nothing unless **All hosts** is on. The fields and their permissions are
  on [Device access: shared credentials](device-access.md#shared-credentials).

Fill in **User name**: a credential without one logs in as `root`. Give it
an ordinary account ([least privilege](discovery-packages.md#least-privilege)).

### Which login a host gets

For each host, when the run starts, Danbyte lists the logins that may be
tried:

1. the host's own device credential of each kind that is switched on (one
   per kind, the first by name);
2. the shared credential the profile pins under **Credential** - used for
   every host of the profile whatever its scope says, while it is enabled
   and of a kind Discovery uses;
3. every enabled shared credential whose scope matches the host: lowest
   **Weight** first (default 100); on a tie the scope that names more
   dimensions, then the name.

The list is then put in **transport order** - every SSH key first, then
every SSH password, then every WinRM certificate - keeping the order above
inside each transport. So a shared SSH key is tried before the host's own
SSH password. At most the first **three** are kept. A host with no accepted
SSH host key loses its SSH logins at this point
([below](#host-keys)); when nothing is left it is *Host key not accepted*,
and when the list was empty to begin with it is *No credential*.

Then the logins are tried in order, and the next one only when:

| The login answered | Next one tried |
|---|---|
| Unreachable, timed out | only on the other transport family (SSH down → WinRM, and the other way) |
| Refused, after an SSH key | yes: no password was sent yet |
| Refused, after a password or certificate | only when its shared credential has **Try the next if refused** on |
| Anything else (read, host key refused, unsupported, failed) | no |

**Try the next if refused** is off by default and exists only on shared
credentials: trying one password after another against the same account is
how accounts get locked out. With it off, a refused password ends that host
for this run.

A run started with **Run now** uses only the credentials the person who
pressed it may view (*view* on device credentials and on shared credentials,
site scope included); a pinned credential they may not view is left out. A
scheduled run uses every credential the profile's authorisation covers.

The run's host list says which login read each host - *Host's own* or
*Shared · name* - and, on hover over **Transport**, each one tried and what it
answered. Never the secret.

### Where the secret lives

A credential's secret is held in the configured secret store (the local
encrypted store or Vault), managed or external, exactly as for other device
credentials ([Device access](device-access.md#device-credentials)). It is
write-only: the API never returns it, and **reveal** needs its own
permission.

Discovery reads the secret from the store when the run connects, holds it in
memory for that connection, and drops it. It is never written to the run, its
host results, the work queued for an Outpost, or the log. A secret that
cannot be read leaves the host *No credential* (*The credential's secret
cannot be read.*). How a secret reaches an Outpost is on
[On an Outpost](discovery-outposts.md#credentials-on-an-outpost).

The SSH connection uses only that one credential: no ssh-agent, no keys or
configuration from the server account, no GSS, host-based or
keyboard-interactive login.

## Transports

| Switch | Default | Logs in with |
|---|---|---|
| **SSH key login** | on | *SSH key*, only to a host whose SSH host key was accepted |
| **SSH password login** | on | *SSH password*, the same; off stops every password login, Linux and Windows, own and shared |
| **WinRM over HTTPS** | off | *WinRM certificate*, Windows hosts only, server certificate verified ([Windows hosts](discovery-windows.md#over-winrm)) |

A transport that is off is skipped for every host; the host's row says
*Switched off* for it. Tenant admins change them.

## Host keys

A host that is not who it claims to be could collect the credential sent to
it. So Danbyte logs in over SSH only to a host whose SSH host key a person
**accepted**: uploaded by hand, or observed and then accepted, in the
[SSH host-key inventory](../monitoring/ssh-host-keys.md). The key is checked
during the SSH handshake, before any credential is sent. A credential on
another port than 22 is pinned the same way.

Keys reach the inventory as *observed*, never accepted, from:

- a package inventory run, for each host it left alone as *No credential* or
  *Host key not accepted* (and that passed every rule before those): a key
  exchange, no login;
- a host that presents a key different from its accepted one: the run marks
  it *Host key not accepted* and records the key it presented;
- a service scan's SSH greeting, for an address that belongs to a device or
  VM;
- the SSH monitoring check.

### Reviewing host keys

The **Host keys** tab of a profile or a run lists the keys its hosts
presented that nobody accepted yet: host, address, type, SHA256 fingerprint,
first and last seen. Check each fingerprint against the host (for example
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on Linux), tick the ones
that match and press **Accept N keys**. The next run reads those hosts.

- Seeing the list needs *view* on SSH host keys; accepting needs *change*,
  inside your site scope. Each key accepted is in the change log.
- A key that differs from an accepted key of the same type on its host is
  marked **Differs from accepted key** and cannot be accepted from this list.
  Check the host, then accept it on the host's own **SSH host keys** panel.
- One accept takes at most 500 keys.

### Accept new host keys on first use

The **Run now** dialog has a box, **Accept new host keys**, unticked every
time it opens. Ticked, a host with **no accepted key at all** has the key it
presents on this run accepted, and the login goes ahead on that same
connection - pinned to that key, so a second handshake cannot swap it, and
later logins to the same host in the run are pinned to it too.

!!! danger "Not advised"
    Whoever answers that first contact is trusted. If something sits between
    Danbyte and the host - a spoofed address, an intercepting device - its
    key is accepted and it receives the credential. Reviewing fingerprints
    under **Host keys** is the safe way.

The rules:

- A host that has an accepted key and presents a different one is refused,
  ticked or not; nothing is overwritten.
- It needs *change* on SSH host keys as well as *scan*, checked when you
  press **Run now** and again when the run starts. Hosts outside your site
  scope for SSH host keys stay *Host key not accepted*.
- Scheduled runs never do it, and it is never a profile setting.
- Each key accepted this way is in the change log as you, with the run named
  as the cause; the host's row says **Key accepted on first use**, and the
  run's summary *N keys accepted on first use*.
- It works the same on an Outpost.
- `DANBYTE_DISCOVERY_ALLOW_FIRST_USE_KEYS=False` removes the box from the
  whole deployment and the API refuses it
  ([Settings](discovery-settings.md#environment-variables)).
