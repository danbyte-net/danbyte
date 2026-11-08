import { useState } from "react"
import { Scan, Search } from "lucide-react"

import { SectionLabel } from "@/components/map-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TruncatedText } from "@/components/ui/truncated-text"
import { cn } from "@/lib/utils"

import {
  CLUSTER_LIST_CAP,
  filterClusterMembers,
  groupClusterMembers,
} from "./cluster-members"
import type { ClusterMember } from "./cluster-members"
import { TileBadge } from "./tile-badge"

// A cluster's members on screen - the 2D plan's icon clusters and the 3D
// room's summary plates share these: a hover lists them, a click opens
// the panel to pick one or zoom to them all.

/** Where it opens: px in the positioned wrapper (`absolute`) or the
 * viewport (`fixed`). */
export interface ClusterAt {
  x: number
  y: number
}

function Heading({ text, count }: { text: string; count: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TruncatedText className="min-w-0 flex-1 text-sm font-medium">
        {text}
      </TruncatedText>
      <Badge variant="secondary" className="num" data-part="cluster-count">
        {count}
      </Badge>
    </div>
  )
}

function MemberLine({ m }: { m: ClusterMember }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TileBadge icon={m.icon} color={m.color} className="size-4" />
      {m.name ? (
        <TruncatedText className="block min-w-0">{m.name}</TruncatedText>
      ) : (
        <span className="text-muted-foreground">Unnamed</span>
      )}
    </span>
  )
}

/** The members, grouped by kind when mixed, at most `cap`. */
export function ClusterMembersList({
  members,
  cap = CLUSTER_LIST_CAP,
  onPick,
}: {
  members: readonly ClusterMember[]
  cap?: number
  /** Rows are buttons that pick a member. */
  onPick?: (m: ClusterMember) => void
}) {
  const { groups, more } = groupClusterMembers(members, cap)
  return (
    <div className="flex flex-col gap-1.5" data-part="cluster-member-list">
      {groups.map((g) => (
        <div key={g.kind}>
          {g.label && <SectionLabel className="mb-0.5">{g.label}</SectionLabel>}
          <ul className="flex flex-col text-[12px]">
            {g.members.map((m) => (
              <li key={m.id} data-member={m.id}>
                {onPick ? (
                  <button
                    type="button"
                    onClick={() => onPick(m)}
                    className="flex w-full min-w-0 rounded px-1 py-0.5 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                  >
                    <MemberLine m={m} />
                  </button>
                ) : (
                  <div className="px-1 py-0.5">
                    <MemberLine m={m} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {more > 0 && (
        <p className="px-1 text-[11px] text-muted-foreground">+{more} more</p>
      )}
    </div>
  )
}

/** Hovering a cluster: its name, count and members. */
export function ClusterHoverCard({
  at,
  fixed = false,
  heading,
  members,
}: {
  at: ClusterAt
  fixed?: boolean
  heading: string
  members: readonly ClusterMember[]
}) {
  return (
    <Tooltip open>
      <TooltipTrigger asChild>
        <div
          aria-hidden
          className={cn("pointer-events-none", fixed ? "fixed" : "absolute")}
          style={{ left: at.x, top: at.y - 10 }}
        />
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="panel"
        data-part="cluster-members"
        className="w-56 flex-col items-stretch"
      >
        <Heading text={heading} count={members.length} />
        <ClusterMembersList members={members} />
      </TooltipContent>
    </Tooltip>
  )
}

/** A cluster clicked: every member, a search past the cap, a pick
 * selects one, and Zoom to these frames them all. */
export function ClusterMembersPanel({
  at,
  fixed = false,
  heading,
  members,
  onPick,
  onZoom,
  onClose,
}: {
  at: ClusterAt | null
  fixed?: boolean
  heading: string
  members: readonly ClusterMember[]
  onPick: (m: ClusterMember) => void
  onZoom: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const searchable = members.length > CLUSTER_LIST_CAP
  const shown = searchable ? filterClusterMembers(members, query) : members
  return (
    <Popover
      open={!!at}
      onOpenChange={(o) => {
        if (!o) {
          setQuery("")
          onClose()
        }
      }}
    >
      <PopoverAnchor asChild>
        <div
          aria-hidden
          className={cn("pointer-events-none", fixed ? "fixed" : "absolute")}
          style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        collisionPadding={8}
        aria-label="Cluster"
        data-part="cluster-panel"
        className="w-64 gap-2 p-2"
        onOpenAutoFocus={(e) => {
          if (!searchable) e.preventDefault()
        }}
        // A pointer down on the canvas behind does not reach the canvas
        // through the panel; only its own close goes.
        onPointerDown={(e) => e.stopPropagation()}
        // Escape closes the panel and nothing else: the canvas's own Escape
        // (clear the selection, fit the plan) waits for the next.
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <div className="px-1">
          <Heading text={heading} count={members.length} />
        </div>
        {searchable && (
          <InputGroup className="h-7">
            <InputGroupAddon>
              <Search className="size-3" />
            </InputGroupAddon>
            <InputGroupInput
              placeholder="Search…"
              aria-label="Search members"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </InputGroup>
        )}
        <div className="max-h-72 overflow-auto">
          {shown.length ? (
            <ClusterMembersList
              members={shown}
              cap={Infinity}
              onPick={(m) => {
                setQuery("")
                onPick(m)
              }}
            />
          ) : (
            <p className="px-1 text-[12px] text-muted-foreground">No match</p>
          )}
        </div>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            setQuery("")
            onZoom()
          }}
        >
          <Scan /> Zoom to these
        </Button>
      </PopoverContent>
    </Popover>
  )
}
