import { Link } from "@tanstack/react-router"

import type { Interface, VirtualChassisMember } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { DeviceFaceplate } from "@/components/device-faceplate"
import { cn } from "@/lib/utils"

/** The stack drawn as a chassis — one bar per member in position order,
 * gaps rendered as dashed empty slots so the physical shape reads at a
 * glance. Same restrained language as the rack elevation: borders define
 * edges, color only for state (status dot, master crown). */
export function StackElevation({
  members,
  masterId,
  highlightId,
  interfacesByMember,
}: {
  members: VirtualChassisMember[]
  masterId: string | null
  highlightId?: string
  /** Per-member interface lists — when provided, each member renders its
   * front panel (the "switch builder") inside the bar. */
  interfacesByMember?: Map<string, Interface[]>
}) {
  if (members.length === 0)
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        An empty chassis — add the first member to draw the stack.
      </div>
    )

  const byPosition = new Map(
    members.filter((m) => m.vc_position != null).map((m) => [m.vc_position!, m])
  )
  const unpositioned = members.filter((m) => m.vc_position == null)
  const maxPos = Math.max(1, ...byPosition.keys())
  const slots = Array.from({ length: maxPos }, (_, i) => i + 1)

  return (
    // w-full (not w-fit): member faceplates fit-to-container, so every bar
    // measures the same width and the panels render at one consistent scale.
    <div className="grid w-full min-w-80 gap-1">
      {slots.map((pos) => {
        const m = byPosition.get(pos)
        if (!m)
          return (
            <div
              key={pos}
              className="flex h-11 items-center gap-3 rounded-md border border-dashed border-border px-0"
            >
              <PositionPuck pos={pos} empty />
              <span className="text-[11px] text-muted-foreground/70">
                empty slot
              </span>
            </div>
          )
        return (
          <MemberBar
            key={pos}
            member={m}
            pos={pos}
            isMaster={m.id === masterId}
            highlight={m.id === highlightId}
            interfaces={interfacesByMember?.get(m.id)}
          />
        )
      })}
      {unpositioned.map((m) => (
        <MemberBar
          key={m.id}
          member={m}
          pos={null}
          isMaster={m.id === masterId}
          highlight={m.id === highlightId}
          interfaces={interfacesByMember?.get(m.id)}
        />
      ))}
    </div>
  )
}

function PositionPuck({ pos, empty }: { pos: number | null; empty?: boolean }) {
  return (
    <span
      className={cn(
        "num flex h-full w-9 shrink-0 items-center justify-center border-r text-[13px] font-semibold",
        empty
          ? "border-dashed border-border text-muted-foreground/50"
          : "border-border bg-muted/50 text-muted-foreground"
      )}
    >
      {pos ?? "?"}
    </span>
  )
}

function MemberBar({
  member: m,
  pos,
  isMaster,
  highlight,
  interfaces,
}: {
  member: VirtualChassisMember
  pos: number | null
  isMaster: boolean
  highlight: boolean
  interfaces?: Interface[]
}) {
  const hasPanel = !!interfaces && interfaces.some((i) => !i.virtual)
  return (
    <div
      className={cn(
        "flex items-stretch overflow-hidden rounded-md border border-border bg-card",
        highlight && "border-primary/50"
      )}
    >
      <PositionPuck pos={pos} />
      <div className="min-w-0 flex-1 px-3 py-1.5">
        <div className="flex h-7 items-center gap-2">
          <Link
            to="/devices/$id"
            params={{ id: m.id }}
            className="truncate font-mono text-[13px] font-medium text-primary hover:underline"
          >
            {m.name}
          </Link>
          {isMaster && <Badge title="Stack master">master</Badge>}
          {m.serial_number && (
            <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:inline">
              {m.serial_number}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-3">
            {m.vc_priority != null && (
              <span
                className="num text-[11px] text-muted-foreground"
                title="Election priority"
              >
                pri {m.vc_priority}
              </span>
            )}
            {m.status && <StatusBadge status={m.status} />}
          </span>
        </div>
        {hasPanel && (
          <DeviceFaceplate
            interfaces={interfaces!}
            deviceId={m.id}
            deviceTypeId={m.device_type_id}
            vcPosition={m.vc_position}
            fit="container"
            className="mt-1 mb-1 border-0 bg-transparent p-0"
          />
        )}
      </div>
    </div>
  )
}
