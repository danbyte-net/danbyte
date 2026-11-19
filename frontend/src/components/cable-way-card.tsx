import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import type {
  CableWay,
  CableWayHop,
  CableWayProposal,
  CableWaysDoc,
  ResolvedPathways,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useSaveObject } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"
import {
  hopOptions,
  hopUnits,
  lengthText,
  reasonText,
  wayChain,
} from "@/lib/cable-ways"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { IconTip } from "@/components/icon-tip"
import {
  FormCombobox,
  FormFooter,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

type RackRow = CableWaysDoc["racks"][number]

const END_LABEL = { A: "A", B: "B", AB: "A + B" } as const

export function waysKey(cableId: string) {
  return ["cable-ways", cableId]
}

/** What a rack row shows: its stored way, else the live proposal. */
function shown(r: RackRow): {
  way: Pick<CableWayProposal, "hops" | "exit"> | null
  length: number | null
  reasons: string[]
  state: "proposed" | "recorded" | "dismissed" | "stale" | "none"
} {
  const w = r.way
  if (w && w.state === "dismissed")
    return { way: null, length: null, reasons: [], state: "dismissed" }
  if (w && w.state === "recorded")
    return {
      way: w,
      length: w.length_mm,
      reasons: w.reasons,
      state: w.stale ? "stale" : "recorded",
    }
  const p = w ?? r.proposal
  if (!p) return { way: null, length: null, reasons: [], state: "none" }
  return {
    way: p,
    length: p.length_mm,
    reasons: p.reasons,
    state: "proposed",
  }
}

function StateBadge({ state }: { state: ReturnType<typeof shown>["state"] }) {
  if (state === "recorded") return <Badge variant="success">Recorded</Badge>
  if (state === "proposed") return <Badge variant="info">Proposed</Badge>
  if (state === "stale") return <Badge variant="warning">Out of date</Badge>
  if (state === "dismissed") return <Badge variant="secondary">Dismissed</Badge>
  return <Badge variant="outline">No pathways</Badge>
}

/**
 * The cable's way through each rack it is in (docs/dcim/racks.md → Cable
 * ways): the pathway hops as one chain, the length, and Accept / Change /
 * Dismiss for a proposal. Hidden without a grant on cable ways, and for a
 * cable with no end in a rack.
 */
export function CableWayCard({ cableId }: { cableId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canWrite = canDo("cableway", "add")
  const canChange = canDo("cableway", "change")
  const canDelete = canDo("cableway", "delete")
  const [editing, setEditing] = useState<RackRow | null>(null)

  const q = useQuery({
    queryKey: waysKey(cableId),
    queryFn: () =>
      api<CableWaysDoc>(`/api/cable-ways/summary/?cable=${cableId}`),
    enabled: canDo("cableway", "view"),
  })
  const done = () => {
    qc.invalidateQueries({ queryKey: waysKey(cableId) })
    qc.invalidateQueries({ queryKey: ["cable", cableId] })
    qc.invalidateQueries({ queryKey: ["rack-pathways"] })
  }
  const act = useMutation({
    mutationFn: ({
      verb,
      rackId,
    }: {
      verb: "accept" | "dismiss"
      rackId: string
    }) =>
      api<CableWay>(`/api/cable-ways/${verb}/`, {
        method: "POST",
        body: JSON.stringify({ cable_id: cableId, rack_id: rackId }),
      }),
    onSuccess: done,
    onError: (e) => apiErrorToast(e),
  })
  const reset = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/cable-ways/${id}/`, { method: "DELETE" }),
    onSuccess: done,
    onError: (e) => apiErrorToast(e),
  })

  if (!canDo("cableway", "view")) return null
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 403) return null
    return (
      <section className="rounded-lg border border-border p-4">
        <QueryError error={q.error} />
      </section>
    )
  }
  if (q.isLoading) return <Loading />
  const doc = q.data
  if (!doc || doc.racks.length === 0) return null
  const est = doc.length

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Way
        </h3>
        {est?.length_mm != null && (
          <span className="text-sm whitespace-nowrap text-muted-foreground">
            Estimated{" "}
            <span className="num text-foreground">
              {lengthText(est.length_mm)}
            </span>
          </span>
        )}
      </div>
      <ul className="mt-3 divide-y divide-border">
        {doc.racks.map((r) => {
          const s = shown(r)
          const stored = r.way
          const pending = act.isPending || reset.isPending
          return (
            <li
              key={r.rack.id}
              className="flex flex-wrap items-start gap-3 py-2"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/racks/$id"
                    params={{ id: r.rack.id }}
                    className="link text-sm font-medium whitespace-nowrap"
                  >
                    {r.rack.name}
                  </Link>
                  <Badge variant="outline">{END_LABEL[r.end]}</Badge>
                  <StateBadge state={s.state} />
                  {stored?.source === "auto" && s.state === "recorded" && (
                    <Badge variant="secondary">Automatic</Badge>
                  )}
                  {s.length != null && (
                    <span className="num text-sm text-muted-foreground">
                      {lengthText(s.length)}
                    </span>
                  )}
                  {stored && stored.state !== "dismissed" && (
                    <Link
                      to="/racks/$id"
                      params={{ id: r.rack.id }}
                      search={{ viz: "3d", cable: doc.cable_id }}
                      className="link text-sm whitespace-nowrap"
                    >
                      Show in rack
                    </Link>
                  )}
                </div>
                {s.way && (
                  <p className="text-sm">
                    {wayChain(r.ports[0] ?? "", s.way, {
                      tray: r.route?.tray,
                      farPort: r.ports[1],
                    })}
                  </p>
                )}
                {s.reasons.length > 0 && s.state === "proposed" && (
                  <div className="flex flex-wrap gap-1">
                    {s.reasons.map((code) => (
                      <Badge key={code} variant="secondary">
                        {reasonText(code)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                {s.state === "proposed" && canWrite && (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      act.mutate({ verb: "accept", rackId: r.rack.id })
                    }
                  >
                    Accept
                  </Button>
                )}
                {s.state !== "dismissed" &&
                  canWrite &&
                  (!stored || canChange) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => setEditing(r)}
                    >
                      Change
                    </Button>
                  )}
                {(s.state === "proposed" || s.state === "none") && canWrite && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      act.mutate({ verb: "dismiss", rackId: r.rack.id })
                    }
                  >
                    Dismiss
                  </Button>
                )}
                {stored && stored.state !== "proposed" && canDelete && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => reset.mutate(stored.id)}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <WayDialog
        cableId={cableId}
        row={editing}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={done}
      />
    </section>
  )
}

interface HopDraft {
  key: string | null
  enter_u: string
  leave_u: string
}

function draftOf(hops: CableWayHop[]): HopDraft[] {
  return hops.map((h) => ({
    key: h.key,
    enter_u: h.enter_u != null ? String(h.enter_u) : "",
    leave_u: h.leave_u != null ? String(h.leave_u) : "",
  }))
}

const RUNS = new Set(["vertical", "channel"])

/** Change a rack's way: its hops in order, each one of the rack's shown
 * pathways, with the units a vertical run enters and leaves at. */
function WayDialog({
  cableId,
  row,
  onOpenChange,
  onSaved,
}: {
  cableId: string
  row: RackRow | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [hops, setHops] = useState<HopDraft[]>([])
  const rackId = row?.rack.id
  const pathways = useQuery({
    queryKey: ["rack-pathways", rackId],
    queryFn: () =>
      api<ResolvedPathways>(`/api/rack-pathways/resolved/?rack=${rackId}`),
    enabled: !!rackId,
  })

  useEffect(() => {
    if (!row) return
    reset()
    const src =
      row.way && row.way.state !== "dismissed" ? row.way : row.proposal
    setHops(draftOf(src?.hops ?? []))
  }, [row, reset])

  const saveObject = useSaveObject()
  const save = useMutation({
    mutationFn: () => {
      const body = {
        hops: hops
          .filter((h) => h.key)
          .map((h) => ({
            key: h.key,
            enter_u: h.enter_u.trim() ? Number(h.enter_u) : null,
            leave_u: h.leave_u.trim() ? Number(h.leave_u) : null,
          })),
        state: "recorded",
      }
      const id = row?.way?.id
      return saveObject<CableWay>({
        objectType: "api.cableway",
        endpoint: "/api/cable-ways/",
        id,
        payload: id ? body : { ...body, cable_id: cableId, rack_id: rackId },
      })
    },
    onSuccess: () => {
      onSaved()
      onOpenChange(false)
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) apiErrorToast(e)
    },
  })

  const items = pathways.data?.items ?? []
  const options = hopOptions(items)
  const kindOf = (key: string | null) =>
    items.find((p) => p.key === key)?.kind ?? ""
  const set = (i: number, patch: Partial<HopDraft>) =>
    setHops(hops.map((h, j) => (j === i ? { ...h, ...patch } : h)))
  const move = (i: number, by: number) => {
    const j = i + by
    if (j < 0 || j >= hops.length) return
    const next = [...hops]
    ;[next[i], next[j]] = [next[j], next[i]]
    setHops(next)
  }

  return (
    <Dialog open={!!row} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Way in {row?.rack.name}</DialogTitle>
        </DialogHeader>
        {pathways.isLoading ? (
          <Loading />
        ) : pathways.isError ? (
          <QueryError error={pathways.error} />
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate()
            }}
          >
            {hops.map((h, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <FormCombobox
                    label={`Hop ${i + 1}`}
                    value={h.key}
                    onChange={(v) => set(i, { key: v })}
                    placeholder="Pick a pathway"
                    searchPlaceholder="Search pathways…"
                    emptyText="No pathways"
                    options={options}
                  />
                </div>
                {RUNS.has(kindOf(h.key)) && (
                  <>
                    <div className="w-20">
                      <FormText
                        label="From U"
                        type="number"
                        min={1}
                        max={100}
                        value={h.enter_u}
                        onChange={(v) => set(i, { enter_u: v })}
                      />
                    </div>
                    <div className="w-20">
                      <FormText
                        label="To U"
                        type="number"
                        min={1}
                        max={100}
                        value={h.leave_u}
                        onChange={(v) => set(i, { leave_u: v })}
                      />
                    </div>
                  </>
                )}
                <div className="flex pb-0.5">
                  <IconTip label="Up">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                  </IconTip>
                  <IconTip label="Down">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={i === hops.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </IconTip>
                  <IconTip label="Remove">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => setHops(hops.filter((_, j) => j !== i))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </IconTip>
                </div>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setHops([...hops, { key: null, enter_u: "", leave_u: "" }])
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add hop
            </Button>
            {hops.some((h) => h.key) && (
              <p className="text-sm text-muted-foreground">
                {wayChain(row?.ports[0] ?? "", {
                  exit: row?.end === "AB" ? "port" : "",
                  hops: hops
                    .filter((h) => h.key)
                    .map((h) => ({
                      pathway: null,
                      key: h.key ?? "",
                      kind: kindOf(h.key) || "vertical",
                      label: items.find((p) => p.key === h.key)?.label ?? "",
                      enter_u: null,
                      leave_u: null,
                    })),
                })}
                {hops.some((h) => h.enter_u) && (
                  <span className="num">
                    {" "}
                    ·{" "}
                    {hops
                      .map((h) =>
                        hopUnits({
                          enter_u: h.enter_u ? Number(h.enter_u) : null,
                          leave_u: h.leave_u ? Number(h.leave_u) : null,
                        })
                      )
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                )}
              </p>
            )}
            {(fieldErrors.hops || fieldErrors.rack_id) && (
              <p className="text-sm text-destructive">
                {fieldErrors.hops || fieldErrors.rack_id}
              </p>
            )}
            <FormFooter
              onCancel={() => onOpenChange(false)}
              submitting={save.isPending}
              submitLabel="Save way"
            />
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
