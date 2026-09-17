import { ChevronDown, Cpu, FileText } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
 * Opens the object's printable spec sheet (a server-rendered PDF, #150) in
 * a new tab. The browser's own viewer handles print and save. A device has
 * two: the datasheet, and a hardware sheet that leads with CPU, memory and
 * storage instead of rack position and power.
 */
export function SpecSheetButton({
  kind,
  id,
}: {
  kind: "device" | "vm" | "vc"
  id: string
}) {
  const base = `${BASE[kind]}/${id}/spec-sheet/`
  if (kind !== "device")
    return (
      <Button variant="outline" size="sm" onClick={() => open(base)}>
        <FileText className="h-3.5 w-3.5" /> Spec sheet
      </Button>
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <FileText className="h-3.5 w-3.5" /> Spec sheet
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onClick={() => open(base)}>
          <FileText className="h-3.5 w-3.5 shrink-0" /> Datasheet
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open(`${base}?variant=hardware`)}>
          <Cpu className="h-3.5 w-3.5 shrink-0" /> Hardware sheet
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
