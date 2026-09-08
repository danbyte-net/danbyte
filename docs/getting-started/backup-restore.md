---
icon: lucide/archive
---

# Backup and restore

Danbyte backs itself up and restores itself from **Settings → Backups**. A
backup is one encrypted archive that holds the database, the uploaded media
and the non-secret deployment configuration. A restore replaces the live
data with an archive while the site shows the maintenance page.

This complements an external backup of the host; it does not replace one.
The archive does not contain the two secret keys, so keep `.env` somewhere
safe as well.

## What is in an archive

| Component  | Contents                                                          |
|------------|-------------------------------------------------------------------|
| `db`       | `pg_dump` of the whole database: every object, account and setting |
| `media`    | `MEDIA_ROOT` (images, documents, thumbnails) and `plugins_local/` |
| `config`   | deployment settings minus secrets, enabled timers, installed plugins, the non-secret `.env` keys |

Every archive also carries a `manifest.json`: Danbyte version, git commit,
the list of applied migrations, per-type object counts, file count and
sizes. The Backups page shows it, and a restore checks it first.

Not in an archive, ever: `DJANGO_SECRET_KEY`, `MONITORING_SECRET_KEY`,
`DB_PASSWORD`, SMTP passwords, TLS keys.

### The key rule

Archives are encrypted with AES-256-GCM under a key derived from
`MONITORING_SECRET_KEY` - the same key that encrypts credentials inside the
database. There is no unencrypted option.

To restore on another host, **copy `MONITORING_SECRET_KEY` to the new host
first**. An archive made under another key is refused at upload and at
preview with a clear message, instead of restoring a database whose
credentials silently decrypt to nothing.

The file format is `.dbk`: a small header (magic, salt, key check) followed
by the encrypted stream. Nothing else reads it; download it, keep it, upload
it back.

## Targets

A target is where archives are stored.

- **Local directory** - the default target, seeded on first start at
  `DANBYTE_BACKUP_DIR` (default `<install>/../danbyte-backups`, `/app/backups`
  in the container stack). Files are written `0600`.
- **S3-compatible bucket** - bucket, optional prefix, endpoint URL (blank for
  AWS), region and an access key pair. Needs `boto3` in the environment; the
  Test button says so when it is missing.

**Test** writes and removes a marker on the target. A failing target shows its
last error on the Backups page. One target is the **default**; *Back up now*
and uploads use it.

**Scan for archives** adopts `.dbk` files on the target that have no row:
archives copied into the directory by hand, or a whole directory carried
over from another host. Each is opened for its manifest; one made under
another key is skipped.

## Schedules

A schedule is a cadence (hourly, daily, weekly, monthly, with a wall-clock
time), the components to include, a target, a retention rule and the
notification channels that hear about its runs.

- **Retention**: keep at most *N* archives and/or nothing older than *N* days.
  It runs after each successful run and only touches that schedule's own
  backups. **Protected** backups are never pruned.
- **Run now** makes an extra backup without moving the schedule's next
  occurrence.
- The tick is the `danbyte-backups` timer (every 5 minutes on systemd, the
  `scheduler` container in Docker). A schedule fires once per occurrence.

## Backups

The table lists every archive with its kind, components, size, status and
who made it. Kinds:

| Kind               | Made by                                                   |
|--------------------|-----------------------------------------------------------|
| Manual             | *Back up now*, or `manage.py backup_now`                  |
| Scheduled          | a schedule                                                |
| Before upgrade     | the upgrade scripts, before migrating                     |
| Before restore     | every restore, of the state it is about to replace (protected) |
| Uploaded           | *Upload backup*                                           |

Row actions: **Steps** (what the run did), **Download**, **Restore…**,
**Protect** / **Unprotect**, **Delete**. A protected backup cannot be
deleted or pruned.

Backups run in the RQ worker (`danbyte-workers`); a queued backup that
never starts means the workers are down - see [Jobs](../features/jobs.md).

## Restore

**Restore…** on a backup opens the preview:

- **Checks**: the archive opens with this host's key; the components are
  present; every migration in the archive is known to this version (an
  archive from a *newer* Danbyte is refused - upgrade first); the database
  role owns the database; enough disk under `DANBYTE_BACKUP_DIR`; no upgrade
  is running.
- **This replaces**: object counts from the archive, so you know what you
  are about to overwrite.
- The components to restore, and the deployment name typed to confirm.

Then, in the worker, in order:

1. Take the **upgrade lock** (an upgrade or a second restore is refused
   while it is held).
2. Make a **Before restore** backup of the current state and protect it.
3. Raise the **maintenance flag**. Every request answers `503` with
   `Retry-After`, which nginx turns into the "Danbyte is updating" page;
   only the health probe and the restore-status endpoint stay open. The
   running restore's status is answered from Redis, so the dialog keeps
   showing progress even while the database has no tables.
4. Terminate the other database sessions, drop and recreate the `public`
   schema, `pg_restore` the dump and run `migrate` forward.
5. **Reconcile**: the restored database predates the restore, so the rows
   describing it - the target, the archive, the *Before restore* backup and
   the run itself - are written back, and every other archive on the target
   without a row (backups made after the archive's point in time) is
   adopted. Nothing on disk is lost by restoring.
6. Extract the media tree next to the live one and swap them; the old tree
   is kept until the run succeeds.
7. Rebuild the search index, flush the RQ queues, clear the flag, release
   the lock.

Nothing restarts. Django holds no schema state between requests, so the
site is live again the moment the flag drops; the dialog offers **Reload**.
Logged-in sessions survive because `DJANGO_SECRET_KEY` does not change.

If a step fails after the schema was dropped, the run is marked failed with
the step and error, the maintenance flag is cleared, and the *Before
restore* backup is right there in the list to restore from.

### Moving to a new host

1. Install Danbyte on the new host and set the same `MONITORING_SECRET_KEY`.
2. Download the archive from the old host, **Upload backup** on the new one.
3. **Restore…** it. The database, media and configuration come across;
   re-enter the secrets that live in `.env`.

## From the shell

```bash
manage.py backup_now --components db,media,config [--target NAME] [--kind manual|pre_upgrade]
manage.py run_backups            # the schedule tick
manage.py restore_backup <id> [--components db,media] --yes
```

`backup_now` runs inline (no worker) and prints the archive path - the
upgrade scripts call it before migrating and stop when it fails, unless
`DANBYTE_SKIP_BACKUP=1`. `restore_backup` is the same engine for an admin
without a browser.

## Notifications

A schedule's channels get one line per run: success (components, size,
target) or failure (the step and the error). Every channel kind works -
email, webhook, Slack, Teams, Discord, PagerDuty. A failed run of any kind
also mails the deployment **digest recipients** (Settings → Email). A
manual run that succeeds notifies nobody.

## Docker

The compose stack mounts a `backups` volume and the `media` volume into
`backend` and `workers`; `DANBYTE_BACKUP_DIR` is `/app/backups`. A restore
runs inside the `workers` container against the `postgres` service over the
network and never restarts a container. Copy archives out with
`docker compose cp workers:/app/backups/<file> .` or use **Download**.
