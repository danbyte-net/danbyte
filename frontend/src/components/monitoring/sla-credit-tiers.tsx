import { Plus, X } from "lucide-react"

import type { SlaCredit, SlaCreditTier } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** One row per tier: below this availability, this share of the fee. */
export function CreditTiersEditor({
  value,
  onChange,
}: {
  value: SlaCreditTier[]
  onChange: (v: SlaCreditTier[]) => void
}) {
  const set = (i: number, patch: Partial<SlaCreditTier>) =>
    onChange(value.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  return (
    <div className="grid gap-1.5 text-[13px]">
      {value.map((t, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-12 text-muted-foreground">Below</span>
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min={0}
            max={100}
            className="h-8 w-24"
            value={t.below}
            onChange={(e) => set(i, { below: Number(e.target.value) })}
            aria-label="Below availability"
          />
          <span className="text-muted-foreground">%, credit</span>
          <Input
            type="number"
            inputMode="decimal"
            step="1"
            min={0}
            max={100}
            className="h-8 w-20"
            value={t.credit_pct}
            onChange={(e) => set(i, { credit_pct: Number(e.target.value) })}
            aria-label="Credit of the fee"
          />
          <span className="text-muted-foreground">%</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label="Remove tier"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {value.length < 10 && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange([
                ...value,
                {
                  below: value.length
                    ? Math.max(0, value[value.length - 1].below - 0.5)
                    : 99.9,
                  credit_pct: value.length
                    ? Math.min(100, value[value.length - 1].credit_pct + 10)
                    : 10,
                },
              ])
            }
          >
            <Plus className="h-3.5 w-3.5" /> Add tier
          </Button>
        </div>
      )}
    </div>
  )
}

/** "25 % · 250.00 DKK", or null when nothing is owed. */
export function fmtCredit(c: SlaCredit | null | undefined): string | null {
  if (!c || !c.pct) return null
  if (c.amount == null) return `${c.pct}%`
  const amount = c.amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${c.pct}% · ${amount} ${c.currency}`.trim()
}
