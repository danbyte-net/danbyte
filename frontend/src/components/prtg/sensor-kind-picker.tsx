import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowDown, ArrowUp, ChevronsUpDown, RefreshCw } from "lucide-react"

import { api } from "@/lib/api"
import type {
  PrtgAddableKind,
  PrtgAddableKinds,
  PrtgSensorKind,
  PrtgSensorKinds,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useFieldControl } from "@/components/ui/field-control"
import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"

// One picker for a PRTG sensor kind, wherever one is chosen: a profile's
// definition rows (any kind PRTG lists, plus Danbyte's own) and the Add
// sensor dialog (what PRTG offers that device). The kinds with Danbyte's own
// form are pinned under "Standard"; the rest is PRTG's list, searchable,
// sortable and narrowed by category.

/** Danbyte's own kinds and their parameters (`/api/prtg/profiles/kinds/`). */
export function usePrtgSensorKinds() {
  return useQuery({
    queryKey: ["prtg-sensor-kinds"],
    queryFn: () => api<PrtgSensorKinds>("/api/prtg/profiles/kinds/"),
    staleTime: 60 * 60_000,
  })
}

/** One kind as the picker lists it. */
export interface SensorKindOption {
  /** What is stored or sent: Danbyte's kind, or PRTG's kind id. */
  id: string
  name: string
  description: string
  category: string
  /** Danbyte's own parameter form, or PRTG's schema. */
  form: "danbyte" | "generic"
  needsScan: boolean
  credentials: string
  /** The row PRTG's list holds for it, when PRTG listed it. */
  prtg: PrtgAddableKind | null
  /** Danbyte's own kind, for the Danbyte form. */
  spec: PrtgSensorKind | null
}

const STANDARD = "Standard"
const ALL = ""

function danbyteCategory(k: PrtgSensorKind): string {
  if (k.value === "device_template") return "Templates"
  if (k.needs === "snmp") return "SNMP"
  if (k.needs === "windows") return "Windows"
  if (k.value === "ping") return "Ping"
  return "Web"
}

function catalogUrl(connectionId: string, linkId?: string, refresh = false) {
  const q = new URLSearchParams()
  if (linkId) q.set("link", linkId)
  if (refresh) q.set("refresh", "1")
  const s = q.toString()
  return `/api/prtg/connections/${connectionId}/sensor-kinds/${s ? `?${s}` : ""}`
}

/**
 * The kinds to pick from. `profile`: Danbyte's own kinds (all of them,
 * device templates too) with PRTG's whole list beside them. `add`: what PRTG
 * offers the linked device, as the Add sensor dialog creates it.
 */
export function useSensorKindOptions(
  connectionId: string,
  { linkId, mode }: { linkId?: string; mode: "profile" | "add" }
) {
  const qc = useQueryClient()
  const key = ["prtg-addable-kinds", connectionId, linkId ?? ""]
  const catalog = useQuery({
    queryKey: key,
    queryFn: () => api<PrtgAddableKinds>(catalogUrl(connectionId, linkId)),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const danbyte = usePrtgSensorKinds()
  const refresh = useMutation({
    mutationFn: () =>
      api<PrtgAddableKinds>(catalogUrl(connectionId, linkId, true)),
    onSuccess: (data) => {
      qc.setQueryData(key, data)
      void qc.invalidateQueries({
        queryKey: ["prtg-addable-kinds", connectionId],
      })
    },
    onError: (e) => apiErrorToast(e, "PRTG did not list its sensor kinds"),
  })
  const rows = useMemo(
    () => (Array.isArray(catalog.data?.kinds) ? catalog.data.kinds : []),
    [catalog.data]
  )
  const options = useMemo(() => {
    const specs = new Map(
      (danbyte.data?.kinds ?? []).map((k) => [k.value, k] as const)
    )
    const fromPrtg = (k: PrtgAddableKind): SensorKindOption => {
      const spec = k.danbyte_kind ? (specs.get(k.danbyte_kind) ?? null) : null
      return {
        id: mode === "profile" && spec ? spec.value : k.id,
        name: k.name,
        description: k.description,
        category: k.category,
        form: k.form,
        needsScan: k.needs_scan ?? k.scan,
        credentials: k.credential_group ?? k.credentials,
        prtg: k,
        spec,
      }
    }
    if (mode === "add") return rows.map(fromPrtg)
    const byDanbyte = new Map(
      rows.filter((r) => r.danbyte_kind).map((r) => [r.danbyte_kind!, r])
    )
    const standard: SensorKindOption[] = (danbyte.data?.kinds ?? []).map(
      (k) => {
        const row = byDanbyte.get(k.value)
        return {
          id: k.value,
          name: k.label,
          description: row?.description ?? "",
          category: row?.category ?? danbyteCategory(k),
          form: "danbyte",
          needsScan: k.per === "interface",
          credentials: row?.credential_group ?? k.needs ?? "",
          prtg: row ?? null,
          spec: k,
        }
      }
    )
    return [...standard, ...rows.filter((r) => !r.danbyte_kind).map(fromPrtg)]
  }, [rows, danbyte.data, mode])
  return {
    options,
    catalog,
    refresh,
    /** PRTG's list is not read: no API key, no linked device, no test. */
    missing: !catalog.isLoading && rows.length === 0,
    loading: catalog.isLoading || danbyte.isLoading,
  }
}

type SortKey = "name" | "category" | "form" | "scan" | "credentials"

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "name", label: "Name", className: "" },
  { key: "category", label: "Category", className: "" },
  { key: "form", label: "Form", className: "" },
  { key: "scan", label: "Needs scan", className: "" },
  { key: "credentials", label: "Credentials", className: "" },
]

const GRID =
  "sm:grid sm:grid-cols-[minmax(0,1fr)_7.5rem_5rem_5.5rem_7.5rem] sm:items-center sm:gap-3"

function sortValue(o: SensorKindOption, key: SortKey): string {
  switch (key) {
    case "category":
      return o.category
    case "form":
      return o.form
    case "scan":
      return o.needsScan ? "0" : "1"
    case "credentials":
      return o.credentials || "~"
    default:
      return o.name
  }
}

function FormChip({ form }: { form: SensorKindOption["form"] }) {
  return (
    <Badge variant={form === "danbyte" ? "secondary" : "outline"}>
      {form === "danbyte" ? "Danbyte" : "PRTG"}
    </Badge>
  )
}

/** "Test the connection first", for a connection whose list is not read. */
function NoCatalog({ detail }: { detail?: string }) {
  return (
    <>
      {detail ? `${detail} ` : ""}
      <Link to="/prtg" search={{ tab: "overview" }} className="link">
        Test the connection first
      </Link>
      .
    </>
  )
}

/**
 * The list itself: search, category rail, sortable columns, keyboard
 * navigation. Inline in the Add sensor dialog; inside the picker's dialog
 * elsewhere.
 */
export function SensorKindBrowser({
  connectionId,
  linkId,
  mode,
  value,
  onPick,
}: {
  connectionId: string
  linkId?: string
  mode: "profile" | "add"
  value?: string
  onPick: (option: SensorKindOption) => void
}) {
  const { options, catalog, refresh, missing, loading } = useSensorKindOptions(
    connectionId,
    { linkId, mode }
  )
  const [term, setTerm] = useState("")
  const [category, setCategory] = useState(ALL)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "name",
    desc: false,
  })
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)

  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const o of options)
      counts.set(o.category, (counts.get(o.category) ?? 0) + 1)
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [options])

  const searching = term.trim() !== ""
  const groups = useMemo(() => {
    const q = term.trim().toLowerCase()
    const shown = options.filter(
      (o) =>
        (category === ALL || o.category === category) &&
        (!q ||
          `${o.name} ${o.description} ${o.id} ${o.prtg?.id ?? ""}`
            .toLowerCase()
            .includes(q))
    )
    const dir = sort.desc ? -1 : 1
    shown.sort(
      (a, b) =>
        dir *
          sortValue(a, sort.key).localeCompare(sortValue(b, sort.key), "en", {
            sensitivity: "base",
            numeric: true,
          }) || a.name.localeCompare(b.name)
    )
    // Danbyte's own kinds first, searching or not.
    const standard = shown.filter((o) => o.form === "danbyte")
    const rest = shown.filter((o) => o.form !== "danbyte")
    return [
      { title: STANDARD, rows: standard },
      { title: searching ? "PRTG" : "All sensors", rows: rest },
    ].filter((g) => g.rows.length > 0)
  }, [options, term, category, sort, searching])
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups])

  useEffect(() => setActive(0), [term, category, sort])
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`
    )
    el?.scrollIntoView({ block: "nearest" })
  }, [active])

  if (loading) return <Loading />
  if (mode === "add" && missing)
    return (
      <EmptyState title="No sensor list from PRTG yet.">
        <NoCatalog
          detail={
            catalog.error instanceof Error ? catalog.error.message : undefined
          }
        />
      </EmptyState>
    )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Home") {
      e.preventDefault()
      setActive(0)
    } else if (e.key === "End") {
      e.preventDefault()
      setActive(flat.length - 1)
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (flat[active]) onPick(flat[active])
    }
  }
  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, desc: !s.desc } : { key, desc: false }
    )
  const optionId = (i: number) => `${listId}-o${i}`
  let index = -1

  return (
    <div className="grid min-w-0 gap-3" data-testid="prtg-kind-browser">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search sensor kinds…"
          aria-label="Search sensor kinds"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={flat[active] ? optionId(active) : undefined}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")}
          />
          <span className="hidden sm:inline">Refresh from PRTG</span>
          <span className="sm:hidden">Refresh</span>
        </Button>
      </div>
      {missing && (
        <p className="text-xs text-muted-foreground">
          PRTG&apos;s sensor list is not read yet, so only Danbyte&apos;s kinds
          are here. <NoCatalog />
        </p>
      )}
      {catalog.data?.source === "danbyte" && (
        <p className="text-xs text-muted-foreground">
          Copied from the seed device&apos;s sensors.
        </p>
      )}
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
        <nav
          aria-label="Categories"
          className="flex shrink-0 gap-1 overflow-x-auto pb-1 sm:max-h-[55vh] sm:w-40 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:pb-0"
        >
          {[[ALL, options.length] as const, ...categories].map(([c, n]) => (
            <button
              key={c || "all"}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                "flex shrink-0 items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs whitespace-nowrap hover:bg-muted",
                category === c
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground"
              )}
            >
              <span className="truncate">{c || "All"}</span>
              <span className="num">{n}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 rounded-md border border-border">
          <div
            className={cn(
              "hidden border-b border-border bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground",
              GRID
            )}
          >
            {COLUMNS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleSort(c.key)}
                className="flex items-center gap-1 text-left whitespace-nowrap hover:text-foreground"
                aria-label={`Sort by ${c.label}`}
              >
                {c.label}
                {sort.key === c.key &&
                  (sort.desc ? (
                    <ArrowDown className="h-3 w-3" />
                  ) : (
                    <ArrowUp className="h-3 w-3" />
                  ))}
              </button>
            ))}
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Sensor kinds"
            className="max-h-[50vh] overflow-y-auto"
            data-testid="prtg-kind-list"
          >
            {flat.length === 0 ? (
              <EmptyState title="No sensor kind matches." className="m-3 p-6" />
            ) : (
              groups.map((g) => (
                <div key={g.title} role="group" aria-label={g.title}>
                  <p className="sticky top-0 z-10 border-b border-border bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground uppercase">
                    {g.title}
                  </p>
                  {g.rows.map((o) => {
                    index += 1
                    const i = index
                    return (
                      <div
                        key={`${o.form}:${o.id}`}
                        id={optionId(i)}
                        role="option"
                        aria-selected={i === active}
                        data-index={i}
                        data-testid="prtg-kind-option"
                        onMouseMove={() => i !== active && setActive(i)}
                        onClick={() => onPick(o)}
                        className={cn(
                          "cursor-pointer border-b border-border px-3 py-2 text-sm last:border-b-0",
                          GRID,
                          i === active && "bg-muted",
                          value === o.id && "font-medium"
                        )}
                      >
                        <div className="min-w-0">
                          <p className="truncate">{o.name}</p>
                          {o.description && (
                            <p className="line-clamp-1 text-xs font-normal text-muted-foreground">
                              {o.description}
                            </p>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground sm:contents">
                          <span className="truncate">{o.category}</span>
                          <span>
                            <FormChip form={o.form} />
                          </span>
                          <span>
                            {o.needsScan ? (
                              <Badge variant="outline">Scan</Badge>
                            ) : (
                              <span className="hidden sm:inline">-</span>
                            )}
                          </span>
                          <span className="truncate">
                            {o.credentials || (
                              <span className="hidden sm:inline">-</span>
                            )}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A button showing the chosen kind (name, category muted) that opens the
 * browser in a dialog. Use inside a `Field` for its label.
 */
export function SensorKindPicker({
  connectionId,
  linkId,
  mode = "profile",
  value,
  fallbackLabel,
  onChange,
  disabled,
}: {
  connectionId: string
  linkId?: string
  mode?: "profile" | "add"
  value: string
  /** The name to show before the list has loaded (`kind_label`). */
  fallbackLabel?: string
  onChange: (option: SensorKindOption) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const field = useFieldControl()
  const { options } = useSensorKindOptions(connectionId, { linkId, mode })
  const chosen = options.find((o) => o.id === value)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        id={field?.id}
        aria-labelledby={field ? `${field.labelId} ${field.id}` : undefined}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="w-full min-w-0 justify-between font-normal"
        data-testid="prtg-kind-picker"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">
            {chosen?.name ?? fallbackLabel ?? value}
          </span>
          {chosen?.category && (
            <span className="truncate text-xs text-muted-foreground">
              {chosen.category}
            </span>
          )}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="4xl" data-testid="prtg-kind-dialog">
          <DialogHeader>
            <DialogTitle>Sensor kind</DialogTitle>
            <DialogDescription>
              Danbyte&apos;s own kinds first, then everything PRTG lists.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <SensorKindBrowser
              connectionId={connectionId}
              linkId={linkId}
              mode={mode}
              value={value}
              onPick={(o) => {
                onChange(o)
                setOpen(false)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
