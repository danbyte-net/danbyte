---
icon: lucide/file-code
---

# Scripts

A script is Python you write in Danbyte that reads and writes your data
through the API, as you. Use one to ingest or fix data in bulk, or to
produce a report: the classic case is "which routers have no OSPF area
set?", answered as a CSV you can download.

Scripts run on a button and on a schedule, take parameters, write files,
and can be shared with colleagues. They never see more than the person
they run as would see on the page.

## Writing one

**Scripts → New script** gives you a name and an editor. Everything the
script needs comes from one import:

```python
"""Routers with no OSPF area."""
from danbyte_sdk import db, run

missing = [
    d for d in db.list("devices", role="core")
    if not d["custom_fields"].get("CF_OSPF_AREA_X")
]
run.log(f"{len(missing)} of the core routers have no OSPF area")
run.output_csv("missing-ospf", missing, fields=["name", "site_name", "primary_ip"])
```

`db` is the API client, `run` is this run: its parameters, its log and its
files. The full list of calls is in the
[SDK reference](../reference/scripts-sdk.md).

Anything printed lands in the run log. `run.log(...)` adds a timestamp and
flushes immediately, which is what you want inside a loop.

## Parameters

Declare parameters under **How it runs**, and the Run dialog builds itself
from them: text, whole number, number, yes/no, long text, or one of a list.
Read them with `run.param("site")`; a missing required parameter is
refused before the script starts, not halfway through.

Scheduled runs use the parameters saved on the Schedule tab.

## What a script may do

Every run gets a **run token**: an API key minted for that run only, as the
run-as account, expiring with it. So a script sees exactly the tenant, the
sites and the objects that account sees, and every change it makes is in
the change log under that name.

Two settings shape it:

- **API access** - read and write, or read only. A read-only run cannot
  create, change or delete anything, whatever the code says.
- **Runs as** - the person who clicks Run, or the script's owner. Choose
  the owner when you share a script and want it to see the same data for
  everyone.

A run is stopped when it exceeds its **timeout** (five minutes by default,
an hour at most), uses too much memory, or writes more log or files than
the limits allow. Stopping a run takes the whole process tree with it.

## Sharing

A new script is private to you. On the **Sharing** tab:

| Who can see it | Means |
|---|---|
| Only me | The owner, and nobody else |
| Chosen users | The people you pick |
| Chosen groups | Everyone in the groups you pick |
| Everyone in the tenant | Published - needs the publish permission |

Sharing only ever narrows: a colleague also needs the `view` permission on
scripts, and running one needs `run`. Deleting and editing follow the same
permissions as any other object.

## Schedules

The **Schedule** tab runs a script hourly, daily, weekly or monthly. A
scheduled run belongs to the owner and uses the owner's access. The
`danbyte-scripts` timer checks every minute, and a schedule fires once per
occurrence even if the machine was asleep.

**Keep runs** prunes finished runs and their files after each scheduled
run, by count or by age.

## Runs and files

Every run has its own page: the live log (which follows the tail while it
runs), the parameters it got, how long it took, the code as it was when it
started, and the files it produced. Files come from `run.output_csv(...)`
and friends and download from that page.

A run that is still going can be stopped from the same page.

## Trusted scripts

A normal script talks to the API and is bound by it. A **trusted** script
additionally gets `danbyte_sdk.orm`, which reaches the database directly -
useful for a bulk job that would otherwise be thousands of API calls.

```python
from danbyte_sdk import orm, run

for device in orm.objects("device").filter(status__slug="active"):
    run.log(device.name)
```

`orm.objects(slug)` is already restricted to what the run-as account may
view. `orm.model(slug)` is not, and neither is anything else the script
imports.

Marking a script trusted is a separate permission (`trust` on scripts) for
that reason. **A trusted script runs with the worker's own privileges: it
can reach the database and the host as the Danbyte service account.** Only
grant it to people you would give a shell.

## What a sandboxed script cannot do

Being honest about the boundary:

- It gets no database credentials, no encryption keys and no Django
  settings. Its whole access is the run token.
- It cannot read another tenant's data, because the token cannot.

But it *is* a process on the Danbyte host, running as the service account.
It can open network connections and read files that account can read. It
is not a jail. Treat "who may write a script here" as a real permission,
which is why publishing to everyone and marking trusted each need one.

## Permissions

| Grant | Lets someone |
|---|---|
| `script: view` | See the scripts shared with them |
| `script: add` / `change` / `delete` | Author and manage scripts |
| `script: run` | Run one, and stop a run |
| `script: trust` | Mark a script trusted |
| `scripts.publish` | Publish a script to everyone in the tenant |

## From the shell

```bash
manage.py run_scripts     # the tick: fire due schedules, prune, drop dead run tokens
```

Runs themselves execute on the RQ workers, so a queued run that never
starts means the workers are down - see [Jobs](jobs.md).
