---
icon: lucide/square-kanban
---

# Planning boards

Planning gives Danbyte a lightweight ticket board wired straight into your
inventory: kanban boards whose tasks can **link any Danbyte object** — a device,
prefix, IP, circuit, site, certificate — so the work and the thing it's about
live on the same page. Find it under **Organization → Planning**, with
the org-wide **Calendar** beside it.

## Boards

A board is a kanban surface for a team or a purpose ("DC migration", "Daily
ops"). Create as many as you need; each is tenant-scoped and RBAC-controlled
like every other object (`planning.board` and friends in the permission model).

A new board starts with four columns — **Backlog, To do, In progress, Done** —
as a working starting point. They're ordinary editable status rows, not fixed
workflow: rename, recolor, reorder or replace them.

## Task statuses (columns)

Columns are **status rows**, managed under **Statuses → Task statuses**
alongside every other status catalog. Each row has:

- **Name, color, weight** — fully yours; lower weights sort further left.
- **Semantic group** — `backlog / unstarted / started / completed / cancelled`.
  This is what Danbyte *means* by the column: "Completed" and "Cancelled" count
  as closed no matter what you name them. Statuses stay user-editable while the
  semantics stay machine-readable.

A status that still has tasks can't be deleted — move them first.

## Assignees

Assign a task to one or more people from the task sheet. The picker reads
`/api/planning/assignable-users/`, which lists active users **of the current
tenant** and is gated on *task* rights rather than user-administration rights —
so an engineer who can edit tasks can assign them without also being able to
administer accounts. Email addresses are included only for callers who may
already read users.

On the board, the faces of everyone with work on that board sit in the header:
click one to filter the board to their tasks, click **Unassigned** for the
orphans, click again to clear. The task count reads `3 of 12` while a filter is
active. Cards name their assignee (or say `3 assignees`) rather than showing
initials alone.

## Milestones

A milestone is a named target on a board that tasks roll up to — "Rack A
cutover", "Q3 audit". Open **Milestones** in the board header to create, rename,
recolor, redate or delete them; each row shows how many tasks point at it.
Assign one from the task sheet.

Deleting a milestone keeps its tasks — they simply lose the milestone. (A status
behaves differently: it can't be deleted while tasks still use it.)

## Tasks

A card carries a title, a markdown description (same subset as compliance
guides), a priority, **assignees**, tenant-wide colored **labels**, an optional
milestone, optional start/due dates, and:

- **Linked objects** — attach anything Danbyte knows about via the same object
  picker custom fields use, including interfaces. In the task sheet links are
  grouped by object type, deep-link to the object's detail page, and a linked
  **device also shows its front/rear faceplate** so "replace this switch" comes
  with a picture of the switch. Links are RBAC-gated: you can only link objects
  you can view, and a link can't be retargeted afterwards (delete and re-add).
- **Comments** — the shared Journal, exactly like the Journal tab on any detail
  page.

The card itself is meant to answer *what, which object, and when* without being
opened: priority and labels as badges, linked-object chips with their type icon
and real name, assignee avatars, and a schedule line that says how far off the
due date is (`Due today`, `Due in 3 days`, `2 days overdue`) next to the date
itself. "Today" is evaluated in **your effective display timezone** — the same
user → tenant → deployment resolution the rest of Danbyte uses — so an overdue
card is overdue by your calendar, not the server's.

Drag cards between columns — one small write per drop, so the board stays fast.
Click a card to open the detail sheet. The **+** in a column header (or the
dashed **Add task** row) quick-adds a task by title alone.

The sheet shows the task rather than a form for it. The title is the heading —
click it and type. Status, priority, assignees, milestone and the dates are
values you click to change, and each one writes immediately, the same single
small PATCH a drag between columns makes; there is no Save button. The
description is prose until you click into it, and commits when you click away
(`Esc` abandons an edit). Delete lives in the **⋯** menu.

**Open** takes the task to its own page — a back arrow returns you to the board.
The sheet is for a glance; a task carrying linked devices, planned changes and a
comment thread reads better as a page, with the properties in a rail beside the
content. The page has its own URL, so it can be linked to and bookmarked.

## On the dashboard and in the digest

The **My tasks** dashboard widget lists your open tasks, most urgent first —
overdue in red, using the same schedule wording the cards use. "Open" follows
the status row's semantic group, so renamed columns still count correctly.

The daily **email digest** gains a *Planned work* section when anything is due:
overdue / due today / due this week counts, plus the most urgent tasks with
their boards and assignees. It rides the existing digest schedule and settings —
nothing new to configure.

## Planned changes

A task can declare **what will change**. Planning is editing: from a linked
object, "Plan a change" opens **that object's own edit form**, pre-filled with
real values. Change whatever you want — three fields, the rack, the status — and
save. Nothing is written; the fields that actually differ are recorded on the
task as a planned change. "Plan a new interface" opens the interface create form
the same way.

Because it is literally the same form, every field is editable, with the same
validation and the same layout — there is no second implementation to keep in
sync and no "which fields are plannable" question.

**What can be planned** is anything the API exposes as an editable object: every
IPAM, DCIM, connectivity, organization and customization form goes through the one
save path, so its type is plan-capable. The exceptions are deliberate — a **cable
connection**, whose form is a pair of termination pickers rather than a set of
fields; the multi-step **wizards** (onboarding, automation target), which build
several objects in sequence; and **users, groups and tags**, which a planned
change can't point at because their primary keys aren't UUIDs.

!!! note "Secrets are never stored in a plan"
    A plan is readable by everyone who can see the task, so any field the API
    treats as write-only — a password, a webhook signing secret — is dropped
    before the change set is stored. The payload is still validated in full, so
    the form behaves normally; the secret simply is not part of the plan, and
    such a value has to be set by editing the object directly.

!!! important "Apply updates Danbyte, not the device"
    Applying writes the values into Danbyte's own record — it does not push
    configuration to hardware. That is the separate automation/deploy path.
    Nothing applies itself either: a planned change is documentation until a
    human confirms the work happened. There is no scheduler.

**Only real changes are recorded.** The form submits its whole payload, as it
always does; the server validates it through the object's own serializer and
keeps only the keys that differ. Saving without changing anything records
nothing and says so. Validation happens at plan time too, so a change that could
never apply is refused up front rather than failing later.

**An optional implementation date** (`planned_for`) sits on each change, because
one task often changes several things on different days — disable the port on
Friday, decommission the device on Monday. Leave it empty and the change
inherits the task's due date; either way the target's badge counts down to the
right one.

**Permissions split deliberately.** Planning needs **view** on the target — an
engineer describing desired work is the workflow. Applying an edit needs
**change** on the target itself, not on the task; applying a *create* needs
**add**. Applying also cannot move an object outside your own site scope: that is
re-checked after the write and rolled back.

**If the world moved on**, apply refuses. The values are snapshotted when the
change is planned, and only the fields this change touches are compared — someone
else editing an unrelated field does not invalidate your plan. When a field you
planned has moved, Apply returns a conflict showing what it is *now* and offers
to overwrite anyway.

Applying leaves two trails: the normal **change-log** entry on the object, plus a
**journal note** naming the task and listing the diff — so the object's own
history explains why it changed.

## API

Everything lives under `/api/planning/`: `boards/`, `statuses/`, `labels/`,
`milestones/` (filter by `board`), `tasks/` (filter by `board`, `status`,
`assignee`, `label`, `milestone`, `q`), `links/` (filter by `task`, or
reverse-look-up with `object_type` + `object_id` to find every task referencing
an object), `assignable-users/`, and `planned-changes/`:

| Endpoint | Purpose |
| --- | --- |
| `GET planned-changes/?task=` | What this task will change |
| `GET planned-changes/?object_type=&object_id=` | What is planned for this object |
| `GET planned-changes/map/` | Every open plan grouped by target — one request per table, for the per-row badge |
| `POST planned-changes/` | Stage one: `task`, `object_type`, `object_id` + the form's full `payload` (optional `planned_for`, `note`). `kind: "create"` omits `object_id`. |
| `POST planned-changes/{id}/apply/` | Write it. `409` when the live value moved; repeat with `{"force": true}` to overwrite |
| `POST planned-changes/{id}/cancel/` | Decide against it; writes nothing to the target |

`payload` is reduced to the changed keys server-side, and `before`/`display` are
computed there too — a client cannot assert what the old values were. `stale` is
computed per read rather than stored. Target, kind and payload are immutable once
planned (re-plan instead); applied and cancelled rows are history and can be
neither edited nor deleted.

All endpoints are tenant-scoped and default-closed; all planning models are
audited.

## Coming next

The planning calendar (global and per-board), freeze windows that can suppress
monitoring notifications, provider maintenance/outage events, and an iCal feed
are planned follow-ups on this foundation.
