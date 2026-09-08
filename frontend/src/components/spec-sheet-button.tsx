import { FileText } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Opens the object's printable spec sheet (a server-rendered PDF, #150) in
 * a new tab. The browser's own viewer handles print and save.
 */
export function SpecSheetButton({
  kind,
  id,
}: {
  kind: "device" | "vm" | "vc"
  id: string
}) {
  const base = {
    device: "/api/devices",
    vm: "/api/virtual-machines",
    vc: "/api/virtual-chassis",
  }[kind]
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        window.open(`${base}/${id}/spec-sheet/`, "_blank", "noopener")
      }
    >
      <FileText className="h-3.5 w-3.5" /> Spec sheet
    </Button>
  )
}
