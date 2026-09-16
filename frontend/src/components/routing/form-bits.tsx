import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import type { ReactNode } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"
import { useSaveObject } from "@/lib/save-object"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FormCombobox, FormSelect, useFieldErrors } from "@/components/forms"
import { cn } from "@/lib/utils"

// The pieces every routing form shares: the save mutation (plan-aware, like
// every other form), the small inline controls a rules table is made of, and
// the picker lists (prefix lists, community lists, …) rules choose from.

/** The app labels the routing forms save under - beside the helper, so the
 * plan-capable audit (save-object.test) finds every type next to the
 * useSaveObject call that writes it. */
export const ROUTING_OBJECT_TYPES = {
  prefixlist: "routing.prefixlist",
  community: "routing.community",
  communitylist: "routing.communitylist",
  aspathlist: "routing.aspathlist",
  routingpolicy: "routing.routingpolicy",
  routingkeychain: "routing.routingkeychain",
  bfdprofile: "routing.bfdprofile",
  staticroute: "routing.staticroute",
  bgpinstance: "routing.bgpinstance",
  bgpaddressfamily: "routing.bgpaddressfamily",
  bgppeergroup: "routing.bgppeergroup",
  bgpsession: "routing.bgpsession",
  ospfarea: "routing.ospfarea",
  ospfinstance: "routing.ospfinstance",
  ospfinterface: "routing.ospfinterface",
  isisinstance: "routing.isisinstance",
  isisinterface: "routing.isisinterface",
  eigrpinstance: "routing.eigrpinstance",
  eigrpinterface: "routing.eigrpinterface",
  vtep: "routing.vtep",
  vtepmembership: "routing.vtepmembership",
} as const

/** Save a routing object through the plan-aware helper; invalidates the
 * list cache the page reads. */
export function useRoutingSave<T extends { id: string }>({
  objectType,
  endpoint,
  queryKey,
  id,
  label,
  onSaved,
}: {
  /** "routing.prefixlist" */
  objectType: string
  endpoint: string
  queryKey: string
  id?: string
  label: (saved: T) => string
  onSaved: (saved: T) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      saveObject<T>({ objectType, endpoint, id, payload }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: [queryKey] })
      qc.invalidateQueries({ queryKey: [`${queryKey}-picker`] })
      toast.success(id ? `Updated ${label(saved)}` : `Created ${label(saved)}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })
  return { mutation, fieldErrors, reset }
}

/** The compact rows of a rules table: a number, a short text, a select. */
export function CellInput({
  value,
  onChange,
  type = "text",
  placeholder,
  mono,
  className,
  width,
}: {
  value: string
  onChange: (v: string) => void
  type?: "text" | "number"
  placeholder?: string
  mono?: boolean
  className?: string
  width?: string
}) {
  return (
    <Input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn("h-7 px-2 text-xs", mono && "font-mono", width, className)}
    />
  )
}

export function CellSelect({
  value,
  onChange,
  options,
  width = "w-24",
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  width?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("h-7 px-2 text-xs", width)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export const ACTIONS = [
  { value: "permit", label: "permit" },
  { value: "deny", label: "deny" },
]

/** "" ↔ null for the optional numbers a rule carries. */
export const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v))
export const numText = (v: number | null | undefined) =>
  v == null ? "" : String(v)

/** A rules editor: a header line, one editable row per rule (each cell
 * sized by the control in it), a remove button on each, and "Add rule" that
 * takes the next free sequence (last + 10). */
export function RulesTable<TRow extends { sequence: number }>({
  rows,
  onChange,
  headers,
  newRow,
  renderRow,
  addLabel = "Add rule",
  emptyText = "No rules yet.",
}: {
  rows: TRow[]
  onChange: (rows: TRow[]) => void
  headers: { label: string; width: string }[]
  newRow: (sequence: number) => TRow
  renderRow: (row: TRow, update: (patch: Partial<TRow>) => void) => ReactNode[]
  addLabel?: string
  emptyText?: string
}) {
  const update = (i: number, patch: Partial<TRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  const add = () => {
    const last = rows.reduce((m, r) => Math.max(m, r.sequence || 0), 0)
    onChange([...rows, newRow(last + 10)])
  }
  return (
    <div className="grid gap-2">
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <div className="flex gap-2 text-[11px] font-medium text-muted-foreground">
            {headers.map((h) => (
              <span
                key={h.label}
                className={cn(
                  !h.width.includes("flex-1") && "shrink-0",
                  h.width
                )}
              >
                {h.label}
              </span>
            ))}
          </div>
          <div className="mt-1 grid gap-1.5">
            {rows.map((row, i) => (
              <div key={i} className="flex items-start gap-2">
                {renderRow(row, (patch) => update(i, patch)).map((cell, j) => (
                  <div
                    key={j}
                    className={cn(
                      !headers[j]?.width.includes("flex-1") && "shrink-0",
                      headers[j]?.width
                    )}
                  >
                    {cell}
                  </div>
                ))}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => remove(i)}
                  aria-label="Remove rule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      )}
      <div>
        <Button type="button" size="sm" variant="outline" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> {addLabel}
        </Button>
      </div>
    </div>
  )
}

/** Compact option lists for the pickers inside a rule. */
/** The BFD pair every protocol form draws: on/off beside the timers it
 * runs with. `tri` gives an Inherit row (sessions, peer groups). */
export function BFDFields({
  on,
  onChange,
  profileId,
  onProfileChange,
  tri,
  inheritLabel = "Inherit",
  profileNoneLabel = "Platform default",
  errors,
}: {
  on: string | null
  onChange: (v: string | null) => void
  profileId: string | null
  onProfileChange: (v: string | null) => void
  tri?: boolean
  inheritLabel?: string
  profileNoneLabel?: string
  errors?: Record<string, string | undefined>
}) {
  const profiles = usePickList<{ id: string; name: string }>(
    "bfd-profiles",
    "/api/routing/bfd-profiles/",
    (p) => p.name
  )
  return (
    <div className="grid gap-3 @md:grid-cols-3">
      <FormSelect
        label="BFD"
        value={on}
        onChange={onChange}
        options={[
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ]}
        noneLabel={tri ? inheritLabel : undefined}
        error={errors?.bfd}
      />
      {on !== "off" && (
        <FormCombobox
          label="BFD profile"
          value={profileId}
          onChange={onProfileChange}
          options={profiles.map((p) => ({ value: p.id, label: p.label }))}
          noneLabel={profileNoneLabel}
          placeholder={profileNoneLabel}
          emptyText="No profiles - add one under Routing → BFD profiles."
          info="The timers BFD runs with; a profile is named once under Routing → BFD profiles."
          error={errors?.bfd_profile_id}
        />
      )}
    </div>
  )
}

export function usePickList<T extends { id: string }>(
  key: string,
  endpoint: string,
  label: (row: T) => string
) {
  const q = useQuery({
    queryKey: [`${key}-picker`],
    queryFn: () => api<Paginated<T>>(`${endpoint}?picker=1&page_size=500`),
    staleTime: 60_000,
  })
  return (q.data?.results ?? []).map((r) => ({ id: r.id, label: label(r) }))
}
