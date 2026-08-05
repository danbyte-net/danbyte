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

## Tasks

A card carries a title, a markdown description (same subset as compliance
guides), a priority, **assignees**, tenant-wide colored **labels**, optional
start/due dates, and:

- **Linked objects** — attach anything Danbyte knows about via the same object
  picker custom fields use. Chips deep-link to the object's detail page. Links
  are RBAC-gated: you can only link objects you can view, and a link can't be
  retargeted afterwards (delete and re-add).
- **Comments** — the shared Journal, exactly like the Journal tab on any detail
  page.

Drag cards between columns — one small write per drop, so the board stays fast.
Click a card to open the detail sheet. The **+** in a column header quick-adds a
task by title alone.

## API

Everything lives under `/api/planning/`: `boards/`, `statuses/`, `labels/`,
`tasks/` (filter by `board`, `status`, `assignee`, `label`, `q`), and `links/`
(filter by `task`, or reverse-look-up with `object_type` + `object_id` to find
every task referencing an object). All endpoints are tenant-scoped and
default-closed; all planning models are audited.

## Coming next

The planning calendar (global and per-board), freeze windows that can suppress
monitoring notifications, provider maintenance/outage events, and an iCal feed
are planned follow-ups on this foundation.
