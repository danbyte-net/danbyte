import { Link } from "@tanstack/react-router"
import { ArrowUpRight, Crosshair, EyeOff, Square } from "lucide-react"

import type { RoutingNode } from "@/lib/api"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu"

// The Routing tab's right-click menus: a card's (open it, focus on it,
// hide it) and the empty canvas's (a zone). Lines and boxes use the
// Diagram's own (EdgeMenuItems, RegionMenuItems).

export function RouterMenuItems({
  node,
  onFocus,
  onHide,
}: {
  node: RoutingNode
  onFocus: (deviceId: string) => void
  onHide: () => void
}) {
  const d = node.type === "router" ? node.data : null
  return (
    <>
      {d?.device_id && (
        <>
          <DropdownMenuItem asChild>
            <Link to="/devices/$id" params={{ id: d.device_id }}>
              <ArrowUpRight /> Open device
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFocus(d.device_id!)}>
            <Crosshair /> Focus
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      {d?.vm_id && (
        <>
          <DropdownMenuItem asChild>
            <Link to="/virtual-machines/$id" params={{ id: d.vm_id }}>
              <ArrowUpRight /> Open VM
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      {node.type === "provider_network" && (
        <>
          <DropdownMenuItem asChild>
            <Link
              to="/provider-networks/$id"
              params={{ id: node.data.provider_network_id }}
            >
              <ArrowUpRight /> Open provider network
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onSelect={onHide}>
        <EyeOff /> Hide
        <DropdownMenuShortcut>H</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  )
}

export function RoutingPaneMenuItems({
  builder,
  onAddZone,
  onBackToFiltered,
}: {
  builder: boolean
  onAddZone: () => void
  onBackToFiltered: () => void
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onAddZone}>
        <Square /> Add zone
      </DropdownMenuItem>
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
