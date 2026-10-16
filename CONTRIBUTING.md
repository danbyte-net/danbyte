# Contributing to Danbyte

Thanks for helping. Bug reports, feature ideas, docs fixes and pull requests
are all welcome.

Security problems go through [SECURITY.md](SECURITY.md), never a public issue.
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Issues

- **Bugs:** use the bug template. Say what you did, what you expected and
  what happened, with the version (user menu or Settings → Updates) and how
  you installed Danbyte. Screenshots and the browser console's error help.
- **Features:** describe the problem you have before the solution you want.
  For anything larger than a small change, agree on the idea in an issue
  before writing the code - it saves rework on both sides.

## Branches

`main` holds the latest release. New work goes into the development branch
of the next version, `dev/vX.Y.0` (for example `dev/v0.18.0`).

**Open pull requests against the current `dev/` branch, not `main`.** Released
versions get no patch releases, so fixes go there too.

## Development setup

You need Python 3.13, Node.js 20.19 or newer, and Docker (or your own
PostgreSQL 17 and Redis 7).

```bash
git clone https://github.com/danbyte-net/danbyte.git && cd danbyte
git switch dev/v0.18.0            # the current dev/ branch

# PostgreSQL and Redis
docker compose -f docker-compose.dev.yml up -d postgres redis

# Backend
uv venv --python 3.13 .venv
VIRTUAL_ENV=$PWD/.venv uv pip install -r requirements.txt
cp .env.example .env               # set DJANGO_SECRET_KEY
make migrate
make bootstrap
make seed-demo                     # optional example data
.venv/bin/python manage.py runserver    # :8000

# Background jobs (scans, checks, imports), in a second terminal
.venv/bin/python manage.py rqworker default high low

# Frontend, in a third terminal
cd frontend && npm ci && npm run dev    # :3000, proxies the API to :8000
```

Open <http://localhost:3000>. [docs/getting-started](docs/getting-started/)
covers installation, Docker and upgrades in more depth.

Use **npm** for the frontend; `package-lock.json` is the only lockfile.

## Before you open a pull request

**Backend**

```bash
.venv/bin/ruff check <changed paths>
.venv/bin/python manage.py makemigrations --check
.venv/bin/python manage.py test <app.tests_module>   # the suites you touched
```

**Frontend** - build first, it regenerates the route tree:

```bash
cd frontend
npm run build
npm run typecheck
npm test
```

**The rules a review checks:**

- **Tenant, site and permission checks happen on the server.** Scope every
  query to the tenant and the user's permissions before filtering by an id
  from the request. Hiding a button is not access control.
- **Schema changes come with a forward migration.** Never edit or delete a
  committed migration.
- **Fixes come with a test** that fails without the fix.
- **User-visible changes update `docs/`** in the same pull request.
- **No illustrative data in migrations or bootstrap.** Example devices,
  prefixes and the like belong in the opt-in demo seeders.
- **The UI reuses the shared components** - list and detail shells, pickers,
  badges, loading and empty states. The design system is in
  [docs/design/visual-language.md](docs/design/visual-language.md).
- **Keep the change focused:** no unrelated refactors, reformatting or
  dependency bumps.

[AGENTS.md](AGENTS.md) has the full set of conventions, for people and
coding assistants alike.

## Commits and pull requests

- Short, plain commit subjects that say what changed: `Rack list sorts by
  name naturally (#412)`.
- Reference the issue as `(#N)`. Issues close when the fix is released, so
  avoid `Fixes #N` in commits.
- In the pull request, say what changed and how you tested it, with a
  screenshot for UI changes.

## Licence

Danbyte is licensed under the [Apache License 2.0](LICENSE). By submitting a
contribution you agree it is licensed under the same terms (section 5 of the
licence); no separate agreement is needed.
