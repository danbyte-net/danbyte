---
icon: lucide/arrow-up-circle
---

# Upgrading

Getting a new version, and (optionally) moving an existing install to the
current `/opt` layout.

!!! tip "You almost never need to move the install directory"
    Version upgrades work **wherever Danbyte already lives** — `/srv/danbyte`,
    `/opt/danbyte`, or a custom path. The systemd units are home-relative
    (`%h/danbyte`), so nothing is hard-wired to a location. The `/opt` default
    only affects **new** installs. Relocating an existing one is cosmetic and
    entirely optional — see [Move an install to /opt](#move-an-install-to-opt)
    if you want to, and skip it otherwise.

## Upgrade to a new version

!!! info "The Updates page loads instantly"
    **Settings → Updates** shows the running version and an environment table
    (Python, Django, PostgreSQL, Redis, platform) from a local, network-free
    check — so it renders immediately even on an airgapped or offline box. The
    release-repo check (the list of available versions) runs separately; if it's
    slow, failing, or disabled, the version and environment still show right
    away.

!!! tip "Open tabs reload themselves after an upgrade"
    A new release ships freshly-hashed frontend assets, so a browser tab still
    running the previous build would ask for chunk files that no longer exist.
    Danbyte detects that failed load and reloads the tab once to pick up the new
    build — no hard refresh needed. If a tab ever seems stuck after an upgrade,
    a normal reload always clears it.

=== "In-app (recommended)"

    **Settings → Updates → Upgrade.** One click checks out the new release,
    installs dependencies, migrates the database, rebuilds the frontend,
    restarts the services and health-checks — with the "Danbyte is updating"
    page shown to visitors in the meantime.

    - The DB is **backed up** before migrating; on failure the code is rolled
      back to the starting commit and the services restarted automatically.
      (A migration that already ran is *not* auto-reverted — the backup is your
      net there.)
    - Turn on **automatic updates** on the same page to track new releases
      hands-off.
    - **Airgapped install?** Tick **Settings → Updates → Airgapped install
      (disable update check)**. Danbyte then never contacts the release repo —
      no version check, no auto-update — and you upgrade only by uploading a
      bundle (below). Turning it on forces automatic updates off.

    Under the hood this runs `scripts/danbyte-upgrade.sh <version>`, detached, so
    it survives the service restart.

=== "Manual (git install)"

    Run **as the service user** (`sudo machinectl shell danbyte@`), from the app
    directory (`~/danbyte`):

    ```bash
    cd ~/danbyte
    git fetch --tags
    git checkout vX.Y.Z

    # Python deps (uv, or pip inside the venv)
    uv sync --frozen  ||  .venv/bin/pip install -r requirements.txt

    .venv/bin/python manage.py migrate
    make collectstatic frontend-build

    # Restart whatever this install runs (prod shown; dev uses danbyte-backend)
    systemctl --user restart danbyte-web danbyte-ws danbyte-workers danbyte-frontend-prod
    ```

    Back up the database first: `pg_dump danbyte > ~/danbyte-$(date +%F).sql`.

=== "Offline bundle"

    Download the release bundle, unpack, and re-run the installer — it's
    **idempotent**: it keeps your existing `.env`, re-runs migrate + collectstatic
    + frontend, and restarts the services on the freshly-deployed code.

    ```bash
    tar xzf danbyte-<version>-linux-x86_64.tar.gz
    cd danbyte-<version>-linux-x86_64
    sudo ./install.sh                     # reuses the existing install + .env
    ```

    A re-run also **backfills `DANBYTE_LOG_DIR`** into an older `.env`, so file
    logging (below) switches on without hand-editing.

    You can also upgrade in-app **without unpacking**: **Settings → Updates →
    Upgrade from a bundle** takes the same `.tar.gz`, verifies it, backs up the
    DB, migrates, and restarts — the offline equivalent of the one-click flow.
    Pair this with the **Airgapped install** toggle so Danbyte never tries to
    reach the release repo.

### Airgapped upgrade with the installer (step by step)

The most thorough path for an offline box — it re-asserts the **production**
service set (gunicorn + daphne + workers + built frontend), so it also repairs
a drifted install (e.g. a leftover dev `danbyte-backend`/runserver unit).

1. **On an internet-connected machine**, download the bundle for the target
   version from the releases page — `danbyte-<version>-linux-x86_64.tar.gz`
   (e.g. `https://github.com/danbyte-net/danbyte/releases`).

2. **Copy it to the server** (any path; `/tmp` is fine):

    ```bash
    scp danbyte-<version>-linux-x86_64.tar.gz you@server:/tmp/
    ```

3. **On the server, unpack and run the installer as root.** It auto-detects the
   existing service user (`danbyte`) and *its* home, so it upgrades the install
   in place — you do **not** pass a path:

    ```bash
    cd /tmp
    tar xzf danbyte-<version>-linux-x86_64.tar.gz
    cd danbyte-<version>-linux-x86_64
    sudo ./install.sh --host danbyte.example.com      # your real hostname/IP
    ```

    Add `--no-nginx` if you terminate TLS / manage nginx yourself and don't want
    the installer to touch it.

4. **Verify** once it finishes:

    ```bash
    curl -s http://127.0.0.1:8000/api/health/; echo
    # -> {"status": "ok", "database": true, "version": "<new version>"}
    ```

    Or open **Settings → Updates** — the version and the environment table
    (Python / Django / PostgreSQL / Redis) load instantly and show the new
    version.

!!! note "What it keeps, what it needs"

    - **Keeps** your existing `.env` (prints `keeping existing …/.env`) and your
      **database** — it runs `migrate`, never `flush`. Credentials stay
      decryptable (it backfills `MONITORING_SECRET_KEY` from your `SECRET_KEY`
      when missing).
    - **OS packages** (postgresql, redis-server, nginx) are only installed
      if a binary is *missing*. On a box that already runs Danbyte they're all
      present, so the installer **skips apt entirely** — no network needed. On a
      truly bare airgapped host, pre-install those packages (or point apt at a
      local mirror) first.
    - Take a DB snapshot first if you want a manual net:
      `sudo -u danbyte pg_dump danbyte | gzip > ~/danbyte-$(date +%F).sql.gz`.

!!! tip "Prefer this over the dev runserver in production"

    A production install should run the **gunicorn** unit (`danbyte-web`), not
    the dev **`danbyte-backend`** (runserver) unit — runserver's autoreload
    restarts the app when files change, which can interrupt an in-place upgrade.
    Re-running `install.sh` enables the correct prod units. To disable a
    stray runserver unit by hand:

    ```bash
    sudo -u danbyte env XDG_RUNTIME_DIR=/run/user/$(id -u danbyte) \
      systemctl --user disable --now danbyte-backend.service
    ```

!!! tip "Health endpoint"

    `GET /api/health/` is unauthenticated and returns `{"status": "ok",
    "database": true, "version": "X.Y.Z"}` (HTTP 503 if the database is
    unreachable). Point a load balancer or uptime probe at it; the release
    pipeline's install-smoke uses it to prove the bundle actually serves
    requests.

!!! warning "\"An upgrade is already running\" (stuck lock)"

    If a previous upgrade was interrupted (a killed process, a reboot mid-run),
    its single-slot lock can be left behind and every new upgrade is refused
    with **"An upgrade is already running."**

    **Fix from the UI:** **Settings → Updates → Releases → "Clear a stuck
    upgrade"**. It removes the stale lock only when no upgrade process is
    genuinely alive (it refuses while a real upgrade is in progress), then you
    can start a new one.

    Equivalently, `POST /api/system/upgrade/cancel/` (users.manage).

    **Last resort (shell), if the UI itself is down** — as the service user,
    remove the lock files from the app directory (`<service-home>/danbyte`):

    ```bash
    APP="$(getent passwd danbyte | cut -d: -f6)/danbyte"
    # confirm nothing is actually upgrading first:
    ps -eo pid,cmd | grep -E "danbyte-upgrade|upgrade-bundle" | grep -v grep
    sudo -u danbyte rm -f "$APP/.upgrade.lock" "$APP/.upgrade.lock.guard" \
                          "$APP/.upgrade-status.json" "$APP/.upgrade-bundle.tar.gz"
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

Optional — only to match the current default layout. It moves the service
user's home (app included) from `/srv/danbyte` to `/opt/danbyte`, repoints the
nginx static paths, and turns on `/var/log/danbyte` logging. **The database is
untouched.** Back up first.

=== "Script"

    From the app directory, as root:

    ```bash
    cd ~danbyte/danbyte            # or wherever the app is
    sudo ./scripts/danbyte-relocate.sh          # → /opt/danbyte
    # custom target / user:
    sudo ./scripts/danbyte-relocate.sh --to /opt/danbyte --user danbyte
    ```

    It stops the services, moves the home with `usermod -m`, repoints the nginx
    `root`/`alias` paths, creates `/var/log/danbyte`, restarts, and
    health-checks. If something looks wrong afterwards, the move is reversible:
    `sudo usermod -m -d /srv/danbyte danbyte` (then restart).

=== "Manual"

    As root. Replace `danbyte` if you used a different service user.

    ```bash
    U=danbyte; UID_=$(id -u "$U")
    asuser() { sudo -u "$U" env HOME="$1" XDG_RUNTIME_DIR=/run/user/$UID_ "${@:2}"; }

    # 1. stop services + the user's systemd manager
    asuser /srv/danbyte systemctl --user stop \
      danbyte-web danbyte-ws danbyte-frontend-prod danbyte-workers danbyte-docs
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
      danbyte-web danbyte-ws danbyte-frontend-prod danbyte-workers danbyte-docs
    ```

## Turn on /var/log/danbyte logging

Installs from before file logging log only to the systemd journal
(`journalctl --user`). To also write `/var/log/danbyte/danbyte.log` (app —
Django, workers, monitoring) and `gunicorn-*.log`:

```bash
# as root — dir owned by the service user
sudo install -d -o danbyte -g danbyte -m 755 /var/log/danbyte

# as the service user — point the app at it and restart
echo 'DANBYTE_LOG_DIR=/var/log/danbyte' >> ~/danbyte/.env
systemctl --user restart danbyte-web danbyte-workers danbyte-ws
```

`make logs` still follows the journal; `make logs-file` tails the files. See the
[Logs](installation.md#logs) section for what lands where. Leaving
`DANBYTE_LOG_DIR` unset keeps logging on the console/journal only (the dev
default).
