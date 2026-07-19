---
icon: lucide/list-checks
---

# Jobs (background queue)

Some work in Danbyte doesn't finish in the moment you ask for it — discovering
every host in a large prefix, running scheduled health checks, sending
notifications. That work runs in the background on a **worker** pulling jobs off
a **queue**. The **Jobs** page (under **Governance** in the sidebar) is where you
watch it happen and step in when something is stuck.

!!! info "Where this lives"
    **Sidebar → Governance → Jobs.** It's only visible to people who hold the
    **Manage background jobs** permission (`jobs.manage`) — see
    [Who can see it](#who-can-see-it).

## What you'll see

The page polls live (every couple of seconds) so counts move on their own.

**Worker status** sits in the top-right: how many workers are connected and how
many are currently busy. This is the single most useful number on the page —
**if it reads `0 workers`, nothing in the queue will run**, no matter how many
jobs are waiting. When that's the case and jobs are queued, a red banner spells
it out and tells you how to start a worker:

```
systemctl --user start danbyte-workers
```

**State tabs** let you filter the table, each showing a live count:

| State | Meaning |
|---|---|
| **Queued** | Waiting for a free worker to pick it up. |
| **Running** | A worker is executing it right now. |
| **Finished** | Completed successfully (kept for a short while, then expires). |
| **Failed** | Raised an error. Open it to read the traceback. |
| **Deferred** / **Scheduled** | Waiting on another job or a future time (only shown when present). |

You can also narrow by **queue** (`default`, `high`, `low`). Each row shows the
job's function, queue, the worker handling it, when it was enqueued, and how long
it ran. Click any row to open its detail.

## Job detail

The detail page shows everything recorded for one job: its ID, function,
queue, the worker that ran it, timestamps, duration, and its arguments. Then,
depending on outcome:

- **Result** — the value a finished job returned.
- **Traceback** — the full error for a failed job, so you can see *why* it
  failed without digging through worker logs.

### Acting on a job

Two actions are available to anyone with `jobs.manage`:

- **Requeue** — put a **failed** job back on its queue to try again (for example
  after fixing whatever it depended on).
- **Cancel** — remove a **queued**, deferred, scheduled, or running job from the
  queue and delete it.

!!! tip "Clearing orphaned jobs"
    A job enqueued by code or an integration that no longer exists can't be read
    back — it shows as **unreadable** with its arguments unavailable (its
    timestamps are still accurate). These are harmless but clutter the queue;
    **Cancel** clears them out.

## Who can see it

Access is a single grantable permission, **`jobs.manage`** ("Manage background
jobs"):

- **Administrators hold it automatically** — no setup needed.
- To give it to anyone else, edit their account and grant **Manage background
  jobs** (it appears under the **Admin** group of permissions on the user form).

The same permission gates the API and the Requeue/Cancel actions, so it's
enforced on the server — not just hidden in the sidebar.

## When to reach for this

- **"I started a scan and nothing's happening."** Open Jobs. If workers read `0`,
  start the worker; if jobs are **Running**, they're just working through a
  backlog (a large sweep is many jobs, each taking a few seconds).
- **A scheduled check or notification didn't fire.** Look in **Failed** and read
  the traceback.
- **The queue looks huge.** Filter by state to see whether it's genuinely backed
  up or just full of recently-finished jobs that will expire.

See also: [Monitoring](monitoring.md) and the prefix
[auto-discovery](../ipam/index.md) that enqueue most of this work.
