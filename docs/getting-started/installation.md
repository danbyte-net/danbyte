---
icon: lucide/rocket
---

# Installation

The quick install is a **single command** — that's the path most people want.
The other tabs cover building from source and a local dev checkout.

??? info "Requirements"
    - **Linux** — for the user-level systemd services (the app itself runs
      anywhere Django does).
    - **PostgreSQL 15+** (17 or 18 recommended) and **Redis**.
    - Everything else — Python 3.13, Node, all dependencies — is **bundled** with
      the quick installer, so a fresh box needs nothing else.

## Install

=== "Quick (recommended)"

    Every release ships a **self-contained bundle** — Python, Node, all
    dependencies and the prebuilt frontend baked in. On a fresh Ubuntu/Debian
    box, **one line** does everything:

    ```bash
    curl -fsSL https://danbyte.net/install.sh | bash -s -- --host danbyte.example.com
    ```

    The bootstrap script resolves the **latest** release automatically (so
    there's no version to fill in), downloads the offline bundle, **verifies its
    published SHA-256**, unpacks it, and runs the bundled installer — everything
    after `--` is passed straight through to it. Pin a specific version with
    `DANBYTE_VERSION`:

    ```bash
    curl -fsSL https://danbyte.net/install.sh | DANBYTE_VERSION=0.9.10 bash -s -- --host danbyte.example.com
    ```

    It creates the `danbyte` service user, installs to `/opt/danbyte`, generates
    all secrets, sets up the database, starts the services, writes logs to
    `/var/log/danbyte`, and puts nginx + TLS in front.

    When it finishes it prints the **admin password** — open
    `https://danbyte.example.com/`, sign in as `admin`, and change it under
    **User → Preferences**.

    ??? note "Manual bundle download (airgapped / offline)"
        Prefer to fetch the bundle yourself — e.g. to carry it onto an airgapped
        host? Download the release asset, verify it, and run its bundled
        installer. Replace `<version>` with the latest release number:

        ```bash
        base=https://github.com/danbyte-net/danbyte/releases/latest/download
        curl -fsSLO $base/danbyte-<version>-linux-x86_64.tar.gz
        curl -fsSLO $base/danbyte-<version>-linux-x86_64.tar.gz.sha256
        sha256sum -c danbyte-<version>-linux-x86_64.tar.gz.sha256
        tar xzf danbyte-<version>-linux-x86_64.tar.gz
        cd danbyte-<version>-linux-x86_64
        sudo ./install.sh --host danbyte.example.com
        ```

        The bundle needs **no** PyPI / npm / python.org access. Only the OS
        packages it builds on — `postgresql`, `redis-server`, `nginx` — come from
        your distro; on an airgapped host, point `apt` at a local mirror or
        pre-install them.

=== "From source"

    A start-to-finish install on a fresh Ubuntu/Debian box.

    **1 · Packages + service user.** Danbyte runs rootless under a dedicated
    `danbyte` account whose home is `/opt/danbyte`:

    ```bash
    sudo apt update && sudo apt install -y postgresql redis-server git curl
    curl -LsSf https://astral.sh/uv/install.sh | sh          # Python 3.13 manager

    sudo adduser --disabled-password --gecos "Danbyte" --home /opt/danbyte danbyte
    sudo loginctl enable-linger danbyte                      # start at boot, no login
    sudo install -d -o danbyte -g danbyte -m 755 /var/log/danbyte
    ```

    **2 · Secrets — generated in your browser.**

    !!! tip "The blocks below are pre-filled with secrets generated on this page"
        Every secret in the steps below (`DJANGO_SECRET_KEY`,
        `MONITORING_SECRET_KEY`, the database password, the admin password) is
        **randomly generated in your browser** when this page loads — so no two
        installs share a "default". The same value is reused consistently across
        steps (the DB password in the SQL matches the one in your `.env`), so you
        can copy each block as-is. Hit **↻ Regenerate** for a fresh set, and
        **store them somewhere safe** — you can rotate any of them later (see
        [Rotating secrets](#rotating-secrets)).

    **3 · Database** — create the role + database (the password is your
    generated one):

    ```bash
    sudo -u postgres psql <<SQL
    CREATE ROLE danbyte LOGIN PASSWORD 'GENDBPASSWORD';
    CREATE DATABASE danbyte OWNER danbyte;
    SQL
    ```

    **4 · Code + venv.** Switch to the service user
    (`sudo machinectl shell danbyte@`) and clone into its home:

    ```bash
    git clone …/danbyte ~/danbyte && cd ~/danbyte
    uv python install 3.13 && uv venv --python 3.13 .venv
    VIRTUAL_ENV=$PWD/.venv uv pip install -r requirements.txt
    ```

    **5 · `.env`.** Write `~/danbyte/.env` — the secret key, monitoring key, DB
    password, and admin password below are pre-filled with your generated
    values. Set `ALLOWED_HOSTS` to your server's hostname or IP. `DEBUG=False` in
    production; `MONITORING_SECRET_KEY` encrypts stored SNMP/SSH/SMTP/LDAP
    credentials (required when `DEBUG=False`); the `DJANGO_SUPERUSER_*` line
    seeds the admin on first `bootstrap`.

    ```ini
    DJANGO_SECRET_KEY=GENDJANGOKEY
    DEBUG=False
    ALLOWED_HOSTS=your-server.example.com
    DB_NAME=danbyte
    DB_USER=danbyte
    DB_PASSWORD=GENDBPASSWORD
    DB_HOST=127.0.0.1
    DB_PORT=5432
    REDIS_URL=redis://localhost:6379/0
    DANBYTE_LOG_DIR=/var/log/danbyte
    MONITORING_SECRET_KEY=GENMONITORINGKEY
    DJANGO_SUPERUSER_USERNAME=admin
    DJANGO_SUPERUSER_EMAIL=admin@your-org.example
    DJANGO_SUPERUSER_PASSWORD=GENADMINPASSWORD
    ```

    <button type="button" data-secret-regen>↻ Regenerate all secrets</button>

    Keep it private: `chmod 600 ~/danbyte/.env`.

    **6 · Migrate, build, and start.** `bootstrap` seeds the default
    organization, tenant, and status catalog, and creates your admin user:

    ```bash
    .venv/bin/python manage.py migrate
    .venv/bin/python manage.py bootstrap
    make frontend-install frontend-build collectstatic
    make install-services install-prod-services
    systemctl --user enable --now danbyte-web danbyte-ws danbyte-frontend-prod danbyte-workers
    ```

    **7 · nginx + TLS:**

    ```bash
    make proxy-install NGINX_TMPL=deploy/nginx/danbyte.prod.conf.template \
      PROXY_HOST=danbyte.example.com
    ```

    Open `https://danbyte.example.com/` and sign in as `admin`. (Self-signed
    cert by default — swap in a real one, e.g. Let's Encrypt, for a public host.)

    ??? note "The services (and why there are a few)"
        Danbyte runs as a handful of small user-level systemd units:

        | Unit | Serves |
        |---|---|
        | `danbyte-web` | HTTP — the Django app (gunicorn) on `127.0.0.1:8000` |
        | `danbyte-ws` | WebSockets / presence (daphne) on `127.0.0.1:8002` |
        | `danbyte-frontend-prod` | the built SSR frontend (node) on `127.0.0.1:3000` |
        | `danbyte-workers` | background jobs — scans, deploys (RQ) |
        | `danbyte-*` timers | drift dispatch, cleanup, materialise, … |

        gunicorn serves all plain HTTP; daphne serves **only** `/ws/`. Keeping the
        ASGI server off the HTTP path is deliberate — putting it in front of
        everything wedges ordinary requests.

    ??? tip "Shortcut: `make service-user`"
        With the repo checked out, `make service-user` does all of step 1 (creates
        the account + `/opt/danbyte` home, enables linger, adds your login to the
        group, creates `/var/log/danbyte`). Relocate with
        `make service-user SERVICE_HOME=/var/lib/danbyte`.

=== "Local development"

    ```bash
    git clone …/danbyte && cd danbyte
    uv python install 3.13 && uv venv --python 3.13 .venv
    VIRTUAL_ENV=$PWD/.venv uv pip install -r requirements.txt

    # Postgres role + db (dev creds are fine locally)
    sudo -u postgres psql <<SQL
    CREATE ROLE danbyte LOGIN PASSWORD 'danbyte';
    CREATE DATABASE danbyte OWNER danbyte;
    SQL

    export DB_HOST=127.0.0.1 DB_USER=danbyte DB_PASSWORD=danbyte DB_NAME=danbyte
    .venv/bin/python manage.py migrate
    .venv/bin/python manage.py bootstrap
    make install-services backend-up
    ```

    Open `http://localhost:8000/prefixes/`.

    ??? tip "Optional demo data"
        With the dev DB vars exported (above) and after `bootstrap`:

        ```bash
        .venv/bin/python manage.py seed_demo       # Acme demo (IPAM)
        .venv/bin/python manage.py seed_demo_172   # 172.16 net + devices + monitoring
        ```

---

## Advanced

Reference material — you don't need any of this for a first install.

### Logs

With `DANBYTE_LOG_DIR` set (the quick installer points it at `/var/log/danbyte`),
the app writes log files there **in addition to** the systemd journal:

| Where | What |
|---|---|
| `/var/log/danbyte/danbyte.log` | Application log — Django, workers, monitoring/LDAP (rotated 10 MB × 5) |
| `/var/log/danbyte/gunicorn-{access,error}.log` | The web server's request + error logs |
| `journalctl --user -fu danbyte-web` | Per-service process output, still in the journal |

`make logs` follows the journal; `make logs-file` tails the files. Leave
`DANBYTE_LOG_DIR` unset in dev to keep logs on the console only.

### Rotating secrets

Any of these can change later without a reinstall:

- **Admin password** — **User → Preferences** (or `manage.py changepassword`).
- **`DJANGO_SECRET_KEY`** — edit `.env`, `make restart` (signs everyone out).
- **DB password** — `ALTER ROLE danbyte PASSWORD '…';`, update `.env`, `make restart`.

### Security checklist

- [ ] `DEBUG=False` and `ALLOWED_HOSTS` set to your real host(s).
- [ ] nginx + TLS in front; Danbyte not exposed directly on `:8000`.
- [ ] Admin password changed after first login; `DJANGO_SUPERUSER_PASSWORD` removed from `.env`.
- [ ] Runs as the dedicated non-login `danbyte` user, with linger enabled.
- [ ] `.env` is `chmod 600`, owned by `danbyte`, never committed.
- [ ] Postgres / Redis bound to localhost (or firewalled).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `5432` | PostgreSQL host / port |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `danbyte` | Database name / role / password |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated; set on a server |
| `DJANGO_SECRET_KEY` | `dev-key-change-in-prod` | **Required when `DEBUG=False`** |
| `DEBUG` | `True` | Disable in prod |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | Frontend origin(s) |
| `DANBYTE_LOG_DIR` | — (console only) | Writable dir for file logs, e.g. `/var/log/danbyte` |
| `DJANGO_SUPERUSER_USERNAME` / `_EMAIL` / `_PASSWORD` | — | `bootstrap` creates this admin when set |

See `danbyte/settings.py` for the full list.

### Verifying

```bash
make status       # all services
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/prefixes/   # expect 200
```

Next: **[Upgrading](upgrading.md)** when a new release lands.
