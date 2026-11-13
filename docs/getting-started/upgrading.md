---
icon: lucide/arrow-up-circle
---

# Upgrading

Getting a new version, and (optionally) moving an existing install to the
current `/opt` layout.

!!! tip "You almost never need to move the install directory"
    Version upgrades work **wherever Danbyte already lives** - `/srv/danbyte`,
    `/opt/danbyte`, or a custom path. The systemd units are home-relative
    (`%h/danbyte`), so nothing is hard-wired to a location. The `/opt` default
    only affects **new** installs. Relocating an existing one is cosmetic and
    entirely optional - see [Move an install to /opt](#move-an-install-to-opt)
    if you want to, and skip it otherwise.

!!! tip "From a terminal"
    `danbyte-admin upgrade online` (or `upgrade bundle <file>`) starts the
    same upgrade the Updates page does - through `manage.py start_upgrade`,
    under the same lock, as the unit `danbyte-upgrade.service` - and follows
    it step by step. A dropped SSH session does not stop it. See
    [danbyte-admin](../reference/danbyte-admin.md).

## Upgrade to a new version

!!! info "The Updates page loads instantly"
    **Settings → Updates** is two columns on a wide screen. **Update** holds
    everything that changes the version: the after-upgrade steps, the
    release source, the bundle upload, and at the bottom the releases with
    their notes - rendered as GitHub Markdown, `#123` linking to the issue
    in the release repo - and the upgrade button. **This install** holds the host it runs on: the
    environment table (Python, Django, PostgreSQL, Redis, platform) with
    **Download SBOM** when the release shipped one ([Danbyte's
    SBOM](sbom.md)), the services and their restart buttons, and the site
    certificate. The
    running version and the environment come from a local, network-free
    check - so the page renders immediately even on an airgapped or offline
    box. The list of available versions never comes from the release repo
    during a page load: the `danbyte-update-check` timer (`manage.py
    update_check`, every 6 hours; `run_scheduler` in a container) fetches it
    into Redis, and the page and the badge read that copy. Until the first
    fetch has run the Releases card says *Checking for releases…* and one
    background refresh is queued (it needs `danbyte-workers`). A slow or
    unreachable repo only makes the list older; the error shows under the
    version line. Changing the release source or token starts a fresh check.

!!! info "The top-bar update badge"
    When a newer release exists, a blue **Update available** badge appears
    beside the product name in the top bar - only for users who can manage
    deployment settings (it links to **Settings → Updates**). It reads the
    cached release list once per browser session. The running
    Danbyte version also shows at the bottom of the account menu. To hide the
    badge while still checking for updates, tick **Settings → Updates → Hide the
    "update available" badge** (airgapped mode hides it too, since no check
    runs).

!!! tip "Open tabs reload themselves after an upgrade"
    A new release ships freshly-hashed frontend assets, so a browser tab still
    running the previous build would ask for chunk files that no longer exist.
    Danbyte detects that failed load and reloads the tab once to pick up the new
    build - no hard refresh needed. If a tab ever seems stuck after an upgrade,
    a normal reload always clears it.

!!! warning "Docker/Podman: upgrade from the host, not in-app"
    The in-app upgrade below is for **bare-metal / systemd** installs. On a
    **container** deployment it is disabled - a process inside a container can't
    rebuild its own image or recreate itself, so it could only half-apply (new
    database schema, old running code, e.g. an unexpected *`is_uplink`* error).
    The Updates page detects this and shows the host commands instead. See
    [Deploying with Docker → Upgrading](docker.md#upgrading).

=== "In-app (recommended, systemd installs)"

    **Settings → Updates → Upgrade** (or **Upgrade from a bundle**, or the
    automatic-update timer, or `danbyte-admin upgrade`). The release you are
    running fetches the new one and hands over to **the new release's own
    upgrade** (`scripts/upgrade/stage.sh`), so a fix to the upgrade reaches
    the upgrade *to* that release. It runs as the transient unit
    `danbyte-upgrade.service`, as the service user, and survives every
    restart it causes. See [What an upgrade does](#what-an-upgrade-does).

    - A **Before upgrade** backup (database, media, config) is taken first,
      with the code that is running, and listed under **Settings → Backups**;
      the newest three are kept. A missing `pg_dump` stops the upgrade;
      `DANBYTE_SKIP_BACKUP=1` skips the backup on purpose (never for an
      automatic update).
    - **Every service stops before anything changes**, and the maintenance
      page shows until the new release has passed its checks. Nothing but
      the upgrade writes to the database meanwhile.
    - **A failure puts everything back** - code, virtualenv, frontend,
      static files, `.env`, unit links and, when migrations were applied,
      the database from a snapshot taken just before them - and starts what
      ran before. A release with nothing to migrate leaves the database as
      it was, so only the rest goes back. The Updates page says which step
      failed, quotes its output, and says how it ended: *nothing was
      changed*, *rolled back*, or (if
      even the database restore failed) *Danbyte is stopped - run
      `danbyte-admin upgrade recover`*.
    - **After an upgrade** the **Last upgrade** card on the Updates page shows
      how the last one went, whoever started it; an automatic upgrade, and
      any that failed, is also mailed to the digest recipients and listed
      on the Jobs page as the *upgrade* task.
    - Turn on **automatic updates** on the same page to track new releases
      hands-off. The timer picks the newest release (finals only on the
      *Stable* channel; pre-releases too on *Any*). A failure **before any
      service stopped** (a download, a full disk, a busy lock) is tried again
      after 1, 4 and 12 hours; a release that was **rolled back** is not
      tried again until someone retries it from the Updates page or a newer
      release appears. With migrations to apply, an automatic update also
      stops before migrating, and puts everything back, when the database
      could not be rolled back (the role does not own it, or `pg_restore` is
      missing) - a person can still upgrade from the Updates page, with a
      warning. Automatic updates are skipped on container deployments.
    - **Airgapped install?** Tick **Settings → Updates → Airgapped install
      (disable update check)**. Danbyte then never contacts the release repo -
      no version check, no auto-update - and you upgrade only by uploading a
      bundle (below). Turning it on forces automatic updates off.

=== "Manual (git install)"

    Run **as the service user** (`sudo machinectl shell danbyte@`), from the app
    directory (`~/danbyte`):

    ```bash
    cd ~/danbyte
    git fetch --tags --force
    git checkout vX.Y.Z

    # Python deps (uv, or pip inside the venv)
    VIRTUAL_ENV=$PWD/.venv uv pip install --require-hashes -r requirements.lock \
      ||  .venv/bin/pip install --require-hashes -r requirements.lock

    .venv/bin/python manage.py migrate
    make collectstatic frontend-build

    # Restart whatever this install runs (prod shown; dev uses danbyte-backend)
    systemctl --user restart danbyte-web danbyte-ws danbyte-workers danbyte-fastlane danbyte-frontend-prod
    ```

    Back up the database first: `pg_dump danbyte > ~/danbyte-$(date +%F).sql`.

!!! note "Open browser tabs learn about upgrades"
    A Danbyte tab that stays open keeps running the frontend build it
    started with. After an upgrade, every open tab detects the newer build
    (on focus and every few minutes) and shows a *"Danbyte was updated"*
    toast with a **Reload** button - no more stale UI without knowing it.

!!! warning "Migrated but didn't restart? Danbyte will tell you."
    If the database gets migrated but the app processes keep running the old
    code (a half-finished upgrade), writes can fail in confusing ways.
    Danbyte detects this: **Settings → Updates** shows a red *"running code
    is behind the database"* banner listing the unknown migrations, the same
    fact is in `/api/health/` as `code_behind_db`, and an error is logged at
    startup. The fix is always the same - restart every app process (web
    **and** workers) on the upgraded code.

    The reverse is caught too. New code started against a database that
    never ran its migrations (a restart without the migrate step, a
    hand-pulled checkout, a container without `MIGRATE_ON_START`) fails on
    the first page that reads a new column, with `column … does not exist`.
    **Settings → Updates** shows *"the database is behind the running code"*
    with the migrations still to run, `/api/health/` reports
    `db_behind_code`, and the log names them. Run `manage.py migrate` as the
    service user and restart the app processes. Migration files that cannot
    be loaded at all - a stray one from another release, which `migrate`
    fails on too - are reported the same way, with the error in place of
    the list (and by `danbyte status`).

=== "Offline bundle"

    Download the release bundle, unpack, and re-run the installer. On a box
    that already runs Danbyte it **upgrades** it: the root steps (packages,
    Node, the service user), then **the same upgrade stage** the in-app
    upgrade runs, as the service user's `danbyte-upgrade.service` - backup,
    services stopped, snapshot, migration, verify, start, or everything put
    back - and, once that is done, nginx, logrotate and the certificate unit
    from the bundle, as the root unit `danbyte-install-host.service`. It
    keeps your `.env`, the database and the site's certificate.

    ```bash
    sudo tar xzf danbyte-<version>-linux-x86_64.tar.gz
    cd danbyte-<version>-linux-x86_64
    sudo ./install.sh                     # upgrades the existing install
    ```

    Unpack it as root, as above: the bundle's files then belong to root,
    and `install.sh` warns when they belong to anyone else, who could
    change what root runs next.

    It prints each step as the upgrade reaches it, then what it did: the
    release it upgraded from and to, the root steps, the URL, the upgrade's
    warnings, a hint when the site serves a self-signed certificate, and
    how many after-upgrade steps are left. It exits 0 when it upgraded, 1
    when the upgrade failed (and was rolled back) or never ended, and 2
    when it upgraded but the root steps failed.

    If your SSH session drops, the upgrade and the root steps after it carry
    on, as units; follow them with
    `sudo -u danbyte XDG_RUNTIME_DIR=/run/user/$(id -u danbyte) journalctl --user -fu danbyte-upgrade`
    and `sudo journalctl -fu danbyte-install-host`. What the installer would
    have printed at the end is kept in `/var/lib/danbyte/installer/<time>.log`.
    The root steps run from a copy of the bundle's files only root can read,
    so the unpacked bundle may go once the installer has started them.

    To run only the root steps again - after they failed, or after an
    upgrade from the app - use the bundle of the release that runs:
    `sudo ./install.sh --host-only`. It runs no upgrade stage, so nothing
    stops, and it changes no code, so a git checkout takes it too. With
    `--adopt` (here or on an upgrade) it replaces a Danbyte site edited by
    hand with the new render, keeping a backup.

    Whatever the installer puts in the app directory - the code, the `.env`
    it fills in - the service account writes, and root runs nothing from
    there: a script that account changed, or a link it put in place of
    `.env`, leads root nowhere.

    It refuses to upgrade over a git checkout or while another upgrade runs
    (`--force` overrides those two), and for an older release than the one
    installed, which nothing overrides: a pre-release is older than the next
    one and than its final, so a 0.17.0-dev bundle cannot go over 0.17.0.
    The upgrade stage refuses a downgrade itself too, however it is started.

    You can also upgrade in-app **without unpacking**: **Settings → Updates →
    Upgrade from a bundle** takes the same `.tar.gz` and runs the same stage.
    Only the installer re-renders nginx and the certificate unit, though -
    see [After an upgrade](#after-an-upgrade). Pair this with the
    **Airgapped install** toggle so Danbyte never tries to reach the release
    repo.

### Airgapped upgrade with the installer (step by step)

The most thorough path for an offline box - it re-asserts the **production**
service set (gunicorn + daphne + workers + built frontend), so it also repairs
a drifted install (e.g. a leftover dev `danbyte-backend`/runserver unit).

1. **On an internet-connected machine**, download the bundle for the target
   version from the releases page - `danbyte-<version>-linux-x86_64.tar.gz`
   (e.g. `https://github.com/danbyte-net/danbyte/releases`).

2. **Copy it to the server** (any path; `/tmp` is fine):

    ```bash
    scp danbyte-<version>-linux-x86_64.tar.gz you@server:/tmp/
    ```

3. **On the server, unpack and run the installer as root.** It auto-detects the
   existing service user (`danbyte`) and *its* home, so it upgrades the install
   in place - you do **not** pass a path:

    ```bash
    cd /tmp
    sudo tar xzf danbyte-<version>-linux-x86_64.tar.gz
    cd danbyte-<version>-linux-x86_64
    sudo ./install.sh --host danbyte.example.com      # your real hostname/IP
    ```

    Add `--no-nginx` if you terminate TLS / manage nginx yourself and don't want
    the installer to touch it. Without `--host` it keeps the name the nginx
    site already answers to.

    The nginx site is re-rendered from the new release only while it is still
    exactly what Danbyte rendered, with the certificate paths, name, mode and
    owner it has now; the old file is kept as `danbyte.conf.bak-<time>` and
    comes back if `nginx -t` refuses the new one. A site you edited by hand
    is left alone and the new render is written beside it as
    `/etc/nginx/sites-available/danbyte.conf.new` for you to merge.

4. **Verify** once it finishes:

    ```bash
    curl -s http://127.0.0.1:8000/api/health/; echo
    # -> {"status": "ok", "database": true, "version": "<new version>"}
    ```

    Or open **Settings → Updates** - the version and the environment table
    (Python / Django / PostgreSQL / Redis) load instantly and show the new
    version.

!!! note "What it keeps, what it needs"

    - **Keeps** your existing `.env` and your **database** - it migrates,
      never flushes. Credentials stay decryptable (the upgrade backfills
      `MONITORING_SECRET_KEY` from your `SECRET_KEY` when missing).
    - **OS packages** (postgresql, redis-server, nginx) are only installed
      if a binary is *missing*. On a box that already runs Danbyte they're all
      present, so the installer **skips apt entirely** - no network needed. On a
      truly bare airgapped host, pre-install those packages (or point apt at a
      local mirror) first.
    - Take a DB snapshot first if you want a manual net:
      `sudo -u danbyte pg_dump danbyte | gzip > ~/danbyte-$(date +%F).sql.gz`.

!!! tip "Prefer this over the dev runserver in production"

    A production install should run the **gunicorn** unit (`danbyte-web`), not
    the dev **`danbyte-backend`** (runserver) unit - runserver's autoreload
    restarts the app when files change, which can interrupt an in-place upgrade.
    Every upgrade disables a `danbyte-backend` or `danbyte-frontend` dev
    server it finds running beside `danbyte-web`, and says so in its
    warnings. To disable a stray runserver unit by hand:

    ```bash
    sudo -u danbyte env XDG_RUNTIME_DIR=/run/user/$(id -u danbyte) \
      systemctl --user disable --now danbyte-backend.service
    ```

!!! tip "Health endpoint"

    `GET /api/health/` is unauthenticated and returns `{"status": "ok",
    "database": true, "maintenance": false, "version": "X.Y.Z"}` (HTTP 503
    if the database is unreachable). It is exempt from the HTTPS redirect,
    so a plain-HTTP probe on the app port gets an answer. Point a load
    balancer or uptime probe at it; the release pipeline's install-smoke
    uses it to prove the bundle actually serves requests, and the upgrade
    requires `"status": "ok"` and the new version from it before anyone else
    is let in. It keeps answering while an upgrade or a restore holds the
    site, with `"maintenance": true`; every other request gets 503 until
    the flag is cleared.

!!! note "Admin and API pages without styling (403 on `/static/`)"

    From 0.16.12 to 0.17.0-dev1, `collectstatic` wrote static files readable
    only by the service user, and nginx, which serves `/static/` from disk as
    another user, answered 403 for them: the Django admin and the browsable
    API showed without CSS (Docker too: its nginx reads the shared volume as
    another user). The next upgrade fixes it, as do `danbyte-admin rebuild`
    and `danbyte-admin maintenance collectstatic`; by hand, as the service
    user: `chmod -R u=rwX,go=rX ~/danbyte/staticfiles`.

!!! warning "\"An upgrade is already running\" (stuck lock)"

    **An upgrade that was killed part-way** (a reboot, an out-of-memory kill,
    `systemctl stop`) is finished or rolled back by itself: the stage leaves
    a journal and a recovery unit, which runs at the next boot *before* any
    Danbyte service starts, when the upgrade unit fails, and every five
    minutes. Until it has, every new upgrade, service restart and the
    *Clear a stuck upgrade* button are refused. To run it now - and to retry
    a database restore that failed - use `danbyte-admin upgrade recover`.

    If an older upgrader was interrupted (a killed process, a reboot mid-run),
    its single-slot lock can be left behind and every new upgrade is refused
    with **"An upgrade is already running."**

    **Fix from the UI:** **Settings → Updates → Releases → "Clear a stuck
    upgrade"**. It removes the stale lock only when no upgrade process is
    genuinely alive (it refuses while a real upgrade is in progress), then you
    can start a new one.

    Equivalently, `POST /api/system/upgrade/cancel/` (users.manage).

    **Last resort (shell), if the UI itself is down** - as the service user,
    remove the lock files from the app directory (`<service-home>/danbyte`):

    ```bash
    APP="$(getent passwd danbyte | cut -d: -f6)/danbyte"
    # confirm nothing is actually upgrading first:
    ps -eo pid,cmd | grep -E "danbyte-upgrade|upgrade-bundle|upgrade/stage" | grep -v grep
    sudo -u danbyte rm -f "$APP/.upgrade.lock" "$APP/.upgrade.lock.guard" \
                          "$APP/.upgrade-status.json" "$APP/.upgrade-bundle.tar.gz"
    ```

## What an upgrade does

Every path - the Updates page, an uploaded bundle, automatic updates,
`danbyte-admin upgrade`, and a re-run of `install.sh` - runs the target
release's `scripts/upgrade/stage.sh`, as the service user's
`danbyte-upgrade.service`:

| Step | What happens | The site |
|---|---|---|
| preflight | refuses an older release than the one running, inside a Danbyte unit, without Redis, while a restore holds the site, a pip-installed plugin on a new Python, too little disk ([how much](installation.md#disk-space-for-upgrades)), a prefix whose CIDR the upgrade can't repair ([below](#prefixes-the-upgrade-cant-repair)); warns about the ones it rewrites; installs the recovery unit | up |
| backup | the pre-upgrade backup, with the running code; when the launcher took it before handing over, the step shows that run and its duration | up |
| prepare | git: `npm ci` and the frontend build in a scratch copy; dependencies resolved from the release's `requirements.lock`, every file checked against its sha256 ([how](dependencies.md)); bundle: the wheelhouse checked offline; a copy of the virtualenv | up |
| quiesce | first, while the system is still installing its own package updates (`apt-daily`, unattended-upgrades - a host that just booted), it waits for them, up to 20 minutes, with everything still up, since a package update can restart PostgreSQL; past that it stops, retryable, with nothing stopped. Then timers stopped (a run in progress may finish, up to 2 minutes), then workers and fast lane, then web, websockets, frontend, docs | maintenance page |
| swap | the new code, frontend, static files and (bundle) vendor/ in place; the old ones kept aside; files the release no longer ships moved aside; new unit files linked, with their [sandboxing drop-ins](hardening.md#systemd-sandboxing) (the folders as they were are kept, and a rollback puts them back) | maintenance page |
| deps, check | dependencies installed, `manage.py check`, the migration plan | maintenance page |
| snapshot | `pg_dump` of the database - only when migrations are pending - into the run folder beside the app, which only the service user can read | maintenance page |
| migrate | every migration in **one transaction** where possible, so a failure leaves the database as it was (not possible when the plan holds a non-atomic migration, such as `api.0262` on an upgrade from before 0.19: then they run one by one and a failure restores the snapshot); the deferred foreign-key checks run after each migration and after each of its data steps, as separate commits would; when the one transaction hits a database limit (too many locks, pending trigger events) it is rolled back and the migrations run one by one on a new connection; a migration that lost its database to a restart and rolled back whole runs once more, and if the database stays away only the code is rolled back | maintenance page |
| static | `bootstrap` (new seeds; never a superuser), `collectstatic`, static and frontend build files made readable for nginx (a 403 from nginx for one is a warning), checks left claimed by stopped workers released | maintenance page |
| verify | the new code reads every table and a few list endpoints, before anything serves | maintenance page |
| start | web, websockets, frontend, docs, workers - while the site still answers 503; `/api/health/` must say `ok` with the new version, the admin page must render, and nothing may keep restarting | 503 |
| resume | the site opens; the timers that ran before start again (a unit or timer you turned off stays off, including one switched off in `danbyte-admin`); a release's new timers are turned on | up |
| done | the search index rebuilt in the background, housekeeping, the after-upgrade steps listed; the work folder, the folder an earlier failed run kept for its log, the recovery units and their lock removed, so nothing is left beside the app | up |

**If a step before *resume* fails**, everything goes back as it was and
what ran before starts again. The database is restored from the snapshot
when migrations were applied; with none pending it never changed and is left
alone. Nothing but monitoring results is written between
*quiesce* and *resume*, so that restore loses no one's work. From *resume*
on users are writing again, so a later problem keeps the new release and is
reported as a warning. If even the database restore fails, Danbyte stays
stopped (the maintenance page shows), the digest recipients get a mail, and
`danbyte-admin upgrade recover` retries it; the pre-upgrade backup is the
last resort.

### How the database is restored

The restore runs with the code of the release being upgraded *to*, whatever
release is on disk after the rollback, and needs no change to
`postgresql.conf`. Dropping a schema of Danbyte's size in one statement needs
a lock on every table, index and sequence at once (some 3000), more than a
stock server's lock table holds (`out of shared memory`, *increase
max_locks_per_transaction*); restores before 0.20 failed that way. So:

1. Every live object moves, one statement at a time, from `public` into a
   schema named `danbyte_pre_restore`. The extensions' objects (pg_trgm,
   unaccent) stay where they are.
2. `pg_restore` loads the snapshot into `public`, one object per
   transaction. Every table, sequence and index the snapshot lists must then
   be there.
3. Only then is `danbyte_pre_restore` dropped, a table per statement.

If step 2 fails, or a table is missing, what was restored is dropped and the
live objects move back: the database is exactly as the failed upgrade left
it, never half restored. A restore that was killed part-way is put back by
the next attempt before it starts. Other sessions on the database are ended
first (the upgrade has stopped every service already).

### When the restore fails

The Updates page and the status say *Rollback failed - Danbyte is stopped*.
The previous release's files are back, but its database still has the new
release's migrations, so its units stay **disabled**, which means nothing
starts them, not even a reboot. Their unit files stay linked. Recover with:

```bash
sudo danbyte-admin upgrade recover        # restores the snapshot again, then starts
```

It restores the snapshot (unless an earlier attempt already did), links
again any unit file that is missing, enables and starts what ran before,
and waits for `/api/health/`. It says *recovered* only when every unit is
there and running. Otherwise it exits with an error that lists the missing
or stopped units and the commands to start them by hand, as the service
user:

```bash
cd ~/danbyte && make install-prod-services     # links every unit file again
systemctl --user daemon-reload
systemctl --user enable --now danbyte-web.service danbyte-ws.service …   # the list it printed
```

If the snapshot itself cannot be restored, restore the pre-upgrade backup
instead (`danbyte-admin backup restore <id> --yes`, the id is in the error).
A rollback that restored the database but could not find a unit says so
too: *rolled back: but the previous release is NOT running*, with the same
commands.

Downtime is the time from *quiesce* to *resume*: a dump of the database when
migrations are pending, the migrations, and the checks - the frontend build
and the dependency download happen before it.

## Prefixes the upgrade can't repair

A prefix saved before CIDR validation (#47), or by an import, can hold a
CIDR that is not an address. Migration `api.0265` (on the way to 0.19 and
later) rewrites the ones the prefix API would accept - spaces, a netmask
such as `10.0.20.0/255.255.255.0` - and lists each one in the upgrade log.
It deletes nothing. For any other value (`banana`, `10.0.0.0/33`, host bits
set, or a rewrite that would duplicate a prefix in the same VRF) it stops
before it changes anything. See [Prefix](../models/prefix.md#hierarchy-logical-not-stored).

The upgrade checks for those rows first:

- **Host upgrades** (Updates page, bundle, automatic, `install.sh`): the
  preflight fails with each row's id, value, tenant and the reason, before
  anything stops. Nothing changes. Give each prefix a valid CIDR in the
  running Danbyte (open it by id, `/prefixes/<id>`) or delete it there,
  then upgrade again.
- **Docker**: the backend runs `manage.py prefix_cidrs --check` before
  `migrate` and exits with the same list, so the container restarts until
  the rows are fixed. The database is not migrated. Fix them with the new
  image without starting the app:

    ```bash
    docker compose run --rm -e MIGRATE_ON_START=0 backend python manage.py prefix_cidrs
    docker compose run --rm -e MIGRATE_ON_START=0 backend \
      python manage.py prefix_cidrs --set <id> 10.0.99.0/24
    docker compose up -d
    ```

- **By hand** (`manage.py migrate`): the migration stops with the list.
  The migrations before it stay applied. Run `manage.py prefix_cidrs --set
  <id> <cidr>` for each row, then `migrate` again.

`prefix_cidrs --set` normalises the value as the API does. It refuses a
network the VRF already has and one that would leave the prefix's IP
addresses outside it, and writes the change to the prefix's change log.
Without the command, the same fix in SQL is
`UPDATE api_prefix SET cidr = '10.0.99.0/24' WHERE id = '<id>';`
(`manage.py dbshell`).

## Prefixes the 0.19 upgrade deleted

0.19.0 and 0.19.1 shipped a version of migration `api.0265` that **deleted**
every prefix whose CIDR was not an address, including the ones it now
repairs. Each IP address in those prefixes went with it, along with
anything attached to those addresses and prefixes: check assignments,
monitoring policies, alert rules, silences, application flows (#501). The
upgrade log said only:

```
deleting prefix <id> with unparseable cidr '10.0.20.0/255.255.255.0' (tenant <id>)
deleted 2 prefix(es) whose cidr is not an address
```

Most installs had no such prefix. An install that upgraded to 0.19.0 or
0.19.1 from 0.18 or an early 0.19 pre-release (before dev10) ran it. Where
the migrations ran one by one - Docker, and `manage.py migrate` by hand -
the rows were deleted. The host upgrade runs them in one transaction (unless
`DANBYTE_UPGRADE_ATOMIC_MIGRATE=0`), and
there the index build after the delete failed on the deleted rows, so the
upgrade was rolled back with `invalid input syntax for type inet` and
nothing was lost; such an install is still on 0.18 and upgrades normally
now. An install that goes straight to 0.19.2 or later runs the repairing
version and lost nothing; its **After upgrade** card does not show this step.

**Keep the backup first.** The pre-upgrade backup the host upgrade took
before the 0.19 upgrade still holds the rows, but only the newest three
before-upgrade backups are kept ([Housekeeping](backup-restore.md#housekeeping)),
and each upgrade and the nightly pass prune the rest. **Protect** it on
**Settings → Backups** (kind *Before upgrade*, taken just before the 0.19
upgrade) before anything else. A Docker install has no pre-upgrade backup;
only a dump of your own taken before the upgrade holds the rows.

**Find out what is missing.** Compare that backup with the live database.
This changes nothing: it reads the archive's database dump with
`pg_restore` and creates no database.

```bash
# host, as the service user, in the app directory:
.venv/bin/python manage.py prefix_loss_report --backup <backup id>
# a pg_dump -Fc file of your own (Docker: copy it in first):
docker compose cp danbyte.dump backend:/tmp/danbyte.dump
docker compose exec backend python manage.py prefix_loss_report --dump /tmp/danbyte.dump
```

It lists each prefix in the backup whose CIDR is not an address and that
is no longer in the database, with tenant, VRF and its IP addresses, and
counts the other missing prefixes (`--all` lists those too; a user may have
deleted them). `--json FILE` writes every column of those prefix and IP
address rows from the backup.

**Get them back.** Either:

- Restore that backup (**Restore…** on it). That replaces the database
  with its state before the 0.19 upgrade and loses everything changed since.
  The restore runs the migrations forward, and the repairing `api.0265`
  rewrites those prefixes this time. If one still can't be repaired, the
  restore stops at that migration: fix the row with `prefix_cidrs --set`
  and run `manage.py migrate`.
- Or re-create the prefixes and their IP addresses from the listing (or
  the JSON) in Danbyte, by hand or with a CSV import. Check assignments
  and other things that hung off them have to be set up again.

Neither has been rehearsed on a real 0.19 install. Try the restore on a
copy of the host first.

## Upgrading from 0.16 or 0.17.0-dev1

The first upgrade off 0.16.x or 0.17.0-dev1 is started by that release's own
upgrader, which knows nothing of the stage. 0.17 steps in where it can: when
that upgrader runs 0.17's `manage.py migrate`, the migrate stops the timers,
workers and web first, migrates in one transaction, collects static files
(readable for nginx), and leaves the restart of everything it stopped to a
unit that waits for the old upgrader to exit - so a failed migration no
longer leaves a half-migrated database. That unit (its log:
`journalctl --user -u 'danbyte-upgrade-resume-*'`):

- after a finished upgrade, starts everything the migrate stopped, the
  timers included, once the database has every migration the code on
  disk ships;
- after a migration that was rolled back in full, once the old upgrader
  has put its own code back, first removes the files 0.17 added. That
  rollback extracts the old code over the tree and removes nothing, so
  0.17's migrations stayed behind: the old release's `migrate` could not
  even load its migration files, and the next upgrade applied them - and
  failed with the failed release's error. The migrate lists those files
  before it migrates: everything not in the rollback archive the old
  bundle upgrader wrote for this upgrade (`danbyte-backups/code-pre-*.tgz`)
  that is older than that archive. That includes a bundle uploaded to a
  git install, which 0.16 allows; the git upgrader's own rollback is a
  checkout, which removes them itself. Then it starts everything, the
  timers included;
- after a partly applied migration, starts nothing and says so in the
  upgrade's status, which the upgrade dialog shows, as well as in
  its log, which has the command that starts them.

It clears the *failed* mark of the units first, and removes the uploaded
bundle (`.upgrade-bundle.tar.gz`, hundreds of MB, which the old upgrader
keeps after a failure) and its own files. What it cannot fix: the new code
and dependencies are already in place a minute before the migrate, a
failure after the migration is not rolled back, and for a second during
the old upgrader's rollback its status reads *backup* again (the rollback
archive holds the status file of that moment).

It also fills in what 0.16's upgrader never records:

- The status names the release the upgrade was for instead of *uploaded*,
  so 0.16's automatic updates answer *failed before* for a release that
  failed, until a newer one appears, instead of downloading and trying it
  again - another backup and another outage - at every tick.
- After a finished upgrade, who started it and when: the **Last upgrade**
  card shows it and, for an automatic one, the next auto-upgrade tick
  mails the digest recipients and lists it on the Jobs page as the
  *upgrade* task, as for an upgrade the stage ran. A failed one put 0.16
  back, which reports nothing: it shows only in 0.16's upgrade dialog and
  status on the Updates page, and in the unit's log.

Two more things follow from that order:

- A timer that fires between the old upgrader's checkout and its migrate
  runs 0.17 code on the 0.16 schema and logs a `column ... does not exist`
  error. Those runs fail before they write anything; the migrate stops the
  timers, and their units' *failed* mark is cleared when they start again.
- A git install upgraded from the Updates page is down for the migration
  **and** the whole frontend build: 0.16's upgrader runs `npm ci` and the
  build after the migrate, when everything is already stopped - about two
  and a half minutes on a small VM. The launcher below builds before it
  stops anything.

The safest way off 0.16 is therefore **re-running the 0.17 installer** from
the bundle (`sudo ./install.sh`, above): it runs the full 0.17 upgrade. On a
git install, run 0.17's own launcher as the upgrade unit:

```bash
sudo -u danbyte XDG_RUNTIME_DIR=/run/user/$(id -u danbyte) systemd-run --user \
  --unit danbyte-upgrade sh -c \
  'git -C ~/danbyte fetch --tags --force && git -C ~/danbyte show vX.Y.Z:scripts/danbyte-upgrade.sh | sh -s -- vX.Y.Z'
```

0.17.0-dev1's automatic updates do not see a newer pre-release; upgrade a
dev1 install by hand once.

## After an upgrade

Some releases need a step no migration can do - an nginx location, a new
volume, a system package. Each release ships its list, and after any
upgrade path (in-app, bundle, automatic, Docker) deployment admins see:

- an amber **After upgrade: N steps** badge in the top bar,
- a card at the top of **Settings → Updates** with each step, its snippet
  and a docs link, and a **Done** button per step (or **Mark all done**),
- the same list in the in-app upgrade dialog's success message.

A step that can tell it is done (the nginx site has the location, the unit
file exists) disappears by itself once it is; the others stay until marked
done. A fresh install starts with nothing pending.

The steps that need root - nginx, logrotate, the certificate unit - share
one card, **Run this release's root steps**: it lists what it covers and
gives the one command that applies them all, `sudo ./install.sh --host-only`
from this release's bundle. **Do it by hand** opens each step's own snippet,
and **Done** on the card marks every one of them done.

The steps on the host - nginx, logrotate, the site-certificate unit - are
what an upgrade from the app cannot do, because it never has root.
Re-running `install.sh` from the bundle does them. On a host upgraded from
the app, the bundle of the release that runs does them all at once - the
command these steps lead with. An upgrade from the app, uploaded bundle
included, deletes its bundle once it succeeds, so nothing is left on the
host to run it from: the command downloads the bundle again as root and
checks it. Offline, copy the tarball and its `.sha256` over instead:

```bash
cd /root
curl -fLO https://github.com/danbyte-net/danbyte/releases/download/v<version>/danbyte-<version>-linux-x86_64.tar.gz
curl -fLO https://github.com/danbyte-net/danbyte/releases/download/v<version>/danbyte-<version>-linux-x86_64.tar.gz.sha256
sha256sum -c danbyte-<version>-linux-x86_64.tar.gz.sha256
sudo tar xzf danbyte-<version>-linux-x86_64.tar.gz && cd danbyte-<version>-linux-x86_64
sudo ./install.sh --host-only
```

Each run records what it applied in `/etc/danbyte/host-sync.json`; until
that names this release's files, the steps list *Apply this release's
nginx, logrotate and certificate-unit files*. A site edited by hand is not
replaced: the new render lands next to it as `danbyte.conf.new`, and
`--host-only --adopt` replaces it anyway, keeping a backup. An install made
with `--no-nginx` gets no nginx site from it while it has none, and no
certificate unit either; `sudo make install-tls-unit APP=<app directory>`,
in the same bundle, installs the unit alone.

From 0.19 the site serves the frontend's hashed `/assets/` from disk, cached
for good (see [Frontend files and
compression](installation.md#frontend-files-and-compression)); the step
*Let nginx serve the frontend's build files* stays up until the root steps
have run. Until then the site works as before, only without that caching. A
site you manage yourself needs the `/assets/` block and the
`$danbyte_asset_cache` map from `deploy/nginx/danbyte.prod.conf.template`.

From 0.20 the Site map can draw a [vector
basemap](../features/site-map.md#vector-basemap-and-label-language). Its
tiles come over `fetch` and it runs a web worker, so the CSP gains
`https://vector.openstreetmap.org` in `connect-src` and
`worker-src 'self' blob:`. The step *Let the Site map load vector tiles*
stays up until the site's CSP has `worker-src`. Until then a deployment set
to vector tiles shows the raster tiles. An upgraded install stays on raster
tiles until an admin picks vector under **Settings → Site map → Basemap**.

Also from 0.20, vulnerability data has a [browser
mode](../features/vulnerabilities.md#browser-mode): an admin's browser
fetches NVD, FIRST EPSS and OSV, so `connect-src` gains
`https://services.nvd.nist.gov https://api.first.org https://api.osv.dev`.
The step *Let the browser sync vulnerability data* stays up until the site's
CSP names `services.nvd.nist.gov`; it is only needed for the Browser update
source, and a mirror host set there must be added by hand.

From 0.20 the site pins its own TLS protocols and suites (TLS 1.2 and 1.3,
forward-secret AEAD suites only; see [Hardening → TLS](hardening.md#tls)).
The step *Pin modern TLS in nginx* stays up until the site has
`ssl_protocols` and `ssl_ciphers`. A client that only speaks TLS 1.0 or 1.1
stops connecting once it does.

Also from 0.20 nginx rate-limits sign-in and the CSP report sink per client
address ([Hardening → Edge rate limits](hardening.md#edge-rate-limits)).
The step *Rate-limit sign-in at nginx* stays up until the site has
`limit_req zone=danbyte_auth`. Behind another proxy, add the `real_ip`
lines that page shows, or every client shares the proxy's budget.

Redis can now take a password (`REDIS_PASSWORD`) or a unix socket, sent by
the cache, every queue and the WebSocket layer alike. An upgrade never turns
it on: the step *Optional: give Redis a password* gives the order to do it in
([Hardening → Redis authentication](hardening.md#redis-authentication)). A
`.env` whose `REDIS_URL` and `REDIS_HOST`/`REDIS_PORT` name different
servers now stops Danbyte from starting with a message saying so; the
installer writes `REDIS_URL` alone, which is never affected.

!!! warning "Root runs only files root owns"
    The app directory belongs to the service account. A script or template
    changed there would run as root, or become root's configuration, so no
    root step runs from it: unpack the bundle as root (`sudo tar xzf`), so
    that root owns what it runs. The Makefile targets that run their tree's
    files as root - `host-sync`, `install-tls-unit`, `proxy-install`,
    `proxy-reload` - refuse a tree that is neither root's nor yours.
    Earlier releases said `sudo make -C <app> host-sync` and
    `sudo make install-tls-unit` in the app directory; use the bundle
    instead.

**On a git install** the bundle of the release it runs does the same:
`--host-only` changes no code, so it takes a git checkout. Download it from
the releases page, check its SHA-256 and unpack it as root, as above. Or
make the copy root owns with git - for a checkout between releases, of the
commit it runs - and run the steps from there, naming the install:

```bash
sudo git clone --depth 1 --branch vX.Y.Z https://github.com/danbyte-net/danbyte /root/danbyte-vX.Y.Z
sudo make -C /root/danbyte-vX.Y.Z host-sync APP=/opt/danbyte/danbyte
```

`ADOPT=1` takes the new render over a site edited by hand, as `--adopt`
does.

The steps themselves, from the shell:

```bash
manage.py upgrade_notes              # print the pending steps (the upgrade scripts do this at the end)
manage.py upgrade_notes --ack all    # or --ack <id>
```

## Search index

Global search runs on an index table. An upgrade starts a rebuild in the
background once the site is back (`danbyte-search-reindex.service`), and the
container entrypoint rebuilds it after migrating; if you migrate by hand, run
`manage.py rebuild_search_index` once afterwards (it also runs nightly).

## Database extensions

Global search relies on the PostgreSQL `pg_trgm` and `unaccent` extensions.
The migration creates them itself: both are *trusted* extensions in PostgreSQL
13 and later, so the `danbyte` role needs no superuser rights. On an older
server, or one where trusted extensions are disabled, create them once as a
superuser before migrating:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
```

## Which install do I have?

```bash
getent passwd danbyte | cut -d: -f6      # the service user's home …
# … the app is in <home>/danbyte, e.g. /srv/danbyte/danbyte or /opt/danbyte/danbyte

# or ask systemd directly:
sudo -u danbyte XDG_RUNTIME_DIR=/run/user/$(id -u danbyte) \
  systemctl --user show danbyte-web -p WorkingDirectory
```

## Move an install to /opt

Optional - only to match the current default layout. It moves the service
user's home (app included) from `/srv/danbyte` to `/opt/danbyte`, repoints the
nginx static paths, and turns on `/var/log/danbyte` logging. **The database is
untouched.** Back up first.

=== "Script"

    As root, from the unpacked bundle of the release that runs - never from
    the app directory, which the service account owns:

    ```bash
    cd danbyte-<version>-linux-x86_64     # unpacked with sudo tar xzf
    sudo ./scripts/danbyte-relocate.sh          # → /opt/danbyte
    # custom target / user:
    sudo ./scripts/danbyte-relocate.sh --to /opt/danbyte --user danbyte
    ```

    It refuses to run from a tree that is not root's. It stops the services,
    moves the home with `usermod -m`, repoints the nginx `root`/`alias`
    paths, creates `/var/log/danbyte` (the service account adds it to its
    `.env`), restarts, and health-checks. If something looks wrong
    afterwards, the move is reversible:
    `sudo usermod -m -d /srv/danbyte danbyte` (then restart).

=== "Manual"

    As root. Replace `danbyte` if you used a different service user.

    ```bash
    U=danbyte; UID_=$(id -u "$U")
    asuser() { sudo -u "$U" env HOME="$1" XDG_RUNTIME_DIR=/run/user/$UID_ "${@:2}"; }

    # 1. stop services + the user's systemd manager
    asuser /srv/danbyte systemctl --user stop \
      danbyte-web danbyte-ws danbyte-frontend-prod danbyte-workers danbyte-fastlane danbyte-docs
    loginctl disable-linger "$U"; loginctl terminate-user "$U"; sleep 2

    # 2. move the home (contents included) and update the passwd entry
    sudo usermod -m -d /opt/danbyte "$U"
    sudo chmod 755 /opt/danbyte && sudo chmod o+x /opt/danbyte /opt/danbyte/danbyte
    loginctl enable-linger "$U"

    # 3. repoint nginx static/media/maintenance roots
    sudo sed -i 's#/srv/danbyte/#/opt/danbyte/#g' /etc/nginx/sites-available/danbyte.conf
    sudo nginx -t && sudo systemctl reload nginx

    # 4. logging (see below), then restart
    sudo install -d -o "$U" -g "$U" -m 755 /var/log/danbyte
    asuser /opt/danbyte systemctl --user daemon-reload
    asuser /opt/danbyte systemctl --user start \
      danbyte-web danbyte-ws danbyte-frontend-prod danbyte-workers danbyte-fastlane danbyte-docs
    ```

## Turn on /var/log/danbyte logging

Installs from before file logging log only to the systemd journal
(`journalctl --user`). To also write `/var/log/danbyte/danbyte.log` (app -
Django, workers, monitoring) and `gunicorn-*.log`:

```bash
# as root - dir owned by the service user
sudo install -d -o danbyte -g danbyte -m 755 /var/log/danbyte

# as the service user - point the app at it and restart
echo 'DANBYTE_LOG_DIR=/var/log/danbyte' >> ~/danbyte/.env
systemctl --user restart danbyte-web danbyte-workers danbyte-ws
```

`make logs` still follows the journal; `make logs-file` tails the files. See the
[Logs](installation.md#logs) section for what lands where. Leaving
`DANBYTE_LOG_DIR` unset keeps logging on the console/journal only (the dev
default).
