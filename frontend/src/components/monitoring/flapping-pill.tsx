import { Activity } from "lucide-react"

import { Badge } from "@/components/ui/badge"

/**
 * The flapping state, as the alerts page has always drawn it: a warning
 * badge with the activity mark. One component so every list column, the IP
 * summary, the device page and the check rows say it the same way. `count`
 * is how many checks under the target are flagged; omitted on a single
 * check.
 */
export function FlappingPill({ count }: { count?: number }) {
  return (
    <Badge variant="warning" className="gap-1">
      <Activity className="h-3 w-3" />
      Flapping
      {count != null && count > 1 && <span className="num">{count}</span>}
    </Badge>
  )
}
