---
title: danbyte-admin
description: The host administration script - services, upgrade, backup, TLS, users, from a terminal.
---

# danbyte-admin

One script for the host-side jobs the web UI cannot do, or cannot do when the
web itself is down: restart services, upgrade, take or restore a backup, swap
the TLS certificate, let a locked-out administrator back in.

```bash
scripts/danbyte-admin                       # numbered menu
scripts/danbyte-admin status
scripts/danbyte-admin services restart danbyte-web
scripts/danbyte-admin tls install --cert new.crt --key new.key
```

Run bare it shows a menu; with a subcommand it does one thing and exits, so it
works from a playbook as well as from a prompt. It is Python on the standard
library - no dependencies, and it does not need Danbyte's virtualenv to start
(it uses it to reach Django).

It only touches deployment and host things. Tenant data stays in the UI and
the API.

## Where it works

Danbyte runs as **systemd user units**: on a workstation under your own
account, in production under a dedicated `danbyte` account with linger
enabled. There are no system units, so `sudo systemctl restart danbyte-web`
fails on every host - and `systemctl --user` run as root talks to *root's*
manager and silently does nothing.

The script works this out for itself and, when the units belong to the service
account, runs through `sudo -u danbyte` with the `HOME`, `XDG_RUNTIME_DIR` and
`DBUS_SESSION_BUS_ADDRESS` that a user manager needs. A Docker install is
detected too, and every command goes through `docker compose exec` instead.

`status` prints which shape it found. Override the install directory with
`DANBYTE_DIR` if the script is not inside the tree it should manage.

## Commands

### status

Units, timers, database, Redis, version, migration drift and disk in one
screen.

Long-running services are listed individually; the scheduled jobs are
summarised as a count, because their units are oneshots and *are* inactive
between runs - listing them beside the services makes a healthy host look half
down. It also names the one fault that is easy to miss: `danbyte-backend` (the
development runserver) and `danbyte-web` (gunicorn) both bind `:8000`, and a
host running both breaks upgrades.

Health comes from `/api/health/`, the only endpoint that needs no credentials.
It answers `200` even when the deployment is *degraded* - deliberately, so a
probe does not restart-loop a half-finished upgrade - so the script reads the
status field rather than the HTTP code.

### services

```bash
danbyte-admin services list
danbyte-admin services restart              # every unit this host has
danbyte-admin services restart danbyte-web danbyte-workers
danbyte-admin services logs danbyte-workers -n 500 -f
```

The unit list is discovered from the host, never from the repository's
`services/` directory: a live box carries hand-written copies and units the
repo has never heard of. Development-only units are skipped rather than
started on a service-account host - `danbyte-infra` in particular brings up a
second Postgres that fights for port 5432.

### upgrade

```bash
danbyte-admin upgrade online                # latest release
danbyte-admin upgrade online --tag v0.16.0
danbyte-admin upgrade bundle ~/danbyte-0.16.0-linux-x86_64.tar.gz
```

Wraps [the upgrade scripts](../getting-started/upgrading.md). Two things it
adds: it refuses to start while an upgrade lock is held or
`danbyte-upgrade.service` is running, because the shell scripts do not take
that lock themselves and the auto-upgrade timer fires every twenty minutes;
and it copies a bundle to a scratch path first, because the bundle upgrader
deletes the tarball it is handed on success.

`--skip-backup` skips the pre-upgrade backup. That backup is the only net if a
migration goes wrong, so the script says so when you use it.

Container installs are upgraded by pulling a new image, and the script says
that rather than trying.

### backup

```bash
danbyte-admin backup run                    # inline, no workers needed
danbyte-admin backup list
danbyte-admin backup path <id>              # where the archive is on disk
danbyte-admin backup restore <id>           # preconditions only
danbyte-admin backup restore <id> --yes     # actually restore
danbyte-admin backup unstick                # clear a stuck maintenance flag
```

`restore` without `--yes` prints the six precondition checks and changes
nothing, which is the same preview the UI shows. `unstick` clears the
maintenance flag a killed restore leaves behind in Redis - otherwise the site
answers 503 until the six-hour expiry.

See [Backup and restore](../getting-started/backup-restore.md).

### tls

```bash
danbyte-admin tls show
danbyte-admin tls install --cert new.crt --key new.key   # bring your own
danbyte-admin tls self-signed [--host name-or-ip]        # regenerate
danbyte-admin tls renew                                  # ACME / Let's Encrypt
danbyte-admin tls reload
```

Danbyte serves either a certificate you supply - including one from Let's
Encrypt - or a self-signed one, and these are the three ways to change it.

`show` reads the paths out of the **live** nginx configuration rather than
assuming them, and so does everything that writes. Both the certificate *and*
the key path come from the config: this is not a detail, because a host that
keeps its certificate in `/etc/ssl/certs` and its key in `/etc/ssl/private` is
normal, and deriving one path from the other writes a key somewhere nginx does
not read - leaving a mismatched pair that does not fail until the next reload.
If the live configuration cannot be read, these commands stop rather than
guess.

`install` and `self-signed` both check that the key matches the certificate,
keep a copy of what was there, run `nginx -t`, and **put the old pair back** if
nginx refuses the new one. They also refresh the staging copies inside the
repository: a bundle upgrade re-runs the proxy install, which copies staging
over live, so writing only the live path means the next upgrade silently
reverts TLS.

`self-signed` keeps every name the current certificate answers for and adds
the one you name, so regenerating never costs the site a way of being reached
- a box reached as both an address and a DNS name keeps both.

`renew` re-issues the ACME certificates in Danbyte's inventory that have
passed their renewal point - the same job `danbyte-acme-renew.timer` runs. It
does not install one into nginx; that is still `tls install`.

These steps need root and the script asks for it per action rather than
demanding it up front.

### users

```bash
danbyte-admin users show <name>
danbyte-admin users create
danbyte-admin users passwd <name>
danbyte-admin users clear-mfa <name>
danbyte-admin users unlock <name>
```

`create` and `passwd` hand the terminal over to Django, which reads passwords
from a TTY and has no non-interactive flag - so they cannot be scripted, by
design. `clear-mfa` removes an authenticator enrolment and the failed-code
lockout for someone who has lost their device; `unlock` re-enables a disabled
account and clears its counters.

### maintenance

```bash
danbyte-admin maintenance list
danbyte-admin maintenance reindex
danbyte-admin maintenance prune
danbyte-admin maintenance collectstatic
```

The same jobs the scheduled timers run, on demand.

### diagnostics

```bash
danbyte-admin diagnostics
danbyte-admin diagnostics --deploy          # include hardening warnings
danbyte-admin diagnostics --url https://hooks.example.com
```

Runs Django's checks against the database, reports health, and can test one
URL against the [outbound guard](settings.md#outbound-requests-ssrf-guard).
A private address being blocked is the guard working as intended on a
LAN-only install, and the message says how to permit it if that is wrong.

## Installing it

A packaged install symlinks the script to `/usr/local/bin/danbyte`, so an
administrator can type:

```bash
danbyte             # the menu
danbyte status
```

A symlink rather than a shell alias on purpose: an alias exists only in an
interactive shell that sourced it, so it would be missing from `sudo`, from
`cron`, and from every non-login session - which is exactly when this is
wanted.

A source checkout has no installer, so link it with:

```bash
make admin-link
```

It needs `sudo` for `/usr/local/bin`, which is why it is its own target rather
than part of `make install-services`. Re-running it re-points the link, so it
is safe after moving the checkout.

## Notes

Every command is run as an argument list, never through a shell, so a path
with a space or a password with a quote in it cannot turn into something else.
Secrets are passed through the environment rather than the command line, where
`/proc` would expose them.

Management commands always run from the application directory: Django reads
`.env` relative to the working directory, and from anywhere else the database
credentials and secret key quietly vanish.
