---
title: danbyte-admin
description: The host administration script - services, upgrade, backup, TLS, users, from a terminal.
---

# danbyte-admin

One script for the host-side jobs the web UI cannot do, or cannot do when the
web itself is down: restart services, upgrade, take or restore a backup, swap
the TLS certificate, let a locked-out administrator back in.

```bash
scripts/danbyte-admin                       # the console
scripts/danbyte-admin --plain               # the numbered menu
scripts/danbyte-admin status
scripts/danbyte-admin services restart danbyte-web
scripts/danbyte-admin tls install --cert new.crt --key new.key
```

Run bare on a terminal it opens [the console](#the-console); with a subcommand
it does one thing and exits, so it works from a playbook as well as from a
prompt. It is Python on the standard library - no dependencies, and it does
not need Danbyte's virtualenv to start (it uses it to reach Django).

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

## The console

`danbyte` on its own is a full-screen console: a title bar, a strip of eight
numbered tabs, panels, and a key bar naming what the keys on that tab do.
`?` opens the full key list; `q` or `esc` goes back to the overview, and
quits from there.

**1 overview** is the screen to leave open. Services on the left with their
state, PID, memory, CPU, uptime and restart count; the timers under them
with when each last fired, when it fires next and the oneshot's last
*result* - the one place a job that has been failing all night is visible
without reading the journal. On the right, the host (health, migrations,
load, memory, disk, uptime) and Danbyte (queue depths, workers, failed
jobs, the fast lane, the maintenance flag, the upgrade lock, the last
backup, the certificate's expiry). The journal for `danbyte-*` scrolls
underneath; a burst from one unit folds into a count. Every row on the
overview is read from systemd, `/proc`, Redis and the health endpoint
directly, so it stays right with Django down - which is when the tool tends
to be opened. Django is asked once at start and on `R`.

Move with the arrows or `j`/`k`, `tab` between services and timers.
`enter` opens the logs filtered to the selected unit; `r` restarts, `x`
stops, `s` starts, `e` enables or disables. On a timer, `s` runs its job
now. `a` restarts every unit that is running (never starting a stopped
one) and `B` starts a [rebuild](#rebuild) on the maintenance tab, where its
steps stream. A key that needs shift is drawn with the shift arrow on its
cap (`⇧B`).

**2 logs** is the journal with filters: `u` cycles the unit, `p` the
priority floor, `/` takes a substring, `space` pauses, `g`/`G` jump to the
top and end, `w` wraps long lines. It follows one `journalctl`; when the
unprivileged user journal is stale (a host whose journald writes to `/run`
and whose caller is not in `systemd-journal` reads days-old entries), it
reads through `sudo -n` instead and says so on the panel.

**5 tls** shows the served certificate, what `:443` presents beside it,
and the app's side - the source, the last drop and what the root unit did
with it. `c` gets the site's certificate from a CA the way the settings
card does: Let's Encrypt (the account email, HTTP-01 answered by Danbyte)
or one of the app's issuers, then the names, then a y/n; the order runs
in the background and the pair is installed by the root unit when the CA
signs it. `g` regenerates a self-signed pair through the app when the
apply unit is installed (so it renews itself), by hand through sudo when
it is not; `i` installs a pair from files with the review.

**3 backups**, **6 users** and **7 maintenance** are the CLI's `backup`,
`users` and `maintenance` as tables with the actions on keys; the
maintenance tab lists `rebuild` first, then the scheduled jobs; a restore
runs the preconditions first and only then asks. **4 upgrade** shows the
running version, the branch and tree state the upgrader will judge, the
lock, the tags and the last run, then launches an online or bundle upgrade
as `danbyte-upgrade.service` - the same transient unit the web UI uses, so a
dropped ssh session cannot kill it half-way and reopening the console
reattaches to a run someone started from the browser. Its output lands in
`.upgrade.log`, tailed on the screen with the step ladder and the progress
bar. **5 tls** shows what nginx serves and, beside it, what `:443` actually
presents right now - so a reload that did not take is visible - and installs
a certificate (below). **8 diagnostics** runs the checks and probes the
ports.

Colour is only ever on the word that carries a state - green, amber, red -
so a screen with no colour on it is a screen with nothing wrong.

Confirmations follow one rule: the actions that take the site down or
replace data ask you to **type the name** of the thing (stopping the web
process, an upgrade, a restore, installing a certificate, a self-signed
regeneration, clearing someone's MFA); the rest ask `y/n` (a restart, a
disable, running a timer now, prune, unlock, nginx reload); the idempotent
ones just run. While a prompt is up every other key is ignored, so a stray
keypress cannot restart anything.

Root is asked for per action through `sudo`, never up front. The key bar's
corner says `sudo ok` when commands will run without a prompt and `sudo
asks` when the next root step will; `!` authenticates on the terminal and
comes back. Anything that needs the real terminal - a password prompt,
`createsuperuser`, `changepassword`, a restore - hands the screen over and
takes it back afterwards.

The console needs a real terminal of at least 80x24; wider than 100 columns
it lays the overview out in columns, wider than 140 in three. Without one -
no TTY, `TERM=dumb`, a serial console below that size - or with `--plain` or
`DANBYTE_ADMIN_PLAIN=1`, you get the numbered menu, which now carries
*Upgrade* and *TLS › install* too. Subcommands never open the console.

On a service-account host the console polls through `sudo -u danbyte`; run
it as `sudo -iu danbyte danbyte` to avoid that.

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
danbyte-admin services restart --active     # only the ones running now
danbyte-admin services restart danbyte-web danbyte-workers
danbyte-admin services logs danbyte-workers -n 500 -f
```

`restart` with no units restarts everything installed, which also starts
what was stopped; `--active` restarts only what is running, which is what
"restart all" means on the console.

The unit list is discovered from the host, never from the repository's
`services/` directory: a live box carries hand-written copies and units the
repo has never heard of. Development-only units are skipped rather than
started on a service-account host - `danbyte-infra` in particular brings up a
second Postgres that fights for port 5432.

### upgrade

```bash
danbyte-admin upgrade online                # newest release tag, after a fetch
danbyte-admin upgrade online --tag v0.16.0
danbyte-admin upgrade bundle ~/danbyte-0.16.0-linux-x86_64.tar.gz
```

Without `--tag`, `online` fetches the tags and picks the newest **final**
release (`vX.Y.Z`; a pre-release only when no final exists), says which,
and stops if that is the version already running - the upgrade script
insists on a version, and git's own ordering would put `-rc` above the
final.

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

### rebuild

```bash
danbyte-admin rebuild
danbyte-admin rebuild --skip-deps --skip-frontend
```

The upgrader's build steps on the code already here - after a `git pull`,
a hand edit, or a bundle unpacked by hand: install the Python dependencies
(`uv` where the upgrader finds it, else the venv's `pip`), `migrate`, `npm
ci` when `package-lock.json` is newer than `node_modules` then `npm run
build`, `collectstatic` on a host with `danbyte-web` (gunicorn), and a
restart of every unit that is running. It stops at the first failing step
and prints that step's output, and refuses to start while an upgrade lock
is held (`--force` overrides). An offline bundle install installs from its
`vendor/wheels` and keeps the frontend it shipped built; a container
install is told to pull an image instead.

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
danbyte-admin tls install --cert new.crt --key new.key --chain ca-bundle.crt
danbyte-admin tls install /etc/letsencrypt/live/danbyte.example.com/
danbyte-admin tls install danbyte.pem                    # cert chain + key in one file
danbyte-admin tls self-signed [--host name-or-ip]        # regenerate
danbyte-admin tls renew                                  # ACME / Let's Encrypt
danbyte-admin tls reload
```

Danbyte serves either a certificate you supply - including one from Let's
Encrypt - or a self-signed one, and these are the three ways to change it.

`show` prints each certificate nginx serves the way you would ask about it:
subject, issuer (or *self-signed*), every name it answers for, when it
expires with the days left - amber under thirty, red once expired - and its
SHA-256 fingerprint, plus the key path.

`install` takes the pair however a CA handed it over: `--cert` and `--key`,
with `--chain` for the intermediates (nginx wants the whole chain in
`ssl_certificate`, so they are appended); a Let's Encrypt `live/` directory,
or any directory holding `fullchain.pem` and `privkey.pem` or exactly one
certificate and one key file; or a single PEM file that carries both the
chain and the key. Files are told apart by content, never by name, so two
files can be handed over in either order. A combined file is split into a
private scratch directory (the key at mode 600) and that directory is
removed afterwards; a key the caller cannot read (`/etc/letsencrypt/live` is
root-only) is reached through `sudo -n`, and only its public half ever
leaves the file. Before writing, it prints what it is about to install.

In the console, `i` on the TLS tab asks for the path (with tab completion),
then shows a **review** before anything is written: the live certificate
beside the new one - subject, issuer, names, expiry, key type, fingerprint -
and the checks. A key that does not match, an expired or not-yet-valid
certificate, an unsupported key type or an unreadable nginx config *block*
the install; a `server_name` the new certificate does not cover, a name the
live certificate answers for that the new one drops, a missing intermediate
and a certificate identical to the live one *warn*. Then you type the new
certificate's common name to install. After the reload the tab re-reads
`:443` and says whether it now presents the new fingerprint.

The pair check compares public keys, so EC and RSA keys are both answered;
the earlier modulus comparison only knew RSA and let an EC mismatch reach
`nginx -t`.

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

The web UI has its own path to the same result: **Settings → Updates → Site
certificate** gets one from Let's Encrypt or regenerates a self-signed pair
and drops it in `deploy/nginx/certs/` for the root `danbyte-tls.path` unit
to apply (see [the site's own
certificate](../monitoring/certificates.md#the-sites-own-certificate)).
`danbyte tls install deploy/nginx/certs/` installs such a drop by hand on a
host without the unit.

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
design. `clear-mfa` removes an authenticator enrolment (confirmed or
pending), turns the *require MFA* flag off and clears the failed-code
lockout, for someone who has lost their device; `unlock` re-enables a
disabled account and clears its counters. `show` reports `mfa` true when an
authenticator is enrolled.

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
danbyte             # the console
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
