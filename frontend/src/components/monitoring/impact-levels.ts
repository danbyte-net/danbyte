// Maintenance impact levels (issue #20) - one list for the event's impact
// panel and the feed "Affected" panels that prefill it (#434).

export const LEVELS = [
  { value: "no_impact", label: "No impact" },
  { value: "reduced_redundancy", label: "Reduced redundancy" },
  { value: "degraded", label: "Degraded" },
  { value: "outage", label: "Outage" },
]

export const levelTone: Record<string, string> = {
  no_impact: "text-muted-foreground",
  reduced_redundancy: "text-amber-600 dark:text-amber-400",
  degraded: "text-amber-600 dark:text-amber-400",
  outage: "text-red-600 dark:text-red-400",
}
