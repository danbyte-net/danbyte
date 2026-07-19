// Thin utilisation bar + percentage. Color tiers match the prefix table:
// ≤85 neutral (primary), 85–95 amber, >95 red. Null = n/a (IPv6, container).
export function UtilCell({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted-foreground">—</span>
  const color =
    pct > 95 ? "bg-red-500" : pct > 85 ? "bg-amber-500" : "bg-primary"
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-[11px] text-muted-foreground">{pct}%</span>
    </div>
  )
}
