import { useMemo, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { ApiError, saveDinRails } from "@/lib/api"
import type {
  CabinetSizes,
  DinProfile,
  DinRail,
  DinRailKey,
  DinRailWrite,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { invalidateCabinetViews, plateSize } from "@/lib/cabinets"
import {
  DIN_PROFILES,
  PROFILE_LABELS,
  hasRailErrors,
  newRail,
  parseRailDraft,
  railErrors,
} from "@/lib/din-geometry"
import type {
  RailDraft,
  RailErrors,
  RailField,
  RailGeometry,
} from "@/lib/din-geometry"
import { invalidateObjectQueries } from "@/lib/save-object"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CabinetElevation } from "@/components/cabinet-elevation"
import type { ElevationRail } from "@/components/cabinet-elevation"

// The rail builder (#277), for a cabinet's rails and a cabinet type's rail
// templates alike: one row per rail beside the plate drawn to scale, where a
// rail can also be dragged or nudged. The server's rules run as you type
// (lib/din-geometry.ts), and Save writes the whole set at once - kept rails
// by id, new ones without, and any left out removed.

export interface DinRailEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The parent's detail endpoint: `/api/cabinets/<id>/` or
   * `/api/cabinet-types/<id>/`. */
  endpoint: string
  /** Where the parent keeps its rails: `rails` on a cabinet, `rail_templates`
   * on a cabinet type. */
  railKey: DinRailKey
  title: string
  /** The plate the rails sit on, and the box around it. */
  sizes: CabinetSizes
  rails: DinRail[]
}

/** A rail as the editor holds it. */
interface RailRow extends RailDraft {
  /** The rail's id, or a local key for a rail not saved yet. */
  key: string
  /** The saved rail this row edits; absent on a new rail. */
  id?: string
}

/** The order a row's messages read in, left to right like its inputs. */
const FIELD_ORDER: RailField[] = [
  "label",
  "profile",
  "x_mm",
  "y_mm",
  "length_mm",
  "id",
]

const GRID =
  "grid grid-cols-[minmax(5rem,1fr)_6.5rem_6rem_6.5rem_6rem_2rem] items-center gap-x-2"

export function DinRailEditor(props: DinRailEditorProps) {
  // Mounted per opening, so each one starts from the rails as they are.
  if (!props.open) return null
  return <RailEditorDialog {...props} />
}

function RailEditorDialog({
  onOpenChange,
  endpoint,
  railKey,
  title,
  sizes,
  rails,
}: DinRailEditorProps) {
  const qc = useQueryClient()
  const width = sizes.inner_width_mm
  const height = sizes.inner_height_mm
  const [rows, setRows] = useState<RailRow[]>(() => rails.map(toRow))
  const [initial] = useState(() => JSON.stringify(writeBody(rails.map(toRow))))
  const [selected, setSelected] = useState<string | null>(null)
  // The server's answer to the last save: per rail, keyed by the row it was
  // sent as, and about the set as a whole.
  const [serverErrors, setServerErrors] = useState<Record<string, RailErrors>>(
    {}
  )
  const [general, setGeneral] = useState<string[]>([])
  const sentKeys = useRef<string[]>([])
  const nextKey = useRef(0)

  const save = useMutation({
    mutationFn: (body: DinRailWrite[]) =>
      saveDinRails<{ id: string }>(endpoint, railKey, body),
    onSuccess: (saved) => {
      invalidateCabinetViews(qc)
      invalidateObjectQueries(qc, saved.id)
      toast.success("Rails saved")
      onOpenChange(false)
    },
    onError: (err) => {
      const answer = readServerErrors(err, railKey, sentKeys.current)
      setServerErrors(answer.byRow)
      setGeneral(answer.general)
      if (!answer.mapped) apiErrorToast(err)
    },
  })

  // The serializer's checks per rail, then the set's own rules over the
  // rails whose fields are fine - the order the server runs them in.
  const parsed = useMemo(() => rows.map(parseRailDraft), [rows])
  const clientErrors = useMemo(() => {
    const errors = parsed.map((p) => ({ ...p.errors }))
    const fine = parsed.flatMap((p, i) =>
      p.rail && !hasRailErrors(p.errors) ? [{ i, rail: p.rail }] : []
    )
    railErrors(
      fine.map((f) => f.rail),
      width,
      height
    ).forEach((e, j) => mergeInto(errors[fine[j].i], e))
    return errors
  }, [parsed, width, height])
  const rowErrors = rows.map((r, i) => {
    const merged: RailErrors = { ...clientErrors[i] }
    const fromServer = serverErrors[r.key] as RailErrors | undefined
    if (fromServer) mergeInto(merged, fromServer)
    return merged
  })
  const blocked = clientErrors.some(hasRailErrors)

  const drawn: ElevationRail[] = rows.flatMap((r, i) => {
    const rail = parsed[i].rail
    return rail
      ? [{ key: r.key, ...rail, invalid: hasRailErrors(rowErrors[i]) }]
      : []
  })

  const close = () => {
    if (!save.isPending) onOpenChange(false)
  }

  const update = (key: string, patch: Partial<RailDraft>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    setServerErrors((s) => without(s, key))
  }

  const remove = (key: string) => {
    setRows((rs) => rs.filter((r) => r.key !== key))
    setServerErrors((s) => without(s, key))
    if (selected === key) setSelected(null)
  }

  const add = () => {
    const placed = newRail(
      parsed.flatMap((p) => (p.rail ? [p.rail] : [])),
      width,
      height,
      { labels: rows.map((r) => r.label) }
    )
    nextKey.current += 1
    const key = `new-${nextKey.current}`
    setRows((rs) => [...rs, { key, ...draftOf(placed) }])
    setSelected(key)
  }

  const submit = () => {
    if (blocked || save.isPending) return
    const body = writeBody(rows)
    // Nothing changed: nothing to write, and nothing for the change log.
    if (JSON.stringify(body) === initial) {
      onOpenChange(false)
      return
    }
    sentKeys.current = rows.map((r) => r.key)
    setGeneral([])
    save.mutate(body)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent size="5xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="num">
            Plate {plateSize(sizes)}
          </DialogDescription>
        </DialogHeader>

        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="grid gap-6"
        >
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="grid min-w-0 content-start gap-2">
              {general.length > 0 && (
                <div className="grid gap-0.5" data-testid="rail-set-errors">
                  {general.map((m) => (
                    <p key={m} className="text-[11px] text-destructive">
                      {m}
                    </p>
                  ))}
                </div>
              )}

              {rows.length > 0 ? (
                <div className="overflow-x-auto">
                  <div
                    className={cn(
                      GRID,
                      "px-1.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground"
                    )}
                  >
                    <span>Label</span>
                    <span>Profile</span>
                    <span>Left end (mm)</span>
                    <span>Centreline (mm)</span>
                    <span>Length (mm)</span>
                    <span />
                  </div>
                  <div className="mt-1 grid gap-1">
                    {rows.map((row, i) => (
                      <RailRowEditor
                        key={row.key}
                        row={row}
                        n={i + 1}
                        errors={rowErrors[i]}
                        selected={selected === row.key}
                        onSelect={() => setSelected(row.key)}
                        onChange={(patch) => update(row.key, patch)}
                        onRemove={() => remove(row.key)}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No rails yet.</p>
              )}

              <div>
                <Button type="button" size="sm" variant="outline" onClick={add}>
                  <Plus className="h-3.5 w-3.5" /> Add rail
                </Button>
              </div>
            </div>

            <div className="order-first min-w-0 lg:order-none">
              <div className="rounded-lg border border-border bg-card p-3">
                <CabinetElevation
                  width={width}
                  height={height}
                  outerWidth={sizes.outer_width_mm}
                  outerHeight={sizes.outer_height_mm}
                  rails={drawn}
                  selected={selected}
                  onSelect={setSelected}
                  onMove={(key, at) =>
                    update(key, {
                      x_mm: String(at.x_mm),
                      y_mm: String(at.y_mm),
                    })
                  }
                  className="max-h-[60vh]"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={close}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={blocked || save.isPending}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** One rail's inputs, with its messages under them. */
function RailRowEditor({
  row,
  n,
  errors,
  selected,
  onSelect,
  onChange,
  onRemove,
}: {
  row: RailRow
  /** The row's place in the list, for the inputs' names. */
  n: number
  errors: RailErrors
  selected: boolean
  onSelect: () => void
  onChange: (patch: Partial<RailDraft>) => void
  onRemove: () => void
}) {
  const invalid = (f: RailField) => (errors[f]?.length ? true : undefined)
  const messages = [...new Set(FIELD_ORDER.flatMap((f) => errors[f] ?? []))]
  const number = (f: "x_mm" | "y_mm" | "length_mm", name: string) => (
    <Input
      type="number"
      inputMode="decimal"
      step="0.1"
      aria-label={`Rail ${n} ${name}`}
      aria-invalid={invalid(f)}
      value={row[f]}
      onChange={(e) => onChange({ [f]: e.target.value })}
      className="num h-8"
    />
  )
  return (
    <div
      data-row={row.key}
      data-selected={selected || undefined}
      className={cn("rounded-md px-1.5 py-1", selected && "bg-muted/60")}
      onFocus={onSelect}
    >
      <div className={GRID}>
        <Input
          aria-label={`Rail ${n} label`}
          aria-invalid={invalid("label")}
          value={row.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="h-8"
        />
        <Select
          value={row.profile}
          onValueChange={(v) => onChange({ profile: v as DinProfile })}
        >
          <SelectTrigger size="sm" aria-label={`Rail ${n} profile`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIN_PROFILES.map((p) => (
              <SelectItem key={p} value={p}>
                {PROFILE_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {number("x_mm", "left end")}
        {number("y_mm", "centreline")}
        {number("length_mm", "length")}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove rail ${n}`}
          onClick={onRemove}
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {messages.length > 0 && (
        <div className="mt-1 grid gap-0.5">
          {messages.map((m) => (
            <p key={m} className="text-[11px] text-destructive">
              {m}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function toRow(r: DinRail): RailRow {
  return {
    key: r.id,
    id: r.id,
    label: r.label,
    profile: r.profile,
    x_mm: String(r.x_mm),
    y_mm: String(r.y_mm),
    length_mm: String(r.length_mm),
  }
}

function draftOf(r: RailGeometry): RailDraft {
  return {
    label: r.label,
    profile: r.profile,
    x_mm: String(r.x_mm),
    y_mm: String(r.y_mm),
    length_mm: String(r.length_mm),
  }
}

/** The set as the PATCH sends it: a kept rail with its id, a new one
 * without. */
function writeBody(rows: RailRow[]): DinRailWrite[] {
  return rows.map((r) => ({
    ...(r.id ? { id: r.id } : {}),
    label: r.label.trim(),
    profile: r.profile,
    x_mm: Number(r.x_mm),
    y_mm: Number(r.y_mm),
    length_mm: Number(r.length_mm),
  }))
}

function mergeInto(into: RailErrors, from: RailErrors) {
  for (const f of Object.keys(from) as RailField[]) {
    const add = from[f] ?? []
    if (add.length) into[f] = [...new Set([...(into[f] ?? []), ...add])]
  }
}

function without<T>(o: Record<string, T>, key: string): Record<string, T> {
  if (!(key in o)) return o
  const next = { ...o }
  delete next[key]
  return next
}

const messagesIn = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(messagesIn)
      : v && typeof v === "object"
        ? Object.values(v).flatMap(messagesIn)
        : []

/** A refused save, mapped back. Per-rail items land on the rows they were
 * sent as, by position; a plain message in the list (a rail that still
 * carries devices), a plate size and a `detail` are about the set, and go
 * above the rows. `mapped` is false for an answer of any other shape. */
function readServerErrors(
  err: unknown,
  key: DinRailKey,
  sentKeys: string[]
): { byRow: Record<string, RailErrors>; general: string[]; mapped: boolean } {
  const byRow: Record<string, RailErrors> = {}
  const general: string[] = []
  const body = err instanceof ApiError ? err.body : null
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { byRow, general, mapped: false }
  for (const [field, value] of Object.entries(body)) {
    if (field === key && Array.isArray(value)) {
      value.forEach((item: unknown, i) => {
        const rowKey = sentKeys[i] as string | undefined
        if (typeof item === "string") general.push(item)
        else if (item && typeof item === "object" && rowKey)
          byRow[rowKey] = item
      })
    } else {
      general.push(...messagesIn(value))
    }
  }
  return {
    byRow,
    general: [...new Set(general)],
    mapped: general.length > 0 || Object.values(byRow).some(hasRailErrors),
  }
}
