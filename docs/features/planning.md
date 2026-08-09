---
icon: lucide/square-kanban
---

# Planning boards

Planning gives Danbyte a lightweight ticket board wired straight into your
inventory: kanban boards whose tasks can **link any Danbyte object** — a device,
prefix, IP, circuit, site, certificate — so the work and the thing it's about
live on the same page. Find it under **Governance → Planning**.

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

## API

Everything lives under `/api/planning/`: `boards/`, `statuses/`, `labels/`,
`milestones/` (filter by `board`), `tasks/` (filter by `board`, `status`,
`assignee`, `label`, `milestone`, `q`), and `links/` (filter by `task`, or
reverse-look-up with `object_type` + `object_id` to find every task referencing
an object). All endpoints are tenant-scoped and default-closed; all planning
models are audited.

## Coming next

The planning calendar (global and per-board), freeze windows that can suppress
monitoring notifications, provider maintenance/outage events, and an iCal feed
are planned follow-ups on this foundation.
