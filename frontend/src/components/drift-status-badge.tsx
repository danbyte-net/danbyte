import { Badge } from "@/components/ui/badge"
import type { DriftStatus } from "@/lib/api"

const STATUS: Record<
  DriftStatus,
  {
    label: string
    variant: "success" | "warning" | "destructive" | "secondary"
  }
> = {
  in_sync: { label: "In sync", variant: "success" },
  drift: { label: "Drift", variant: "warning" },
  error: { label: "Error", variant: "destructive" },
  unknown: { label: "Unknown", variant: "secondary" },
}

export function DriftStatusBadge({ status }: { status: DriftStatus }) {
  return (
    <Badge variant={STATUS[status].variant} className="text-[10px]">
      {STATUS[status].label}
    </Badge>
  )
}
