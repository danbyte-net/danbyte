import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { CableRouting, TrayRef } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { FormCombobox } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"

type Mode = "point-to-point" | "trays"

const LEVEL_LABEL: Record<string, string> = {
  overhead: "overhead",
  underfloor: "underfloor",
}

/**
 * What this cable FOLLOWS on its floor plan, and how to change it.
 *
 * The connect flow asks ducts-vs-point-to-point once, at creation, and until
 * now that answer was write-only: nothing on the cable said which it was, so a
 * run ignoring an obvious tray looked like a rendering bug. Auto-route picks a
 * path for you; this is the manual twin — pick the exact ducts, in order.
 */
export function CableRoutingCard({ cableId }: { cableId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canEdit = canDo("cable", "change")

  const plan = useQuery({
    queryKey: ["cable-floor-plan", cableId],
    queryFn: () =>
      api<{ plan_id: string | null }>(`/api/cables/${cableId}/floor-plan/`),
  })
  const planId = plan.data?.plan_id ?? null

  const routing = useQuery({
    queryKey: ["cable-routing", cableId, planId],
    queryFn: () =>
      api<CableRouting>(`/api/cables/${cableId}/routing/?floor_plan=${planId}`),
    enabled: !!planId,
  })

  // Local draft so reordering feels immediate; re-seeded whenever the server
  // view changes (including after our own save).
  const [mode, setMode] = useState<Mode>("point-to-point")
  const [chosen, setChosen] = useState<TrayRef[]>([])
  useEffect(() => {
    if (!routing.data) return
    setMode(routing.data.mode)
    setChosen(routing.data.trays)
  }, [routing.data])

  const save = useMutation({
    mutationFn: (trayIds: string[]) =>
      api<CableRouting>(`/api/cables/${cableId}/routing/`, {
        method: "PUT",
        body: JSON.stringify({ floor_plan: planId, tray_ids: trayIds }),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["cable-routing", cableId] })
      qc.invalidateQueries({ queryKey: ["cable", cableId] })
      // The room and the flat canvas both draw from this.
      qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths"] })
      toast.success(
        r.mode === "trays"
          ? `Routed via ${r.trays.map((t) => t.name).join(" → ")}`
          : "Set to point-to-point"
      )
    },
    onError: (err) => apiErrorToast(err),
  })

  if (!planId) return null
  if (routing.isError)
    return (
      <section className="rounded-lg border border-border p-4">
        <QueryError error={routing.error} />
      </section>
    )

  const saved = routing.data
  const unused = (saved?.available ?? []).filter(
    (t) => !chosen.some((c) => c.id === t.id)
  )
  const dirty =
    saved != null &&
    (mode !== saved.mode ||
      chosen.map((t) => t.id).join() !== saved.trays.map((t) => t.id).join())

  const move = (i: number, by: number) => {
    const next = [...chosen]
    const j = i + by
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setChosen(next)
  }

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Routing
        </h3>
        {canEdit && (
          <SegmentedTabs<Mode>
            value={mode}
            onValueChange={(m) => {
              setMode(m)
              if (m === "point-to-point") setChosen([])
            }}
            items={[
              { value: "point-to-point", label: "Point-to-point" },
              { value: "trays", label: "Through trays" },
            ]}
          />
        )}
      </div>

      {routing.isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading routing…</p>
      ) : mode === "point-to-point" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Drawn as a direct A↔B run — this cable follows no tray.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {chosen.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No trays picked yet. Add them in the order the cable travels.
            </p>
          ) : (
            <ol className="grid gap-1">
              {chosen.map((t, i) => (
                <li
                  key={t.id}
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm"
                >
                  <span className="num w-5 shrink-0 text-xs text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{t.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {LEVEL_LABEL[t.level] ?? t.level}
                  </span>
                  {canEdit && (
                    <div className="flex shrink-0 gap-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                        title="Earlier in the run"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        disabled={i === chosen.length - 1}
                        onClick={() => move(i, 1)}
                        title="Later in the run"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={() =>
                          setChosen(chosen.filter((c) => c.id !== t.id))
                        }
                        title="Remove from the run"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {canEdit && (
            <FormCombobox
              label="Add a tray"
              hint="pick as many as the run needs"
              value={null}
              onChange={(id) => {
                const t = unused.find((x) => x.id === id)
                if (t) setChosen([...chosen, t])
              }}
              options={unused.map((t) => ({
                value: t.id,
                label: `${t.name} · ${LEVEL_LABEL[t.level] ?? t.level}`,
              }))}
              placeholder={
                unused.length ? "Select a tray…" : "Every tray is in the run"
              }
              searchPlaceholder="Search trays…"
              emptyText="No trays on this plan."
              disabled={unused.length === 0}
            />
          )}
        </div>
      )}

      {canEdit && dirty && (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate(chosen.map((t) => t.id))}
          >
            {save.isPending ? "Saving..." : "Save routing"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => {
              // `dirty` already established that we have a saved view.
              setMode(saved.mode)
              setChosen(saved.trays)
            }}
          >
            Reset
          </Button>
        </div>
      )}
    </section>
  )
}
