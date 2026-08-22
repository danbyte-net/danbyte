---
icon: lucide/bookmark
---

# Port reservation

A hold on a single uncabled port - "this one will be needed" before the far
end of the run is known. Complements a *Planned* cable, which requires both
ends picked; a reservation names exactly one port. See
[Cabling → Port reservations](../dcim/cabling.md#port-reservations) for the
workflows.

## Fields

### Port

The held port - exactly one of the cable-termination kinds: interface,
front/rear port, console or console-server port, power port/outlet, power
feed, or aux port. A port can carry at most one reservation, and a cabled
port cannot be reserved.

### Reserved by

The user who placed the hold. Set automatically on create.

### Note

Short free text: who or what the port is being held for.

### Tenant

Reservations are tenant-scoped like everything else; the port must belong to
the active tenant.

### Created

When the hold was placed - shown as the age on the list page.

## Behavior

- Counts as **reserved** in [port utilization](../dcim/devices.md#the-device-page),
  exactly like a planned cable; a real cable or *mark connected* outranks it.
- **Auto-released** the moment any cable terminates on the port - including a
  planned one, which then carries the reserved state itself.
- RBAC object type *Port reservations* (default-closed); all changes are
  [audited](../features/change-log.md).
