import { useState } from "react"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

import type { SyncOffer } from "./structure"

/** The cards' shared frame: over the plan, top centre, never in the way of
 * a click elsewhere. */
const CARD =
  "pointer-events-auto absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-sm shadow-md"

function Dismiss({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Dismiss"
      onClick={onClick}
    >
      <X />
    </Button>
  )
}

/**
 * After **Add walls around this**: the walls are named after the area and
 * linked to it; this asks once whether to keep the link (on by default).
 */
export function WallLinkCard({
  name,
  count,
  linked,
  onLinked,
  onDismiss,
}: {
  /** The area's name; null for walls round several areas. */
  name: string | null
  count: number
  linked: boolean
  onLinked: (on: boolean) => void
  onDismiss: () => void
}) {
  return (
    <div role="status" data-part="wall-link" className={CARD}>
      <span className="whitespace-nowrap">
        {count === 1 ? "1 wall added" : `${count} walls added`}
      </span>
      <div className="flex items-center gap-1.5">
        <Switch
          id="wall-link"
          size="sm"
          checked={linked}
          onCheckedChange={onLinked}
        />
        <Label htmlFor="wall-link" className="text-sm whitespace-nowrap">
          {name ? `Link to ${name}` : "Link to their areas"}
        </Label>
      </div>
      <Dismiss onClick={onDismiss} />
    </div>
  )
}

const RING_NOTE = {
  open: "Walls don't close",
  crossed: "Walls cross",
  "too-many": "Over 200 corners",
} as const

/**
 * A linked area reshaped or turned, or one of its walls edited by hand:
 * **Update walls** rebuilds the walls along the outline, **Update area**
 * redraws the outline along the walls. Doors that would no longer fit are
 * listed first and go only on a second yes.
 */
export function UpdateWallsCard({
  name,
  offer = { walls: true, area: null, lead: "walls" },
  drops,
  onUpdate,
  onUpdateArea,
  onConfirmDrops,
  onCancelDrops,
  onDismiss,
}: {
  name: string
  /** Which updates are on offer, and the one the card leads with. */
  offer?: SyncOffer
  /** The doors an update would drop, waiting for a yes; null = not asked. */
  drops: string[] | null
  onUpdate: () => void
  onUpdateArea?: () => void
  onConfirmDrops: () => void
  onCancelDrops: () => void
  onDismiss: () => void
}) {
  if (drops)
    return (
      <div role="status" data-part="update-walls" className={CARD}>
        <div className="flex flex-col gap-0.5">
          <span className="whitespace-nowrap">
            {drops.length === 1
              ? "1 door no longer fits"
              : `${drops.length} doors no longer fit`}
          </span>
          <span className="text-xs text-muted-foreground">
            {drops.join(", ")}
          </span>
        </div>
        <Button
          size="sm"
          variant="destructive"
          className="h-7"
          onClick={onConfirmDrops}
        >
          Update and drop
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={onCancelDrops}
        >
          Cancel
        </Button>
      </div>
    )
  const walls = offer.walls && (
    <Button
      key="walls"
      size="sm"
      variant={offer.lead === "walls" ? "default" : "outline"}
      className="h-7"
      onClick={onUpdate}
    >
      Update walls
    </Button>
  )
  const area = offer.area === "update" && onUpdateArea && (
    <Button
      key="area"
      size="sm"
      variant={offer.lead === "area" ? "default" : "outline"}
      className="h-7"
      onClick={onUpdateArea}
    >
      Update area
    </Button>
  )
  return (
    <div role="status" data-part="update-walls" className={CARD}>
      <span className="whitespace-nowrap">
        {offer.walls
          ? `${name} walls are off its outline`
          : `${name} is off its walls`}
      </span>
      {offer.area && offer.area !== "update" && (
        <span
          data-part="ring-note"
          className="text-xs whitespace-nowrap text-muted-foreground"
        >
          {RING_NOTE[offer.area]}
        </span>
      )}
      {offer.lead === "area" ? [area, walls] : [walls, area]}
      <Dismiss onClick={onDismiss} />
    </div>
  )
}

/** Deleting an area that has linked walls: delete them too (the default),
 * or keep them, unlinked. */
export function AreaWallsDeleteDialog({
  name,
  count,
  open,
  onOpenChange,
  onDelete,
}: {
  name: string
  count: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete: (walls: "delete" | "keep") => void
}) {
  const [withWalls, setWithWalls] = useState(true)
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setWithWalls(true)
        onOpenChange(o)
      }}
      title={`Delete ${name}?`}
      description={
        count === 1 ? "It has 1 linked wall." : `It has ${count} linked walls.`
      }
      onConfirm={() => {
        onDelete(withWalls ? "delete" : "keep")
        setWithWalls(true)
      }}
    >
      <div className="flex items-center gap-2 text-sm">
        <Checkbox
          id="area-walls-too"
          checked={withWalls}
          onCheckedChange={(v) => setWithWalls(v === true)}
        />
        <Label htmlFor="area-walls-too">
          {count === 1 ? "Delete the wall too" : "Delete the walls too"}
        </Label>
      </div>
    </ConfirmDialog>
  )
}

/** The wall inspector's link: the area it follows, and Unlink. */
export function WallLinkRow({
  areaName,
  onUnlink,
}: {
  areaName: string
  onUnlink: () => void
}) {
  return (
    <div
      data-part="wall-link-row"
      className="flex items-center justify-between gap-2 text-xs"
    >
      <span className="min-w-0 truncate text-muted-foreground">
        Linked to <span className="text-foreground">{areaName}</span>
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2"
        onClick={onUnlink}
      >
        Unlink
      </Button>
    </div>
  )
}

/** The area inspector's walls: how many are linked, Select and Unlink. */
export function AreaWallsRow({
  count,
  onSelect,
  onUnlink,
}: {
  count: number
  onSelect: () => void
  onUnlink: () => void
}) {
  return (
    <div
      data-part="area-walls-row"
      className="flex items-center justify-between gap-2 text-xs"
    >
      <span className="text-muted-foreground">
        Walls: <span className="num text-foreground">{count}</span> linked
      </span>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2"
          onClick={onSelect}
        >
          Select
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2"
          onClick={onUnlink}
        >
          Unlink
        </Button>
      </div>
    </div>
  )
}
