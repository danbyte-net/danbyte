import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { FiberSettings, StrandModelling } from "@/lib/api"
import { TIA_598C } from "@/lib/fiber"
import type { FiberColorEntry } from "@/lib/fiber"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { FiberDot } from "@/components/fiber/fiber-dot"
import { FiberMap } from "@/components/fiber/fiber-map"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

const MODELLING: { value: StrandModelling; label: string; blurb: string }[] = [
  {
    value: "off",
    label: "Off",
    blurb: "A cable is just a cable — no fibre UI.",
  },
  {
    value: "count",
    label: "Count + colours",
    blurb: "Strand count, colours and labels; straight-through trace.",
  },
  {
    value: "accurate",
    label: "Strand-accurate",
    blurb: "Multi-fibre connectors (LC-duplex, MPO) and strand mapping.",
  },
]

export const Route = createFileRoute("/fiber")({ component: FiberSettingsPage })

function FiberSettingsPage() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["fiber-settings"],
    queryFn: () => api<FiberSettings>("/api/fiber-settings/"),
  })
  const [colors, setColors] = useState<FiberColorEntry[]>([])
  const [modelling, setModelling] = useState<StrandModelling>("count")
  useEffect(() => {
    if (q.data) {
      setColors(q.data.colors.length ? q.data.colors : TIA_598C)
      setModelling(q.data.strand_modelling)
    }
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api<FiberSettings>("/api/fiber-settings/", {
        method: "POST",
        body: JSON.stringify({ colors, strand_modelling: modelling }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fiber-settings"] })
      toast.success("Fibre settings saved")
    },
    onError: (e: unknown) => apiErrorToast(e, "Save failed"),
  })

  const dirty =
    !!q.data &&
    (JSON.stringify(colors) !== JSON.stringify(q.data.colors) ||
      modelling !== q.data.strand_modelling)

  const patch = (i: number, key: keyof FiberColorEntry, v: string) =>
    setColors((cs) => cs.map((c, j) => (j === i ? { ...c, [key]: v } : c)))
  const move = (i: number, d: -1 | 1) =>
    setColors((cs) => {
      const j = i + d
      if (j < 0 || j >= cs.length) return cs
      const next = [...cs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const remove = (i: number) => setColors((cs) => cs.filter((_, j) => j !== i))
  const add = () => setColors((cs) => [...cs, { name: "New", hex: "#888888" }])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
        <h1 className="text-base font-semibold">Fibre colours</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setColors(TIA_598C)}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to TIA-598-C
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        {q.isError ? (
          <QueryError error={q.error} />
        ) : (
          <div className="max-w-5xl space-y-8">
            <section>
              <h2 className="text-sm font-semibold">Fibre modelling</h2>
              <p className="mt-1 mb-3 text-xs text-muted-foreground">
                How deeply this tenant models fibres. Keeps the fibre UI out of
                the way for teams that don't need it.
              </p>
              <SegmentedTabs
                items={MODELLING.map((m) => ({
                  value: m.value,
                  label: m.label,
                }))}
                value={modelling}
                onValueChange={setModelling}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {MODELLING.find((m) => m.value === modelling)?.blurb}
              </p>
            </section>

            <div className="grid gap-8 lg:grid-cols-2">
              <section>
                <h2 className="text-sm font-semibold">Strand colour order</h2>
                <p className="mt-1 mb-3 text-xs text-muted-foreground">
                  The colour of each fibre position, in order. Default is the
                  TIA-598-C standard. Position 13+ repeats these colours with a
                  diagonal tracer — one stripe per wrap (13–24 = 1, 25–36 = 2,
                  …).
                </p>
                <div className="divide-y rounded-lg border border-border">
                  {colors.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 p-2">
                      <span className="num w-6 text-center text-[11px] text-muted-foreground">
                        {i + 1}
                      </span>
                      <FiberDot position={i + 1} palette={colors} size={18} />
                      <Input
                        value={c.name}
                        onChange={(e) => patch(i, "name", e.target.value)}
                        className="h-8 flex-1 text-sm"
                        placeholder="Name"
                      />
                      <input
                        type="color"
                        value={c.hex}
                        onChange={(e) => patch(i, "hex", e.target.value)}
                        className="h-8 w-9 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
                        aria-label={`${c.name} colour`}
                      />
                      <Input
                        value={c.hex}
                        onChange={(e) => patch(i, "hex", e.target.value)}
                        className="h-8 w-24 font-mono text-xs"
                        placeholder="#RRGGBB"
                      />
                      <div className="flex shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                          aria-label="Move up"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={i === colors.length - 1}
                          onClick={() => move(i, 1)}
                          aria-label="Move down"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          disabled={colors.length <= 1}
                          onClick={() => remove(i)}
                          aria-label="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 h-8 text-xs"
                  onClick={add}
                >
                  + Add colour
                </Button>
              </section>

              <section>
                <h2 className="text-sm font-semibold">Preview</h2>
                <p className="mt-1 mb-3 text-xs text-muted-foreground">
                  A 24-strand cable with the current palette.
                </p>
                <div className="rounded-lg border border-border bg-card p-4">
                  <FiberMap count={24} strands={{}} palette={colors} />
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
