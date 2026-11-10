import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"

import { api  } from "@/lib/api"
import type {Status} from "@/lib/api";
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { parseSize, scopeError } from "@/lib/prefix-free"
import { useSiteOptions } from "@/lib/use-site-options"
import { DataTable } from "@/components/data-table"
import {
  FormCheckbox,
  FormCombobox,
  FormSelect,
  FormStatusSelect,
  FormText,
} from "@/components/forms"
import { FREE_FILL, USED_FILL } from "@/components/space-map"
import { VlanPicker } from "@/components/vlan-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

// POST /api/prefixes/<id>/plan/ (api/prefix_space.py describe_plan).
export interface PlanItem {
  request: number
  n: number
  length: number
  cidr: string | null
  description: string
  reason: string | null
}
export interface PlanPreview {
  parent: { id: string; cidr: string }
  scope: string
  strategy: "first" | "best"
  dry_run: boolean
  applied: boolean
  fits: boolean
  items: PlanItem[]
  reserved: string[]
  strip: {
    root: string
    used: [number, number][]
    planned: [number, number][]
    reserved: [number, number][]
  }
  created: { id: string; cidr: string }[]
}

interface Row {
  key: number
  count: string
  size: string
  description: string
  statusId: string | null
  vlanId: string | null
  siteId: string | null
  together: boolean
}

let nextKey = 1
const blankRow = (): Row => ({
  key: nextKey++,
  count: "1",
  size: "",
  description: "",
  statusId: null,
  vlanId: null,
  siteId: null,
  together: false,
})

/** Why a planner row can't be sent, or null. */
function planRowError(r: Row): string | null {
  const n = Number(r.count)
  if (!Number.isInteger(n) || n < 1) return "Count from 1."
  if (parseSize(r.size) === null) return "Size, e.g. /24."
  return null
}

/** The request body rows. */
function planRequests(rows: Row[]) {
  return rows.map((r) => ({
    count: Number(r.count),
    length: parseSize(r.size),
    ...(r.description.trim() ? { description: r.description.trim() } : {}),
    ...(r.statusId ? { status_id: r.statusId } : {}),
    ...(r.vlanId ? { vlan_id: r.vlanId } : {}),
    ...(r.siteId ? { site_id: r.siteId } : {}),
    ...(r.together ? { keep_together: true } : {}),
  }))
}

/** Where a plan lands in the parent: the Space map's free and used fills,
 * the proposed blocks outlined over them. */
export function PlanStrip({ strip }: { strip: PlanPreview["strip"] }) {
  const pct = (f: number) => `${f * 100}%`
  return (
    <div className="space-y-1">
      <div
        className={cn(
          "relative h-7 overflow-hidden rounded-md ring-1 ring-emerald-300 ring-inset dark:ring-emerald-900",
          FREE_FILL
        )}
        aria-label={`Placement in ${strip.root}`}
        role="img"
      >
        {strip.used.map(([a, b], i) => (
          <span
            key={`u${i}`}
            data-slot="used"
            className={cn("absolute inset-y-0", USED_FILL)}
            style={{ left: pct(a), width: pct(b - a), minWidth: 1 }}
          />
        ))}
        {strip.reserved.map(([a, b], i) => (
          <span
            key={`r${i}`}
            data-slot="reserved"
            className="absolute inset-y-0 border border-dashed border-primary/60"
            style={{ left: pct(a), width: pct(b - a), minWidth: 2 }}
          />
        ))}
        {strip.planned.map(([a, b], i) => (
          <span
            key={`p${i}`}
            data-slot="planned"
            className="absolute inset-y-0 bg-primary/25 ring-2 ring-primary ring-inset"
            style={{ left: pct(a), width: pct(b - a), minWidth: 3 }}
          />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{strip.root}</span>
      </div>
    </div>
  )
}

type Shown = PlanItem & { row: string }

export function PrefixPlanDialog({
  prefix,
  scope: initialScope = "",
  onOpenChange,
}: {
  prefix: { id: string; cidr: string }
  scope?: string
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<Row[]>(() => [blankRow()])
  const [scope, setScope] = useState(initialScope)
  const [strategy, setStrategy] = useState<"first" | "best">("first")
  const [growth, setGrowth] = useState(false)
  const [preview, setPreview] = useState<PlanPreview | null>(null)
  const [sent, setSent] = useState("")
  const [confirming, setConfirming] = useState(false)

  const statuses = useQuery({
    queryKey: ["statuses", "prefix"],
    queryFn: () =>
      apiAll<Status>("/api/statuses/?available_to=prefix&picker=1"),
    staleTime: 5 * 60_000,
  })
  const sites = useSiteOptions()

  const rowErrors = rows.map(planRowError)
  const scopeErr = scopeError(scope)
  const body = {
    requests: planRequests(rows),
    strategy,
    reserve_growth: growth,
    ...(scope.trim() ? { scope: scope.trim() } : {}),
  }
  const signature = JSON.stringify(body)
  const ready = rowErrors.every((e) => e === null) && !scopeErr

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<PlanPreview>(`/api/prefixes/${prefix.id}/plan/`, {
        method: "POST",
        body: JSON.stringify({
          ...body,
          dry_run: dryRun,
          ...(dryRun ? {} : { cidrs: preview?.items.map((i) => i.cidr) }),
        }),
      }),
    onSuccess: (data) => {
      if (!data.applied) {
        setPreview(data)
        setSent(signature)
        return
      }
      toast.success(
        `Created ${data.created.length} prefix${data.created.length === 1 ? "" : "es"} in ${data.parent.cidr}`
      )
      qc.invalidateQueries({ queryKey: ["prefixes"] })
      qc.invalidateQueries({ queryKey: ["prefix"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      setConfirming(false)
      onOpenChange(false)
    },
    onError: (err) => {
      setConfirming(false)
      apiErrorToast(err)
    },
  })

  // The preview belongs to the rows it was asked with; an edit drops it.
  const current = preview && sent === signature ? preview : null

  const shown = useMemo<Shown[]>(
    () =>
      (current?.items ?? []).map((it) => {
        const r = current!.items.filter((x) => x.request === it.request)
        return { ...it, row: `${r.length} × /${it.length}` }
      }),
    [current]
  )
  const columns = useMemo<ColumnDef<Shown, unknown>[]>(
    () => [
      { id: "row", accessorKey: "row", header: "Row" },
      {
        id: "cidr",
        accessorKey: "cidr",
        header: "Prefix",
        cell: ({ row }) =>
          row.original.cidr ? (
            <span className="font-mono text-xs">{row.original.cidr}</span>
          ) : (
            <span className="text-xs text-muted-foreground">-</span>
          ),
      },
      { id: "description", accessorKey: "description", header: "Description" },
      {
        id: "result",
        header: "Result",
        accessorFn: (r) => r.reason ?? "Fits",
        cell: ({ row }) =>
          row.original.cidr ? (
            <Badge variant="success">Fits</Badge>
          ) : (
            <span className="inline-flex items-center gap-2 text-xs">
              <Badge variant="destructive">No room</Badge>
              <span className="text-muted-foreground">
                {row.original.reason}
              </span>
            </span>
          ),
      },
    ],
    []
  )

  const update = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const placed = current?.items.filter((i) => i.cidr).length ?? 0

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="4xl">
        <DialogHeader>
          <DialogTitle>Plan subnets in {prefix.cidr}</DialogTitle>
        </DialogHeader>
        <div className="-mr-2 max-h-[70vh] space-y-4 overflow-y-auto pr-2">
          <div className="space-y-3">
            {rows.map((r, i) => (
              <div key={r.key} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="Count"
                    value={r.count}
                    onChange={(e) => update(r.key, { count: e.target.value })}
                    inputMode="numeric"
                    className="h-8 w-16 text-right"
                  />
                  <span className="text-muted-foreground">×</span>
                  <Input
                    aria-label="Size"
                    value={r.size}
                    onChange={(e) => update(r.key, { size: e.target.value })}
                    placeholder="/24"
                    autoFocus={i === 0}
                    className="h-8 w-20 font-mono"
                  />
                  <Input
                    aria-label="Description"
                    value={r.description}
                    onChange={(e) =>
                      update(r.key, { description: e.target.value })
                    }
                    placeholder="servers-{n}"
                    className="h-8 min-w-40 flex-1"
                  />
                  <label className="flex items-center gap-2 text-xs whitespace-nowrap">
                    <Checkbox
                      checked={r.together}
                      onCheckedChange={(v) => update(r.key, { together: !!v })}
                    />
                    Keep together
                  </label>
                  {rows.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="Remove row"
                      onClick={() =>
                        setRows((rs) => rs.filter((x) => x.key !== r.key))
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <FormStatusSelect
                    value={r.statusId}
                    onChange={(v) => update(r.key, { statusId: v })}
                    options={statuses.data?.results ?? []}
                  />
                  <VlanPicker
                    value={r.vlanId}
                    onChange={(v) => update(r.key, { vlanId: v })}
                    noneLabel="No VLAN"
                    placeholder="No VLAN"
                  />
                  <FormCombobox
                    label="Site"
                    value={r.siteId}
                    onChange={(v) => update(r.key, { siteId: v })}
                    noneLabel="Parent's site"
                    placeholder="Parent's site"
                    options={sites.options.map((s) => ({
                      value: s.id,
                      label: s.name,
                    }))}
                    searchPlaceholder="Search sites…"
                    emptyText="No sites."
                  />
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRows((rs) => [...rs, blankRow()])}
            >
              <Plus className="h-3.5 w-3.5" /> Add row
            </Button>
          </div>

          <div className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto_auto]">
            <FormText
              label="Scope"
              hint="optional"
              value={scope}
              onChange={setScope}
              placeholder={prefix.cidr}
              mono
              error={scopeErr ?? undefined}
            />
            <FormSelect
              label="Order"
              value={strategy}
              onChange={(v) => setStrategy(v === "best" ? "best" : "first")}
              options={[
                { value: "first", label: "Lowest address first" },
                { value: "best", label: "Best fit" },
              ]}
            />
            <FormCheckbox
              label="Leave room to grow"
              checked={growth}
              onChange={setGrowth}
            />
            <Button
              variant="outline"
              disabled={!ready || run.isPending}
              onClick={() => run.mutate(true)}
            >
              {run.isPending && !confirming ? "Previewing…" : "Preview"}
            </Button>
          </div>

          {current && (
            <div className="space-y-3">
              <PlanStrip strip={current.strip} />
              <DataTable
                data={shown}
                columns={columns}
                tableId="prefix-plan-preview"
                embedded
                flexColumn="description"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!current || !current.fits || run.isPending}
            onClick={() => setConfirming(true)}
          >
            Create all
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog
        open={confirming}
        onOpenChange={(o) => !run.isPending && setConfirming(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Create {placed} prefix{placed === 1 ? "" : "es"} in {prefix.cidr}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              All or nothing, in one change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={run.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={run.isPending}
              onClick={(e) => {
                e.preventDefault()
                run.mutate(false)
              }}
            >
              {run.isPending ? "Creating…" : "Create all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
