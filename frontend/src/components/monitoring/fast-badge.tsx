import { Zap } from "lucide-react"

import { Badge } from "@/components/ui/badge"

/** A check on the fast lane, with its cadence: `1 s`, `500 ms`. */
export function FastBadge({ intervalMs }: { intervalMs: number }) {
  const label =
    intervalMs >= 1000
      ? `${Number.isInteger(intervalMs / 1000) ? intervalMs / 1000 : (intervalMs / 1000).toFixed(1)} s`
      : `${intervalMs} ms`
  return (
    <Badge variant="outline">
      <Zap className="h-3 w-3" />
      {label}
    </Badge>
  )
}
