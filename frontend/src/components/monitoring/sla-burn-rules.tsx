import type { SlaBurnRule, SlaBurnState } from "@/lib/api"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"

// Multi-window burn-rate rules (monitoring/sla_burn.py): the form's editor,
// and the "burn now" readout on the agreement page.

export const DEFAULT_BURN_RULES: SlaBurnRule[] = [
  { name: "fast", long_min: 60, short_min: 5, burn: 14.4, on: true },
  { name: "slow", long_min: 360, short_min: 30, burn: 6, on: true },
]

const LONG = [30, 60, 120, 360, 720, 1440, 4320]
const SHORT = [1, 5, 10, 15, 30, 60, 120]

export function fmtWindow(min: number) {
  if (min % 1440 === 0) return `${min / 1440} d`
  if (min % 60 === 0) return `${min / 60} h`
  return `${min} min`
}

export function fmtBurn(b: number | null | undefined) {
  if (b == null) return "-"
  if (b >= 1e9) return "∞"
  return `${b >= 10 ? Math.round(b) : b.toFixed(1)}x`
}

const LABEL: Record<string, string> = { fast: "Fast", slow: "Slow" }

function WindowSelect({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: number
  options: number[]
  onChange: (v: number) => void
  disabled: boolean
  label: string
}) {
  const all = options.includes(value)
    ? options
    : [...options, value].sort((a, b) => a - b)
  return (
    <Select
      value={String(value)}
      onValueChange={(v) => onChange(Number(v))}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 w-24" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all.map((m) => (
          <SelectItem key={m} value={String(m)}>
            {fmtWindow(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** One row per rule: on, long window, short window, threshold. */
export function BurnRulesEditor({
  value,
  onChange,
}: {
  value: SlaBurnRule[]
  onChange: (v: SlaBurnRule[]) => void
}) {
  const set = (i: number, patch: Partial<SlaBurnRule>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="grid gap-1.5 text-[13px]">
      {value.map((r, i) => (
        <div key={r.name} className="flex flex-wrap items-center gap-2">
          <label className="flex w-16 items-center gap-2">
            <Checkbox
              checked={r.on}
              onCheckedChange={(v) => set(i, { on: v === true })}
            />
            {LABEL[r.name] ?? r.name}
          </label>
          <WindowSelect
            label={`${r.name} long window`}
            value={r.long_min}
            options={LONG}
            disabled={!r.on}
            onChange={(v) => set(i, { long_min: v })}
          />
          <span className="text-muted-foreground">and</span>
          <WindowSelect
            label={`${r.name} short window`}
            value={r.short_min}
            options={SHORT}
            disabled={!r.on}
            onChange={(v) => set(i, { short_min: v })}
          />
          <span className="text-muted-foreground">at</span>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.1"
            className="h-8 w-20"
            value={r.burn}
            disabled={!r.on}
            onChange={(e) => set(i, { burn: Number(e.target.value) })}
            aria-label={`${r.name} burn threshold`}
          />
          <span className="text-muted-foreground">x</span>
        </div>
      ))}
    </div>
  )
}

/** "Burn now": each rule's two windows, flagged while it fires. */
export function BurnNow({
  burn,
}: {
  burn: Record<string, SlaBurnState> | null | undefined
}) {
  const rules = Object.entries(burn ?? {})
  if (!rules.length) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
      <span className="text-[11px] font-medium tracking-wide uppercase">
        Burn now
      </span>
      {rules.map(([name, s]) => (
        <span key={name} className="num inline-flex items-center gap-1.5">
          {fmtWindow(s.long_min)}{" "}
          <span className="text-foreground">{fmtBurn(s.long)}</span>
          {" · "}
          {fmtWindow(s.short_min)}{" "}
          <span className="text-foreground">{fmtBurn(s.short)}</span>
          {s.firing && (
            <Badge variant={name === "fast" ? "destructive" : "warning"}>
              {LABEL[name] ?? name} burn
            </Badge>
          )}
        </span>
      ))}
    </div>
  )
}
