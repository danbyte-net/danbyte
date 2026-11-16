import { Cpu, FileText, Layers } from "lucide-react"

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"

const BASE = {
  device: "/api/devices",
  vm: "/api/virtual-machines",
  vc: "/api/virtual-chassis",
}

function open(url: string) {
  window.open(url, "_blank", "noopener")
}

/**
 * The object's printable spec sheet (a server-rendered PDF, #150), opened in
 * a new tab where the browser's own viewer handles print and save - as items
 * for the detail header's Export menu (#507). A device has three: the
 * datasheet, a hardware sheet that leads with CPU, memory and storage instead
 * of rack position and power, and both on one sheet, in a submenu.
 */
export function SpecSheetMenuItems({
  kind,
  id,
}: {
  kind: "device" | "vm" | "vc"
  id: string
}) {
  const base = `${BASE[kind]}/${id}/spec-sheet/`
  if (kind !== "device")
    return (
      <DropdownMenuItem onSelect={() => open(base)}>
        <FileText className="h-3.5 w-3.5" /> Spec sheet
      </DropdownMenuItem>
    )
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FileText className="h-3.5 w-3.5" /> Spec sheet
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-44">
        <DropdownMenuItem onSelect={() => open(base)}>
          <FileText className="h-3.5 w-3.5 shrink-0" /> Datasheet
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open(`${base}?variant=hardware`)}>
          <Cpu className="h-3.5 w-3.5 shrink-0" /> Hardware sheet
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open(`${base}?variant=full`)}>
          <Layers className="h-3.5 w-3.5 shrink-0" /> All in one
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
