import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import type { DragEndEvent } from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  ChevronDown,
  Download,
  FileText,
  GripVertical,
  Printer,
} from "lucide-react"

import { ApiError, api, apiErrorMessage } from "@/lib/api"
import type {
  ObjectReportColumn,
  ObjectReportEstimate,
  ObjectReportJobStatus,
  ObjectReportKind,
  ObjectReportRequest,
  ObjectReportSchema,
  ObjectReportStarted,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  exportFileName,
  openPrintTab,
  sendPdf,
} from "@/lib/diagram/export-file"
import { cn } from "@/lib/utils"
import { Field, FormCheckbox, FormSelect, FormText } from "@/components/forms"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import type { ExtraExport } from "@/components/table-io"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * **PDF report…** for devices, prefixes and IP addresses
 * (api/object_report.py): one object from its detail page, the rows
 * selected on a list, or the rows the list shows. The server says what a
 * report can hold for this reader (`GET`), the dialog picks it - the
 * columns of the list table, the summary, details for each object and
 * their sections with their columns - and remembers the picks per type in
 * this browser. A live estimate (`?estimate=1`) says whether it renders now
 * or in the background; a background report is polled until it is ready,
 * then downloaded or printed like a quick one.
 */

export const REPORT_PATHS: Record<ObjectReportKind, string> = {
  device: "/api/devices/report/",
  prefix: "/api/prefixes/report/",
  ipaddress: "/api/ips/report/",
}

/** What a report covers: `ids` (a detail page's one, a list's selection or
 * the rows it shows), and the list's own filters. */
export interface ReportTarget {
  ids: string[]
  filters?: Record<string, string>
  scope: "one" | "selected" | "filtered"
  /** The object's name, for a detail page's title. */
  name?: string
}

type Paper = "a4" | "letter" | "a3"
type Orientation = "portrait" | "landscape"

/** The picks remembered per type. */
export interface ReportPrefs {
  paper: Paper
  orientation: Orientation
  sections: string[]
  columns: Partial<Record<string, string[]>>
  groupBy: string | null
  includeSummary: boolean
  perObject: boolean
  showIps: boolean
  last: number
}

const PAPER_ITEMS: { value: Paper; label: string }[] = [
  { value: "a4", label: "A4" },
  { value: "letter", label: "Letter" },
  { value: "a3", label: "A3" },
]
const ORIENTATION_ITEMS: { value: Orientation; label: string }[] = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
]

const prefsKey = (kind: ObjectReportKind) => `object-report:${kind}`

export function readReportPrefs(
  kind: ObjectReportKind
): Partial<ReportPrefs> | null {
  try {
    const raw = window.localStorage.getItem(prefsKey(kind))
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    return v && typeof v === "object" ? v : null
  } catch {
    return null
  }
}

export function writeReportPrefs(kind: ObjectReportKind, prefs: ReportPrefs) {
  try {
    window.localStorage.setItem(prefsKey(kind), JSON.stringify(prefs))
  } catch {
    /* private window or full storage: the picks are not kept */
  }
}

/** The picks to start from: the remembered ones that still exist, else the
 * server's defaults. */
export function initialPrefs(
  schema: ObjectReportSchema,
  saved: Partial<ReportPrefs> | null
): ReportPrefs {
  const sectionKeys = new Set(schema.sections.map((s) => s.key))
  const known = (
    keys: unknown,
    from: ObjectReportColumn[]
  ): string[] | null => {
    if (!Array.isArray(keys)) return null
    const ok = new Set(from.map((c) => c.key))
    const out = keys.filter(
      (k): k is string => typeof k === "string" && ok.has(k)
    )
    return out.length ? out : null
  }
  const columns: Record<string, string[]> = {
    list: known(saved?.columns?.list, schema.columns) ?? schema.default_columns,
  }
  for (const s of schema.sections)
    columns[s.key] =
      known(saved?.columns?.[s.key], s.columns) ?? s.default_columns
  const savedSections = Array.isArray(saved?.sections)
    ? saved.sections.filter((k) => sectionKeys.has(k))
    : null
  const groupKeys = new Set(schema.group_by.map((g) => g.key))
  return {
    paper: PAPER_ITEMS.some((p) => p.value === saved?.paper)
      ? (saved!.paper as Paper)
      : "a4",
    orientation:
      saved?.orientation === "portrait" || saved?.orientation === "landscape"
        ? saved.orientation
        : "landscape",
    sections:
      savedSections ??
      schema.sections.filter((s) => s.default).map((s) => s.key),
    columns,
    groupBy:
      saved?.groupBy && groupKeys.has(saved.groupBy) ? saved.groupBy : null,
    includeSummary: saved?.includeSummary ?? true,
    perObject: saved?.perObject ?? false,
    showIps: saved?.showIps ?? false,
    last:
      typeof saved?.last === "number" && saved.last >= 1
        ? Math.min(saved.last, schema.limits.last)
        : 20,
  }
}

/** The POST body for the dialog's picks. */
export function reportRequest(
  target: ReportTarget,
  prefs: ReportPrefs,
  schema: ObjectReportSchema,
  title: string
): ObjectReportRequest {
  const one = target.ids.length === 1
  const perObject = one || prefs.perObject
  const available = new Set(
    schema.sections.filter((s) => s.available).map((s) => s.key)
  )
  const sections = schema.sections
    .map((s) => s.key)
    .filter((k) => prefs.sections.includes(k) && available.has(k))
  const columns: Record<string, string[]> = {}
  if (!one) columns.list = prefs.columns.list ?? []
  if (perObject) for (const k of sections) columns[k] = prefs.columns[k] ?? []
  return {
    ids: target.ids,
    ...(target.filters ? { filters: target.filters } : {}),
    sections,
    columns,
    options: {
      ...(title.trim() ? { title: title.trim() } : {}),
      paper: prefs.paper,
      orientation: prefs.orientation,
      group_by: one ? null : prefs.groupBy,
      include_summary: !one && prefs.includeSummary,
      list_table: !one,
      per_object: perObject,
      ...(schema.show_ips && !one ? { show_ips: prefs.showIps } : {}),
      last: prefs.last,
    },
  }
}

export function ObjectReportDialog({
  kind,
  target,
  open,
  onOpenChange,
}: {
  kind: ObjectReportKind
  target: ReportTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const schema = useQuery({
    queryKey: ["object-report-schema", kind],
    queryFn: () => api<ObjectReportSchema>(REPORT_PATHS[kind]),
    enabled: open,
    staleTime: 60_000,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" data-part="object-report">
        <DialogHeader>
          <DialogTitle>PDF report</DialogTitle>
          <DialogDescription>{describeTarget(kind, target)}</DialogDescription>
        </DialogHeader>
        {schema.isPending ? (
          <Loading />
        ) : schema.isError ? (
          <QueryError error={schema.error} />
        ) : (
          target && (
            <ReportForm
              // Fresh picks each time it opens on a new schema.
              key={`${kind}:${target.scope}`}
              kind={kind}
              schema={schema.data}
              target={target}
              onDone={() => onOpenChange(false)}
            />
          )
        )}
      </DialogContent>
    </Dialog>
  )
}

function describeTarget(
  kind: ObjectReportKind,
  target: ReportTarget | null
): string {
  if (!target) return ""
  const noun = { device: "device", prefix: "prefix", ipaddress: "IP address" }[
    kind
  ]
  const plural = {
    device: "devices",
    prefix: "prefixes",
    ipaddress: "IP addresses",
  }[kind]
  const n = target.ids.length
  if (target.scope === "one") return target.name ?? `One ${noun}`
  const what = `${n.toLocaleString()} ${n === 1 ? noun : plural}`
  return target.scope === "selected"
    ? `${what}, selected`
    : `${what} in the list`
}

const NOUNS: Record<ObjectReportKind, string> = {
  device: "device",
  prefix: "prefix",
  ipaddress: "IP address",
}

/** How often a background report's status is asked for. */
export const JOB_POLL_MS = 1500

function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return out
}

/** A count as people say it: 14,207 → "14,200". */
function about(n: number): string {
  return (n >= 1000 ? Math.round(n / 100) * 100 : n).toLocaleString()
}

/** The line under the options: what the report costs and where it renders,
 * or what to leave out. */
export function estimateLine(
  est: ObjectReportEstimate,
  { showIps, details }: { showIps: boolean; details: boolean }
): string {
  const cells = `About ${about(est.cells)} cells`
  if (est.mode === "now") return cells
  if (est.mode === "background") return `${cells} · renders in the background`
  const drop = [
    showIps && "Show IPs",
    details && "the details",
    "some rows or columns",
  ].filter(Boolean)
  return `Too large: ${about(est.cells)} cells, ${about(est.fits.background)} fit · leave out ${drop.join(" or ")}`
}

/** A background report's link once it is done; throws its reason when it
 * fails. `onState` hears each poll; `alive` stops it. */
async function waitForJob(
  status: string,
  onState: (s: ObjectReportJobStatus) => void,
  alive: () => boolean
): Promise<string | null> {
  for (;;) {
    await new Promise((r) => setTimeout(r, JOB_POLL_MS))
    if (!alive()) return null
    const s = await api<ObjectReportJobStatus>(status)
    if (!alive()) return null
    onState(s)
    if (s.state === "done" && s.url) return s.url
    if (s.state === "failed")
      throw new Error(s.detail ?? "The report could not be made.")
  }
}

function ReportForm({
  kind,
  schema,
  target,
  onDone,
}: {
  kind: ObjectReportKind
  schema: ObjectReportSchema
  target: ReportTarget
  onDone: () => void
}) {
  const [prefs, setPrefs] = useState<ReportPrefs>(() =>
    initialPrefs(schema, readReportPrefs(kind))
  )
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<ObjectReportJobStatus | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const one = target.ids.length === 1
  const perObject = one || prefs.perObject
  const set = <TKey extends keyof ReportPrefs>(k: TKey, v: ReportPrefs[TKey]) =>
    setPrefs((p) => ({ ...p, [k]: v }))
  const setColumns = (key: string, cols: string[]) =>
    setPrefs((p) => ({ ...p, columns: { ...p.columns, [key]: cols } }))
  const toggleSection = (key: string, on: boolean) =>
    setPrefs((p) => ({
      ...p,
      sections: on
        ? [...p.sections.filter((k) => k !== key), key]
        : p.sections.filter((k) => k !== key),
    }))
  const tooMany = target.ids.length > schema.limits.objects
  const tooManyPages =
    !one && prefs.perObject && target.ids.length > schema.limits.object_pages
  const empty = target.ids.length === 0
  const noun = NOUNS[kind]

  const limitNote = tooMany
    ? `A report lists at most ${schema.limits.objects.toLocaleString()} ${schema.plural.toLowerCase()}.`
    : tooManyPages
      ? `Details: at most ${schema.limits.object_pages} ${schema.plural.toLowerCase()}.`
      : empty
        ? `No ${schema.plural.toLowerCase()} to report on.`
        : ""

  // The live estimate: the body as it would be posted, a moment after the
  // last change, built on the server without rendering.
  const body = useMemo(
    () => JSON.stringify(reportRequest(target, prefs, schema, title)),
    [target, prefs, schema, title]
  )
  const settled = useDebounced(body, 400)
  const estimate = useQuery({
    queryKey: ["object-report-estimate", kind, settled],
    queryFn: () =>
      api<ObjectReportEstimate>(`${REPORT_PATHS[kind]}?estimate=1`, {
        method: "POST",
        body: settled,
      }),
    enabled: !limitNote,
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev) => prev,
  })
  // A refusal (400) is the report's; any other failure says nothing.
  const refused =
    estimate.error instanceof ApiError && estimate.error.status === 400
      ? apiErrorMessage(estimate.error)
      : ""
  const tooLarge =
    !!refused || (!estimate.isError && estimate.data?.mode === "too_large")
  const line = refused
    ? refused
    : estimate.data && !estimate.isError
      ? estimateLine(estimate.data, {
          showIps: !one && !!schema.show_ips && prefs.showIps,
          details: !one && prefs.perObject,
        })
      : ""

  const run = async (print: boolean) => {
    const tab = print ? openPrintTab() : null
    let printing = false
    setBusy(true)
    try {
      writeReportPrefs(kind, prefs)
      const started = await api<ObjectReportStarted>(
        `${REPORT_PATHS[kind]}?print=1`,
        { method: "POST", body }
      )
      let url: string | null
      if ("job" in started) {
        setJob({ state: "queued" })
        url = await waitForJob(started.status, setJob, () => alive.current)
        if (!url) return
      } else url = started.url
      const name = title.trim() || target.name || `${schema.plural} report`
      printing = sendPdf(url, {
        print,
        tab,
        fileName: exportFileName(name, "pdf", undefined, "report"),
      })
      onDone()
    } catch (err) {
      if (alive.current) apiErrorToast(err, "Couldn't make the report")
    } finally {
      if (tab && !printing) tab.close()
      if (alive.current) {
        setBusy(false)
        setJob(null)
      }
    }
  }

  const generating =
    job?.progress != null ? `Generating… ${job.progress}%` : "Generating…"

  const sectionsBlock = perObject && (
    <>
      <Field label={one ? "Sections" : "Detail sections"}>
        <div className="grid gap-1.5">
          {schema.sections.map((s) => (
            <div
              key={s.key}
              className="flex min-h-7 items-center gap-2"
              data-section={s.key}
            >
              <FormCheckbox
                label={s.label}
                checked={s.available && prefs.sections.includes(s.key)}
                disabled={!s.available}
                onChange={(on) => toggleSection(s.key, on)}
                className="flex-1 items-center text-[13px] whitespace-nowrap"
              />
              {!s.available && s.note && (
                <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                  {s.note}
                </span>
              )}
              {s.available &&
                s.columns.length > 0 &&
                prefs.sections.includes(s.key) && (
                  <ColumnPicker
                    label={`${s.label} columns`}
                    columns={s.columns}
                    value={prefs.columns[s.key] ?? []}
                    onChange={(cols) => setColumns(s.key, cols)}
                  />
                )}
            </div>
          ))}
        </div>
      </Field>
      {schema.sections.some(
        (s) => s.last && s.available && prefs.sections.includes(s.key)
      ) && (
        <FormText
          label="Journal and change log entries"
          type="number"
          value={String(prefs.last)}
          onChange={(v) =>
            set(
              "last",
              Math.max(1, Math.min(schema.limits.last, Number(v) || 1))
            )
          }
          inputClassName="w-24"
        />
      )}
    </>
  )

  return (
    <>
      <div className="grid gap-4">
        <FormText
          label="Title"
          value={title}
          onChange={setTitle}
          placeholder={
            one && target.name
              ? `${schema.label} ${target.name}`
              : `${schema.plural} report`
          }
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paper">
            <SegmentedTabs<Paper>
              items={PAPER_ITEMS}
              value={prefs.paper}
              onValueChange={(v) => set("paper", v)}
            />
          </Field>
          <Field label="Orientation">
            <SegmentedTabs<Orientation>
              items={ORIENTATION_ITEMS}
              value={prefs.orientation}
              onValueChange={(v) => set("orientation", v)}
            />
          </Field>
        </div>
        {!one && (
          <>
            <Field label="List columns">
              <ColumnPicker
                label="List columns"
                columns={schema.columns}
                value={prefs.columns.list ?? []}
                onChange={(cols) => setColumns("list", cols)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormSelect
                label="Group by"
                value={prefs.groupBy}
                onChange={(v) => set("groupBy", v)}
                noneLabel="No grouping"
                options={schema.group_by.map((g) => ({
                  value: g.key,
                  label: g.label,
                }))}
              />
              <Field label="Include">
                <div className="grid gap-2 pt-1">
                  <FormCheckbox
                    label="Summary"
                    checked={prefs.includeSummary}
                    onChange={(v) => set("includeSummary", v)}
                    className="items-center text-[13px]"
                  />
                  {schema.show_ips && (
                    <FormCheckbox
                      label="Show IPs"
                      checked={prefs.showIps}
                      onChange={(v) => set("showIps", v)}
                      className="items-center text-[13px] whitespace-nowrap"
                    />
                  )}
                  <FormCheckbox
                    label={`Details for each ${noun}`}
                    checked={prefs.perObject}
                    onChange={(v) => set("perObject", v)}
                    className="items-center text-[13px] whitespace-nowrap"
                  />
                </div>
              </Field>
            </div>
          </>
        )}
        {sectionsBlock &&
          (one ? (
            sectionsBlock
          ) : (
            <div className="ml-1 grid gap-4 border-l pl-4" data-part="details">
              {sectionsBlock}
            </div>
          ))}
        {limitNote ? (
          <p className="text-xs text-destructive" role="alert">
            {limitNote}
          </p>
        ) : (
          line && (
            <p
              className={cn(
                "text-xs",
                tooLarge ? "text-destructive" : "text-muted-foreground"
              )}
              role={tooLarge ? "alert" : "status"}
              data-part="estimate"
            >
              {line}
            </p>
          )
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="outline"
          disabled={busy || !!limitNote || tooLarge}
          onClick={() => void run(true)}
        >
          <Printer /> Print
        </Button>
        <Button
          disabled={busy || !!limitNote || tooLarge}
          onClick={() => void run(false)}
        >
          <Download /> {busy ? generating : "Download"}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Pick and order columns: the shown ones drag into order, the others
 * check on at the end. */
export function ColumnPicker({
  label,
  columns,
  value,
  onChange,
}: {
  label: string
  columns: ObjectReportColumn[]
  value: string[]
  onChange: (cols: string[]) => void
}) {
  const labels = useMemo(
    () => new Map(columns.map((c) => [c.key, c.label] as const)),
    [columns]
  )
  const shown = value.filter((k) => labels.has(k))
  const available = columns.filter((c) => !shown.includes(c.key))
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = shown.indexOf(String(active.id))
    const to = shown.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    onChange(arrayMove(shown, from, to))
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 justify-between gap-1 px-2 text-xs whitespace-nowrap"
          aria-label={label}
        >
          {shown.length} {shown.length === 1 ? "column" : "columns"}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="-mx-1 max-h-[50vh] overflow-y-auto px-1">
          <Title>Shown</Title>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={shown}
              strategy={verticalListSortingStrategy}
            >
              {shown.map((k) => (
                <ShownRow
                  key={k}
                  id={k}
                  label={labels.get(k) ?? k}
                  onHide={() => onChange(shown.filter((x) => x !== k))}
                />
              ))}
            </SortableContext>
          </DndContext>
          {shown.length === 0 && (
            <div className="px-1 py-1 text-[11px] text-muted-foreground">
              None
            </div>
          )}
          {available.length > 0 && (
            <Title className="mt-1.5 border-t pt-2">Available</Title>
          )}
          {available.map((c) => (
            <div
              key={c.key}
              className="flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50"
            >
              <span aria-hidden className="-ml-0.5 w-3.5 shrink-0" />
              <Checkbox
                checked={false}
                onCheckedChange={() => onChange([...shown, c.key])}
                aria-label={`Show ${c.label}`}
              />
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Title({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "px-1 pb-1 text-[10px] font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase",
        className
      )}
    >
      {children}
    </div>
  )
}

function ShownRow({
  id,
  label,
  onHide,
}: {
  id: string
  label: string
  onHide: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50",
        isDragging && "relative z-10 bg-muted opacity-90 shadow-sm"
      )}
    >
      <button
        type="button"
        className="-ml-0.5 cursor-grab touch-none text-muted-foreground/50 hover:text-foreground"
        aria-label={`Drag ${label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <Checkbox
        checked
        onCheckedChange={() => onHide()}
        aria-label={`Hide ${label}`}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  )
}

/** The report dialog for a page, opened on a target: `open(target)`, and
 * the `dialog` to render once. */
export function useObjectReport(kind: ObjectReportKind) {
  const [target, setTarget] = useState<ReportTarget | null>(null)
  const [open, setOpen] = useState(false)
  const openReport = useCallback((t: ReportTarget) => {
    setTarget(t)
    setOpen(true)
  }, [])
  const dialog = (
    <ObjectReportDialog
      kind={kind}
      target={target}
      open={open}
      onOpenChange={setOpen}
    />
  )
  return { openReport, dialog }
}

/** The "PDF report…" entry for an Import / Export menu or a bulk bar's
 * Export menu: `target` is read on click, so it follows the list. */
export function reportExport(
  openReport: (t: ReportTarget) => void,
  target: () => ReportTarget,
  disabled = false
): ExtraExport {
  return {
    key: "pdf-report",
    label: "PDF report…",
    disabled,
    onSelect: () => openReport(target()),
  }
}

/** A detail page's **PDF report…** button. */
export function ObjectReportButton({
  kind,
  id,
  name,
}: {
  kind: ObjectReportKind
  id: string
  name: string
}) {
  const { openReport, dialog } = useObjectReport(kind)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => openReport({ ids: [id], scope: "one", name })}
      >
        <FileText className="h-3.5 w-3.5" /> PDF report…
      </Button>
      {dialog}
    </>
  )
}
