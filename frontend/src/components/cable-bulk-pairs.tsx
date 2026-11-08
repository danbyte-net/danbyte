import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight } from "lucide-react"

import { api } from "@/lib/api"
import type { Paginated, TerminationInput, TerminationKind } from "@/lib/api"
import {
  PORT_ENDPOINT,
  PORT_KIND_TABS,
  freePorts,
  pairPositionally,
} from "@/lib/cable-runs"
import type { RunPort } from "@/lib/cable-runs"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SimpleTable } from "@/components/ui/simple-table"
import { DevicePicker } from "@/components/device-picker"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { FormColumn, FormColumns, FormSection } from "@/components/forms"
import { Loading } from "@/components/loading"

/** Many cables at once (#454): each end is one device and one port kind, its
 * free ports listed in natural order with a checkbox each. Pairing is
 * positional - the first ticked A port (top-down) goes to the first ticked B
 * port - and the pairs are previewed as rows before anything is written. */

export interface BulkPair {
  a: TerminationInput
  b: TerminationInput
  aName: string
  bName: string
}

interface SideState {
  deviceId: string | null
  kind: string
  ticked: string[]
}

const EMPTY: SideState = { deviceId: null, kind: "interface", ticked: [] }

function useSide(state: SideState) {
  const ports = useQuery({
    queryKey: ["cable-ports", state.kind, state.deviceId],
    queryFn: () =>
      api<Paginated<RunPort>>(
        `/api/${PORT_ENDPOINT[state.kind as keyof typeof PORT_ENDPOINT]}/?device=${state.deviceId}&page_size=500`
      ),
    enabled: !!state.deviceId,
  })
  const device = useQuery({
    queryKey: ["device", state.deviceId],
    queryFn: () =>
      api<{ id: string; name: string }>(`/api/devices/${state.deviceId}/`),
    enabled: !!state.deviceId,
  })
  const free = useMemo(() => freePorts(ports.data?.results ?? []), [ports.data])
  // Ticked ports in list order, not click order: the pairing reads top-down.
  const picked = useMemo(() => {
    const on = new Set(state.ticked)
    return free.filter((p) => on.has(p.id))
  }, [free, state.ticked])
  return {
    free,
    picked,
    loading: ports.isLoading,
    deviceName: device.data?.name ?? "",
  }
}

function BulkSide({
  title,
  state,
  onChange,
  free,
  loading,
}: {
  title: string
  state: SideState
  onChange: (next: SideState) => void
  free: RunPort[]
  loading: boolean
}) {
  const [q, setQ] = useState("")
  const rows = q
    ? free.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
    : free
  const on = new Set(state.ticked)
  const toggle = (id: string) =>
    onChange({
      ...state,
      ticked: on.has(id)
        ? state.ticked.filter((x) => x !== id)
        : [...state.ticked, id],
    })
  return (
    <FormSection title={title} card>
      <div className="grid gap-2">
        <DevicePicker
          label="Device"
          value={state.deviceId}
          onChange={(v) => {
            setQ("")
            onChange({ ...state, deviceId: v, ticked: [] })
          }}
        />
        {state.deviceId && (
          <>
            <SegmentedTabs
              value={state.kind}
              onValueChange={(v) => {
                setQ("")
                onChange({ ...state, kind: v, ticked: [] })
              }}
              items={PORT_KIND_TABS}
            />
            <div className="flex items-center gap-2">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter ports…"
                className="h-8 text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-[11px]"
                disabled={rows.length === 0}
                onClick={() =>
                  onChange({
                    ...state,
                    ticked: [
                      ...state.ticked,
                      ...rows.map((r) => r.id).filter((id) => !on.has(id)),
                    ],
                  })
                }
              >
                All
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-[11px]"
                disabled={state.ticked.length === 0}
                onClick={() => onChange({ ...state, ticked: [] })}
              >
                None
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-md border border-border">
              {loading ? (
                <Loading />
              ) : rows.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  No free ports of this kind.
                </p>
              ) : (
                rows.map((r) => (
                  <label
                    key={r.id}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/60"
                  >
                    <Checkbox
                      checked={on.has(r.id)}
                      onCheckedChange={() => toggle(r.id)}
                      aria-label={r.name}
                    />
                    <span className="truncate font-mono">{r.name}</span>
                  </label>
                ))
              )}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {state.ticked.length} of {free.length} free ticked
            </span>
          </>
        )}
      </div>
    </FormSection>
  )
}

/** Flatten one pair's server error object into a line. */
function errorText(err: Record<string, unknown> | undefined): string {
  if (!err) return ""
  return Object.values(err)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map(String)
    .join(" ")
}

export function CableBulkPairs({
  onPairsChange,
  errors,
}: {
  onPairsChange: (pairs: BulkPair[]) => void
  /** Per-pair errors from the server, index-aligned with the pairs. */
  errors?: Record<string, unknown>[]
}) {
  const [sideA, setSideA] = useState<SideState>(EMPTY)
  const [sideB, setSideB] = useState<SideState>(EMPTY)
  const a = useSide(sideA)
  const b = useSide(sideB)

  const { pairs, leftoverA, leftoverB } = useMemo(() => {
    const p = pairPositionally(a.picked, b.picked)
    return {
      pairs: p.pairs.map(([x, y]): BulkPair => ({
        a: { kind: sideA.kind as TerminationKind, id: x.id },
        b: { kind: sideB.kind as TerminationKind, id: y.id },
        aName: `${a.deviceName}:${x.name}`,
        bName: `${b.deviceName}:${y.name}`,
      })),
      leftoverA: p.leftoverA,
      leftoverB: p.leftoverB,
    }
  }, [a.picked, b.picked, a.deviceName, b.deviceName, sideA.kind, sideB.kind])

  const signature = pairs.map((p) => `${p.a.id}>${p.b.id}`).join(",")
  useEffect(() => {
    onPairsChange(pairs)
    // Re-emit only when the pairing itself changes, not on every render.
  }, [signature, a.deviceName, b.deviceName])

  const leftover = leftoverA.length || leftoverB.length
  return (
    <div className="grid gap-4">
      <FormColumns>
        <FormColumn>
          <BulkSide
            title="A side"
            state={sideA}
            onChange={setSideA}
            free={a.free}
            loading={a.loading}
          />
        </FormColumn>
        <FormColumn>
          <BulkSide
            title="B side"
            state={sideB}
            onChange={setSideB}
            free={b.free}
            loading={b.loading}
          />
        </FormColumn>
      </FormColumns>

      <FormSection title={`Pairs (${pairs.length})`} card>
        <SimpleTable
          data={pairs}
          getRowKey={(p) => `${p.a.id}>${p.b.id}`}
          empty="Tick ports on both sides."
          columns={[
            {
              id: "n",
              header: "#",
              cell: (_, i) => (
                <span className="num text-muted-foreground">{i + 1}</span>
              ),
            },
            {
              id: "a",
              header: "A side",
              cell: (p) => <span className="font-mono text-xs">{p.aName}</span>,
            },
            {
              id: "to",
              header: "",
              cell: () => (
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              ),
            },
            {
              id: "b",
              header: "B side",
              cell: (p) => <span className="font-mono text-xs">{p.bName}</span>,
            },
            {
              id: "err",
              header: "",
              flex: true,
              cell: (_, i) => (
                <span className="text-xs text-destructive">
                  {errorText(errors?.[i])}
                </span>
              ),
            },
          ]}
        />
        {leftover > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {leftoverA.length > 0
              ? `${leftoverA.length} ticked on A without a partner`
              : `${leftoverB.length} ticked on B without a partner`}
          </p>
        )}
      </FormSection>
    </div>
  )
}
