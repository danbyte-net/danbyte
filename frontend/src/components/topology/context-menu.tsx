import { Link } from "@tanstack/react-router"
import {
  ArrowUpRight,
  Cable,
  Crosshair,
  EyeOff,
  PanelLeft,
  Pencil,
  RectangleHorizontal,
  Server,
  Square,
  Trash2,
  Type,
} from "lucide-react"

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { bandLook } from "./diagram/band-node"
import { SWATCH_NAMES } from "./diagram/swatch-names"
import { ZONE_COLORS } from "./view-positions"

// The topology map's right-click menus, one set of items per thing clicked,
// for PointerMenu (components/pointer-menu.tsx) to show at the pointer. An
// item reuses the toolbar's icon for the same action (Add ▸ Connected
// devices is Cable here too); an item with no toolbar twin is inset to line
// up with the rest. Each item closes the menu as it runs.

/** How a Diagram card is drawn, for the face items. */
export interface CardFace {
  /** Drawn as its photo now. */
  photo: boolean
  /** Its type has a front photo or faceplate to show. */
  canPhoto: boolean
  /** Where its cables meet it, while it is a photo. */
  anchor: "ports" | "edge"
  onFace: () => void
  onAnchor: () => void
}

export interface DeviceMenuProps {
  /** The device behind the card; null for a card with none (only Hide
   * applies to it). */
  deviceId: string | null
  /** A hand-picked map: devices are added and removed by hand. */
  builder: boolean
  onFocus: () => void
  onAddConnected: () => void
  onRemove: () => void
  onStartSet: () => void
  /** Hide the card, as its eye in the Objects sidebar would. */
  onHide?: () => void
  /** The Diagram's own card items; left out on the other tabs. */
  diagram?: {
    /** Photo or card; left out on a grouped map. */
    face?: CardFace
    /** This device's card lines (needs the device change permission). */
    onCardLines?: () => void
    /** The role whose card lines the settings page edits (admins). */
    roleSlug?: string
  }
}

/** Right-click on a device card. */
export function DeviceMenuItems({
  deviceId: id,
  builder,
  onFocus,
  onAddConnected,
  onRemove,
  onStartSet,
  onHide,
  diagram: d,
}: DeviceMenuProps) {
  const extras = !!id && !!d && !!(d.face || d.onCardLines || d.roleSlug)
  return (
    <>
      {id && (
        <>
          <DropdownMenuItem asChild>
            <Link to="/devices/$id" params={{ id }}>
              <ArrowUpRight /> Open device
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onFocus}>
            <Crosshair /> Focus
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {builder ? (
            <>
              <DropdownMenuItem onSelect={onAddConnected}>
                <Cable /> Add connected devices
              </DropdownMenuItem>
              <DropdownMenuItem inset onSelect={onRemove}>
                Remove from map
                <DropdownMenuShortcut>Del</DropdownMenuShortcut>
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem inset onSelect={onStartSet}>
              Start hand-picked map
            </DropdownMenuItem>
          )}
        </>
      )}
      {onHide && (
        <DropdownMenuItem onSelect={onHide}>
          <EyeOff /> Hide
          <DropdownMenuShortcut>H</DropdownMenuShortcut>
        </DropdownMenuItem>
      )}
      {extras && (
        <>
          <DropdownMenuSeparator />
          {d.face && <FaceItems face={d.face} />}
          {d.onCardLines && (
            <DropdownMenuItem inset onSelect={d.onCardLines}>
              Card lines…
            </DropdownMenuItem>
          )}
          {d.roleSlug && (
            <DropdownMenuItem inset asChild>
              <Link to="/settings/topology" search={{ role: d.roleSlug }}>
                Role card lines
              </Link>
            </DropdownMenuItem>
          )}
        </>
      )}
    </>
  )
}

/** Photo or card, named for what a pick switches to; and, on a photo,
 * where its cables meet it. */
function FaceItems({ face }: { face: CardFace }) {
  if (!face.photo && !face.canPhoto)
    // Nothing to switch to. Disabled items take no pointer, so the tip
    // hangs on a wrapper.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <DropdownMenuItem inset disabled>
              Show photo
            </DropdownMenuItem>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" variant="default">
          No photo for this type
        </TooltipContent>
      </Tooltip>
    )
  return (
    <>
      <DropdownMenuItem inset onSelect={face.onFace}>
        {face.photo ? "Show card" : "Show photo"}
      </DropdownMenuItem>
      {face.photo && (
        <DropdownMenuItem inset onSelect={face.onAnchor}>
          {face.anchor === "edge" ? "Cables to ports" : "Cables to edge"}
        </DropdownMenuItem>
      )}
    </>
  )
}

/** Right-click on a site or location card of a grouped map. */
export function GroupMenuItems({
  onOpen,
  onHide,
}: {
  onOpen: () => void
  onHide: () => void
}) {
  return (
    <>
      {/* Drills in on this map: no leave-the-page arrow. */}
      <DropdownMenuItem inset onSelect={onOpen}>
        Open group
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onHide}>
        <EyeOff /> Hide
        <DropdownMenuShortcut>H</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  )
}

/** A swatch in a band or zone menu. */
interface Swatch {
  /** The stored color; null is a band's neutral grey. */
  value: string | null
  name: string
  className?: string
  style?: React.CSSProperties
}

/** The swatches a band or zone offers: a band adds Neutral, and shows each
 * hue as its edge so slate never reads as the neutral grey. */
export function regionSwatches(kind: "band" | "zone"): Swatch[] {
  const hues = ZONE_COLORS.map((c) => ({
    value: c,
    name: SWATCH_NAMES[c] ?? c,
    style: { background: kind === "band" ? bandLook(c).edge : c },
  }))
  if (kind === "zone") return hues
  return [
    { value: null, name: "Neutral", className: bandLook(null).className },
    ...hues,
  ]
}

/** Right-click on a band or a zone. */
export function RegionMenuItems({
  kind,
  color,
  onRename,
  onRecolor,
  onDelete,
}: {
  kind: "band" | "zone"
  /** Its color now (null: a band's neutral grey). */
  color: string | null
  onRename: () => void
  onRecolor: (color: string | null) => void
  onDelete: () => void
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onRename}>
        <Pencil /> Rename
      </DropdownMenuItem>
      <div role="group" aria-label="Color" className="flex gap-1 px-2 py-1.5">
        {regionSwatches(kind).map((s) => (
          <Tooltip key={s.name}>
            <TooltipTrigger asChild>
              <DropdownMenuItem
                role="menuitemradio"
                aria-label={s.name}
                aria-checked={s.value === color}
                onSelect={() => onRecolor(s.value)}
                className={cn(
                  "size-5 shrink-0 rounded-sm border p-0 focus:ring-2 focus:ring-ring/60",
                  s.value === color ? "border-foreground" : "border-border",
                  s.className
                )}
                style={s.style}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom" variant="default">
              {s.name}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 /> Delete
      </DropdownMenuItem>
    </>
  )
}

/** Right-click on empty canvas. */
export function PaneMenuItems({
  tab,
  builder,
  notesFull,
  onAddDevices,
  onAddBand,
  onAddZone,
  onAddText,
  onBackToFiltered,
}: {
  tab: "diagram" | "hierarchy"
  builder: boolean
  /** The map holds as many notes as it can. */
  notesFull: boolean
  /** The device list (Diagram) or the Add device dialog (Hierarchy). */
  onAddDevices: () => void
  onAddBand: () => void
  onAddZone: () => void
  onAddText: () => void
  onBackToFiltered: () => void
}) {
  const diagram = tab === "diagram"
  return (
    <>
      {diagram ? (
        <DropdownMenuItem onSelect={onAddDevices}>
          <PanelLeft /> Add devices…
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={onAddDevices}>
          <Server /> Add device…
        </DropdownMenuItem>
      )}
      {diagram && (
        <DropdownMenuItem onSelect={onAddBand}>
          <RectangleHorizontal /> Add band
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={onAddZone}>
        <Square /> Add zone
      </DropdownMenuItem>
      {diagram && (
        <DropdownMenuItem disabled={notesFull} onSelect={onAddText}>
          <Type /> Add text
        </DropdownMenuItem>
      )}
      {builder && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem inset onSelect={onBackToFiltered}>
            Back to filtered map
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}
