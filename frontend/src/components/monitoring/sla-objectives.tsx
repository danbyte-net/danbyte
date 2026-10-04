import { Plus, X } from "lucide-react"

import type { SlaObjective, SlaObjectiveFigure } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SLA_STATE_LABEL, SlaFigureBadge } from "./sla-figure"

// Latency objectives (monitoring/sla_objectives.py): "99 % of ICMP probes
// answered within 20 ms". Thresholds are the rollup histogram's edges.

export const LATENCY_EDGES = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000,
] as const
const KINDS = ["icmp", "tcp", "udp", "http", "ssh", "snmp", "telnet"]

/** One row per objective: kind, within, target. */
export function ObjectivesEditor({
  value,
  onChange,
}: {
  value: SlaObjective[]
  onChange: (v: SlaObjective[]) => void
}) {
  const set = (i: number, patch: Partial<SlaObjective>) =>
    onChange(value.map((o, j) => (j === i ? { ...o, ...patch } : o)))
  return (
    <div className="grid gap-1.5 text-[13px]">
      {value.map((o, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Select value={o.kind} onValueChange={(v) => set(i, { kind: v })}>
            <SelectTrigger className="h-8 w-24" aria-label="Check kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  <span className="font-mono text-[11px] uppercase">{k}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">within</span>
          <Select
            value={String(o.threshold_ms)}
            onValueChange={(v) => set(i, { threshold_ms: Number(v) })}
          >
            <SelectTrigger className="h-8 w-24" aria-label="Within">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LATENCY_EDGES.map((e) => (
                <SelectItem key={e} value={String(e)}>
                  {e} ms
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">for</span>
          <Input
            type="number"
            inputMode="decimal"
            step="0.1"
            min={0}
            max={100}
            className="h-8 w-20"
            value={o.target_pct}
            onChange={(e) => set(i, { target_pct: Number(e.target.value) })}
            aria-label="Target share of probes"
          />
          <span className="text-muted-foreground">% of probes</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label="Remove objective"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {value.length < 8 && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange([
                ...value,
                { kind: "icmp", threshold_ms: 20, target_pct: 99 },
              ])
            }
          >
            <Plus className="h-3.5 w-3.5" /> Add objective
          </Button>
        </div>
      )}
    </div>
  )
}

/** Each objective's figure: the share within, its target, the budget. */
export function ObjectiveCards({
  objectives,
}: {
  objectives: SlaObjectiveFigure[] | null | undefined
}) {
  if (!objectives?.length) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {objectives.map((o) => (
        <div
          key={`${o.kind}-${o.threshold_ms}`}
          className="space-y-1.5 rounded-lg border border-border bg-card p-3"
        >
          <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            <span className="font-mono">{o.kind}</span> within {o.threshold_ms}{" "}
            ms
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <SlaFigureBadge
              figures={{ availability: o.pct, state: o.state, coverage: null }}
            />
            <span className="text-muted-foreground">
              of {o.target_pct}% · {SLA_STATE_LABEL[o.state]}
            </span>
          </div>
          <p className="num text-[11px] text-muted-foreground">
            {o.probes
              ? `${o.slow.toLocaleString()} of ${o.budget_probes.toLocaleString()} slow probes allowed · ${o.budget_spent_pct}% spent`
              : "No probes with a latency yet"}
          </p>
        </div>
      ))}
    </div>
  )
}
