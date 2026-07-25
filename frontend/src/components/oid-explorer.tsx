import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { ChevronRight, CornerLeftUp, Search } from "lucide-react"

import { api } from "@/lib/api"
import type { OidWalkColumn, OidWalkResult } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox, FormText } from "@/components/forms"
import { apiErrorToast } from "@/lib/api-toast"
import { cn } from "@/lib/utils"

/** Bases worth trying first — the standard tables every agent has, then the
 * root of the vendor space, so the field is never a blank prompt. */
const COMMON_BASES = [
  "1.3.6.1.2.1.25.3.2.1", // hrDeviceTable — kind/status/descr per device
  "1.3.6.1.2.1.25.2.3.1", // hrStorageTable — size/used per volume
  "1.3.6.1.2.1.99.1.1.1", // entPhySensorTable — value/type/status
  "1.3.6.1.2.1.47.1.1.1.1", // entPhysicalTable — names/serials/models
  "1.3.6.1.4.1", // enterprises — browse down into the vendor's own tree
]

/**
 * Browse a device's OID tree and pick the column that holds health.
 *
 * SNMP has no standard hardware-health MIB, so a sensor's OID normally comes
 * from reading a vendor MIB file. This replaces that: descend the tree a level
 * at a time, and when you reach a table it's shown transposed — the column
 * reading "Normal" beside the column reading "Power Supply 1" is the health
 * column, and the values it returned are the value map to write.
 */
export function OidExplorer({
  deviceId,
  open,
  onOpenChange,
  onPickColumn,
}: {
  deviceId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Chosen column → build a sensor from it (full OID + the values it returned). */
  onPickColumn: (oid: string, values: string[]) => void
}) {
  const [oid, setOid] = useState("")
  const [walk, setWalk] = useState(true)
  const [result, setResult] = useState<OidWalkResult | null>(null)

  const run = useMutation({
    mutationFn: (base: string) =>
      api<OidWalkResult>(`/api/monitoring/devices/${deviceId}/oid-walk/`, {
        method: "POST",
        body: JSON.stringify({ oid: base, walk }),
      }),
    onSuccess: (r) => setResult(r),
    onError: (e) => apiErrorToast(e),
  })

  const go = (base: string) => {
    setOid(base)
    setResult(null)
    run.mutate(base)
  }

  const shown = result?.base ?? ""
  const parent = shown.includes(".")
    ? shown.slice(0, shown.lastIndexOf("."))
    : ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="3xl">
        <DialogHeader>
          <DialogTitle>Explore OIDs</DialogTitle>
        </DialogHeader>
        <p className="text-[13px] text-muted-foreground">
          Walk down this device's OID tree and pick the column that reports
          health. Its values become the sensor's value map, so you never have to
          read a vendor MIB to find the right OID.
        </p>

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (oid.trim()) go(oid.trim())
          }}
        >
          <div className="min-w-0 flex-1">
            <FormText
              label="OID"
              value={oid}
              onChange={setOid}
              mono
              placeholder="1.3.6.1.4.1"
              suggestions={COMMON_BASES}
            />
          </div>
          <Button type="submit" disabled={!oid.trim() || run.isPending}>
            <Search className="h-3.5 w-3.5" />
            {run.isPending ? "Reading..." : "Go"}
          </Button>
        </form>
        <FormCheckbox
          label="Explore the subtree"
          hint="off = read this one OID as a single value"
          checked={walk}
          onChange={setWalk}
        />

        {result?.error && (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-[13px] text-muted-foreground">
            {result.error}
          </p>
        )}

        {result && !result.error && (
          <>
            {parent && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => go(parent)}
                  disabled={run.isPending}
                >
                  <CornerLeftUp className="h-3.5 w-3.5" /> Up
                </Button>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {result.base}
                </span>
              </div>
            )}

            {result.is_table && result.rows.length > 0 ? (
              <WalkTable result={result} onPickColumn={onPickColumn} />
            ) : result.children.length > 0 ? (
              <BranchList
                children_={result.children}
                onDescend={go}
                busy={run.isPending}
              />
            ) : (
              <p className="text-[13px] text-muted-foreground">
                Nothing under that OID — the agent has no such table, or the
                community can't see it.
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** A branch: one row per child, with the first value found beneath it as a hint
 * at what's down there. Clicking descends. */
function BranchList({
  children_,
  onDescend,
  busy,
}: {
  children_: OidWalkResult["children"]
  onDescend: (oid: string) => void
  busy: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-muted-foreground">
        {children_.length} branch{children_.length === 1 ? "" : "es"} — open one
        to go deeper. A table shows itself as a grid when you reach it.
      </p>
      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {children_.map((c) => (
          <button
            key={c.sub}
            type="button"
            disabled={busy}
            onClick={() => onDescend(c.oid)}
            className="flex w-full items-center gap-2 border-b border-border px-2 py-1.5 text-left text-[12px] last:border-0 hover:bg-muted/60 disabled:opacity-50"
          >
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-mono">.{c.sub}</span>
            {c.sample && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {c.sample}
              </span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {c.depth_below === 1 ? "leaf" : `${c.depth_below} levels`}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function WalkTable({
  result,
  onPickColumn,
}: {
  result: OidWalkResult
  onPickColumn: (oid: string, values: string[]) => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = result.columns.find((c) => c.column === picked)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          {result.rows.length} rows · {result.columns.length} columns
        </span>
        {result.truncated && (
          <Badge variant="warning" className="h-4 px-1.5 text-[10px]">
            truncated — narrow the OID
          </Badge>
        )}
        <span className="ml-auto">Click a column to use it</span>
      </div>

      {/* Wide tables scroll inside their own box rather than stretching the
          dialog — a 20-column entPhysicalTable is normal. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                Row
              </th>
              {result.columns.map((c) => (
                <th key={c.column} className="px-1 py-1">
                  <button
                    type="button"
                    onClick={() => setPicked(c.column)}
                    title={c.oid}
                    className={cn(
                      "w-full rounded px-1.5 py-1 text-left font-mono text-[11px] hover:bg-muted",
                      picked === c.column && "bg-primary/10 text-foreground"
                    )}
                  >
                    .{c.column}
                    <span className="block font-sans text-[10px] text-muted-foreground">
                      {describeColumn(c, result.rows.length)}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr
                key={r.index}
                className="border-b border-border last:border-0"
              >
                <td className="px-2 py-1 font-mono text-muted-foreground">
                  {r.index}
                </td>
                {result.columns.map((c) => (
                  <td
                    key={c.column}
                    className={cn(
                      "px-2 py-1",
                      picked === c.column && "bg-primary/10"
                    )}
                  >
                    {r.values[c.column] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {chosen && (
        <div className="flex items-center gap-2 rounded-md border border-border p-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[12px]">{chosen.oid}</p>
            <p className="text-[11px] text-muted-foreground">
              {chosen.filled} of {result.rows.length} rows ·{" "}
              {chosen.values_seen === 1
                ? "one distinct value"
                : `${chosen.values_seen} distinct values`}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => onPickColumn(chosen.oid, chosen.distinct)}
          >
            Create sensor
          </Button>
        </div>
      )}
    </div>
  )
}

/** A one-line read on what a column probably is, from its own values. Enough
 * to spot the health column without guessing at the MIB. */
function describeColumn(c: OidWalkColumn, rows: number): string {
  if (c.values_seen === 0) return "empty"
  if (c.values_seen === 1) return `all "${c.distinct[0]}"`
  if (c.values_seen >= rows) return "unique per row"
  return `${c.values_seen} values`
}
