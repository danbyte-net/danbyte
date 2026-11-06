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
import { Link } from "@tanstack/react-router"
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
  ObjectReportRequest,
  ObjectReportSchema,
  ObjectReportStarted,
  ReportCoverBackground,
  ReportKind,
  TopologyReportRequest,
  TopologyReportView,
  SensitivityLabelRef,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import {
  exportFileName,
  openPrintTab,
  sendPdf,
} from "@/lib/diagram/export-file"
import { cn } from "@/lib/utils"
import type { ReportDrawing } from "@/components/topology/export/export-menu"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormSelect,
  FormText,
} from "@/components/forms"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { COVER_PRESETS } from "@/components/settings/report-cover-card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
 * this browser. An optional cover page (api/report_cover.py) takes its
 * look from the tenant's settings; the dialog picks only its title,
 * subtitle, project line and background. A live estimate (`?estimate=1`)
 * says whether it renders now or in the background; a background report is polled until it is ready,
 * then downloaded or printed like a quick one.
 *
 * The same dialog makes the **topology report** (api/reports/kinds/topology.py)
 * for one or more topology views: its sections and their columns, the
 * cover, and for several views one PDF or a ZIP. Each view is drawn as the
 * map's Export ▸ PDF draws it (`TopologyTargetView.draw`) when the report
 * is made.
 */

export const REPORT_PATHS: Record<ReportKind, string> = {
  device: "/api/devices/report/",
  prefix: "/api/prefixes/report/",
  ipaddress: "/api/ips/report/",
  topology: "/api/topology/report/",
}

/** One view of a topology report: its name, the saved view it is, the
 * devices it shows when known before drawing (for the live estimate), and
 * how to draw it. */
export interface TopologyTargetView {
  id?: string | null
  name: string
  devices?: string[]
  draw: () => Promise<ReportDrawing | null>
}

/** What a report covers: `ids` (a detail page's one, a list's selection or
 * the rows it shows), and the list's own filters. */
export interface ReportTarget {
  ids: string[]
  filters?: Record<string, string>
  scope: "one" | "selected" | "filtered"
  /** The object's name, for a detail page's title. */
  name?: string
  /** The topology report: the views, in `ids`' order. */
  views?: TopologyTargetView[]
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
  cover: boolean
  coverBackground: ReportCoverBackground
  coverProject: string
  /** The topology report of several views: one PDF or a ZIP of them. */
  output: "pdf" | "zip"
  /** The sensitivity label's id; null for none. */
  sensitivityLabel: string | null
}

/** One report's cover colours, in place of the tenant's. */
export type CoverColors = { horizon: string; wave: string; crest: string }

/** The cover's per-report text: `null` follows the report (the title) or
 * the server (the generated subtitle). */
export interface CoverText {
  title: string
  subtitle: string | null
}

const COVER_BACKGROUNDS: ReportCoverBackground[] = [
  "default",
  "waves",
  "plain",
  "upload",
  "none",
]

const PAPER_ITEMS: { value: Paper; label: string }[] = [
  { value: "a4", label: "A4" },
  { value: "letter", label: "Letter" },
  { value: "a3", label: "A3" },
]
const ORIENTATION_ITEMS: { value: Orientation; label: string }[] = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
]

const prefsKey = (kind: ReportKind) => `object-report:${kind}`

export function readReportPrefs(kind: ReportKind): Partial<ReportPrefs> | null {
  try {
    const raw = window.localStorage.getItem(prefsKey(kind))
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    return v && typeof v === "object" ? v : null
  } catch {
    return null
  }
}

export function writeReportPrefs(kind: ReportKind, prefs: ReportPrefs) {
  try {
    // "No grouping" is kept as "": a remembered null is from before a type
    // had a default grouping, and starts from that default.
    window.localStorage.setItem(
      prefsKey(kind),
      JSON.stringify({ ...prefs, groupBy: prefs.groupBy ?? "" })
    )
  } catch {
    /* private window or full storage: the picks are not kept */
  }
}

/** The picks to start from: the remembered ones that still exist, else the
 * server's defaults. */
export function initialPrefs(
  schema: ObjectReportSchema,
  saved: Partial<ReportPrefs> | null,
  labels: SensitivityLabelRef[] = []
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
    // Prefixes start grouped by VRF, as their list is (default_group_by).
    groupBy:
      saved?.groupBy && groupKeys.has(saved.groupBy)
        ? saved.groupBy
        : saved?.groupBy === ""
          ? null
          : (schema.default_group_by ?? null),
    includeSummary: saved?.includeSummary ?? true,
    perObject: saved?.perObject ?? false,
    showIps: saved?.showIps ?? false,
    last:
      typeof saved?.last === "number" && saved.last >= 1
        ? Math.min(saved.last, schema.limits.last)
        : 20,
    cover: saved?.cover === true,
    coverBackground: coverBackgroundItems(schema).some(
      (i) => i.value === saved?.coverBackground
    )
      ? (saved!.coverBackground as ReportCoverBackground)
      : "default",
    coverProject:
      typeof saved?.coverProject === "string" ? saved.coverProject : "",
    output: saved?.output === "zip" ? "zip" : "pdf",
    sensitivityLabel: initialLabel(saved, labels),
  }
}

/** The label a report starts with: the one picked last time for this type
 * (none counts) while it still exists, else the tenant's default, else
 * none. */
export function initialLabel(
  saved: Partial<ReportPrefs> | null,
  labels: SensitivityLabelRef[]
): string | null {
  if (saved && "sensitivityLabel" in saved) {
    const id = saved.sensitivityLabel
    if (id === null) return null
    if (labels.some((l) => l.id === id)) return id as string
  }
  return labels.find((l) => l.is_default)?.id ?? null
}

/** The cover's background choices: the tenant's default, then the others
 * it can be - the upload only when there is one. */
export function coverBackgroundItems(
  schema: ObjectReportSchema
): { value: ReportCoverBackground; label: string }[] {
  const cover = schema.cover
  const tenant = cover?.background ?? "waves"
  return COVER_BACKGROUNDS.filter(
    (v) =>
      v === "default" || (v !== tenant && (v !== "upload" || !!cover?.upload))
  ).map((value) => ({
    value,
    label: {
      default: "Default",
      waves: "Waves",
      plain: "Plain colour",
      upload: "Your upload",
      none: "None",
    }[value],
  }))
}

/** The cover's generated subtitle, as the server makes it: *48 prefixes ·
 * Group by VRF*, or the type for one object. */
export function coverSubtitle(
  target: ReportTarget,
  prefs: ReportPrefs,
  schema: ObjectReportSchema
): string {
  const n = target.ids.length
  if (schema.type === "topology")
    return n === 1 ? "Topology" : `${n.toLocaleString()} topology views`
  if (n === 1) return schema.label
  const what = `${n.toLocaleString()} ${schema.plural.toLowerCase()}`
  const group = schema.group_by.find((g) => g.key === prefs.groupBy)
  return group ? `${what} · Group by ${group.label}` : what
}

/** The POST body for the dialog's picks. */
export function reportRequest(
  target: ReportTarget,
  prefs: ReportPrefs,
  schema: ObjectReportSchema,
  title: string,
  cover: CoverText = { title: "", subtitle: null },
  coverColors: CoverColors | null = null
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
      ...(prefs.cover
        ? {
            cover: true,
            ...(cover.title.trim() ? { cover_title: cover.title.trim() } : {}),
            ...(cover.subtitle !== null
              ? { cover_subtitle: cover.subtitle.trim() }
              : {}),
            ...(prefs.coverProject.trim()
              ? { cover_project: prefs.coverProject.trim() }
              : {}),
            cover_background: prefs.coverBackground,
            ...(coverColors ? { cover_colors: coverColors } : {}),
          }
        : {}),
      ...(prefs.sensitivityLabel
        ? { sensitivity_label: prefs.sensitivityLabel }
        : {}),
    },
  }
}

/** The topology report's POST body for the dialog's picks and the views
 * as drawn (`drawn`, in the target's order; without it, the estimate's
 * body: no drawings, the devices known before drawing). */
export function topologyRequest(
  target: ReportTarget,
  prefs: ReportPrefs,
  schema: ObjectReportSchema,
  title: string,
  cover: CoverText = { title: "", subtitle: null },
  coverColors: CoverColors | null = null,
  drawn?: (ReportDrawing | null)[]
): TopologyReportRequest {
  const available = new Set(
    schema.sections.filter((s) => s.available).map((s) => s.key)
  )
  const sections = schema.sections
    .map((s) => s.key)
    .filter((k) => prefs.sections.includes(k) && available.has(k))
  const columns: Record<string, string[]> = {}
  for (const k of sections)
    if (k !== "diagram") columns[k] = prefs.columns[k] ?? []
  const views: TopologyReportView[] = (target.views ?? []).map((v, i) => {
    const d = drawn?.[i]
    return {
      view: v.id ?? null,
      title: d?.drawing.title ?? v.name,
      filters: d?.drawing.filters ?? "",
      svg: d?.drawing.svg ?? "",
      device_ids: d?.devices ?? v.devices ?? [],
    }
  })
  const titleBlock = drawn?.find(Boolean)?.titleBlock
  return {
    views,
    sections,
    columns,
    options: {
      ...(title.trim() ? { title: title.trim() } : {}),
      paper: prefs.paper,
      orientation: prefs.orientation,
      ...(titleBlock === undefined ? {} : { title_block: titleBlock }),
      ...(views.length > 1 ? { output: prefs.output } : {}),
      ...(prefs.cover
        ? {
            cover: true,
            ...(cover.title.trim() ? { cover_title: cover.title.trim() } : {}),
            ...(cover.subtitle !== null
              ? { cover_subtitle: cover.subtitle.trim() }
              : {}),
            ...(prefs.coverProject.trim()
              ? { cover_project: prefs.coverProject.trim() }
              : {}),
            cover_background: prefs.coverBackground,
          }
        : {}),
      // The chapter banners take the cover's colours too.
      ...(coverColors ? { cover_colors: coverColors } : {}),
      ...(prefs.sensitivityLabel
        ? { sensitivity_label: prefs.sensitivityLabel }
        : {}),
    },
  }
}

export function ObjectReportDialog({
  kind,
  target,
  open,
  onOpenChange,
}: {
  kind: ReportKind
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
  // The labels this reader may mark with; none when they may not view any.
  const labels = useQuery({
    queryKey: ["sensitivity-labels-picker"],
    queryFn: () =>
      apiAll<SensitivityLabelRef>("/api/sensitivity-labels/?picker=1").then(
        (r) => r.results,
        () => [] as SensitivityLabelRef[]
      ),
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
        {schema.isPending || labels.isPending ? (
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
              labels={labels.data ?? []}
              target={target}
              onDone={() => onOpenChange(false)}
            />
          )
        )}
      </DialogContent>
    </Dialog>
  )
}

function describeTarget(kind: ReportKind, target: ReportTarget | null): string {
  if (!target) return ""
  const noun = NOUNS[kind]
  const plural = {
    device: "devices",
    prefix: "prefixes",
    ipaddress: "IP addresses",
    topology: "topology views",
  }[kind]
  const n = target.ids.length
  if (target.scope === "one") return target.name ?? `One ${noun}`
  const what = `${n.toLocaleString()} ${n === 1 ? noun : plural}`
  return target.scope === "selected"
    ? `${what}, selected`
    : `${what} in the list`
}

const NOUNS: Record<ReportKind, string> = {
  device: "device",
  prefix: "prefix",
  ipaddress: "IP address",
  topology: "topology view",
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
  labels,
  target,
  onDone,
}: {
  kind: ReportKind
  schema: ObjectReportSchema
  labels: SensitivityLabelRef[]
  target: ReportTarget
  onDone: () => void
}) {
  const { canManage } = useMe()
  const [prefs, setPrefs] = useState<ReportPrefs>(() =>
    initialPrefs(schema, readReportPrefs(kind), labels)
  )
  const [title, setTitle] = useState("")
  const [cover, setCover] = useState<CoverText>({ title: "", subtitle: null })
  const [coverColors, setCoverColors] = useState<CoverColors | null>(null)
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<ObjectReportJobStatus | null>(null)
  const [drawing, setDrawing] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const topology = kind === "topology"
  const one = topology || target.ids.length === 1
  const many = target.ids.length > 1
  const zip = topology && many && prefs.output === "zip"
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
    () =>
      JSON.stringify(
        topology
          ? topologyRequest(target, prefs, schema, title, cover, coverColors)
          : reportRequest(target, prefs, schema, title, cover, coverColors)
      ),
    [topology, target, prefs, schema, title, cover, coverColors]
  )
  // A view's devices are known before it is drawn only on the map itself.
  const estimable =
    !topology || (target.views ?? []).every((v) => v.devices !== undefined)
  const settled = useDebounced(body, 400)
  const estimate = useQuery({
    queryKey: ["object-report-estimate", kind, settled],
    queryFn: () =>
      api<ObjectReportEstimate>(`${REPORT_PATHS[kind]}?estimate=1`, {
        method: "POST",
        body: settled,
      }),
    enabled: !limitNote && estimable,
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

  /** Each view drawn as the map's Export ▸ PDF draws it, one at a time. */
  const drawViews = async () => {
    const views = target.views ?? []
    const out: (ReportDrawing | null)[] = []
    for (const [i, v] of views.entries()) {
      if (!alive.current) return null
      setDrawing(
        views.length > 1 ? `Drawing ${i + 1} of ${views.length}…` : "Drawing…"
      )
      out.push(await v.draw())
    }
    setDrawing(null)
    return out
  }

  const run = async (print: boolean) => {
    const tab = print ? openPrintTab() : null
    let printing = false
    setBusy(true)
    try {
      writeReportPrefs(kind, prefs)
      let posted = body
      if (topology) {
        const drawn = await drawViews()
        if (!drawn) return
        if (drawn.some((d) => !d)) throw new Error("A view could not be drawn.")
        posted = JSON.stringify(
          topologyRequest(
            target,
            prefs,
            schema,
            title,
            cover,
            coverColors,
            drawn
          )
        )
      }
      const started = await api<ObjectReportStarted>(
        `${REPORT_PATHS[kind]}?print=1`,
        { method: "POST", body: posted }
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
        fileName: exportFileName(
          name,
          zip ? "zip" : "pdf",
          undefined,
          "report"
        ),
      })
      onDone()
    } catch (err) {
      if (alive.current) apiErrorToast(err, "Couldn't make the report")
    } finally {
      if (tab && !printing) tab.close()
      if (alive.current) {
        setBusy(false)
        setJob(null)
        setDrawing(null)
      }
    }
  }

  const generating =
    drawing ??
    (job?.progress != null ? `Generating… ${job.progress}%` : "Generating…")

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

  const titlePlaceholder = topology
    ? many
      ? "Topology report"
      : (target.name ?? "Topology report")
    : one && target.name
      ? `${schema.label} ${target.name}`
      : `${schema.plural} report`
  // The colours count only on a background drawn in them.
  const coverStyle =
    prefs.coverBackground === "default"
      ? (schema.cover?.background ?? "waves")
      : prefs.coverBackground
  const coloured = coverStyle === "waves" || coverStyle === "plain"

  return (
    <>
      <div className="grid gap-4">
        <FormText
          label="Title"
          value={title}
          onChange={setTitle}
          placeholder={titlePlaceholder}
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
        {topology && many && (
          <Field label="Output">
            <SegmentedTabs<"pdf" | "zip">
              items={[
                { value: "pdf", label: "One PDF" },
                { value: "zip", label: "ZIP of PDFs" },
              ]}
              value={prefs.output}
              onValueChange={(v) => set("output", v)}
            />
          </Field>
        )}
        {labels.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2" data-part="sensitivity">
            <FormCombobox
              label="Sensitivity label"
              value={prefs.sensitivityLabel}
              onChange={(v) => set("sensitivityLabel", v)}
              noneLabel="None"
              placeholder="None"
              searchPlaceholder="Search labels…"
              emptyText="No labels."
              options={labels.map((l) => ({
                value: l.id,
                label: l.name,
                color: l.color,
                icon: l.icon,
                badge: true,
              }))}
            />
          </div>
        )}
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
        <FormCheckbox
          label="Include cover page"
          checked={prefs.cover}
          onChange={(v) => set("cover", v)}
          className="items-center text-[13px] whitespace-nowrap"
        />
        {prefs.cover && (
          <div className="ml-1 grid gap-4 border-l pl-4" data-part="cover">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormText
                label="Cover title"
                value={cover.title}
                onChange={(v) => setCover((c) => ({ ...c, title: v }))}
                placeholder={title.trim() || titlePlaceholder}
              />
              <FormText
                label="Subtitle"
                value={cover.subtitle ?? coverSubtitle(target, prefs, schema)}
                onChange={(v) => setCover((c) => ({ ...c, subtitle: v }))}
              />
              <FormText
                label="Organisation or project"
                value={prefs.coverProject}
                onChange={(v) => set("coverProject", v)}
                placeholder={schema.cover?.project ?? ""}
              />
              <Field label="Background">
                <div className="grid justify-items-start gap-1.5">
                  <SegmentedTabs<ReportCoverBackground>
                    wrap
                    items={coverBackgroundItems(schema)}
                    value={prefs.coverBackground}
                    onValueChange={(v) => set("coverBackground", v)}
                  />
                  {canManage && (
                    <Link
                      to="/settings/tenant"
                      hash="report-cover"
                      className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      data-part="cover-settings-link"
                    >
                      Change cover colours…
                    </Link>
                  )}
                </div>
              </Field>
            </div>
            {coloured && (
              <CoverColorPicker value={coverColors} onChange={setCoverColors} />
            )}
          </div>
        )}
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
          disabled={busy || !!limitNote || tooLarge || zip}
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

/** This report's cover colours: the tenant's, or one of the settings
 * card's presets (Danbyte, then the palette families). */
export function CoverColorPicker({
  value,
  onChange,
}: {
  value: CoverColors | null
  onChange: (v: CoverColors | null) => void
}) {
  const picked = value
    ? COVER_PRESETS.find(
        (p) =>
          p.horizon === value.horizon &&
          p.wave === value.wave &&
          p.crest === value.crest
      )?.key
    : null
  return (
    <Field label="Cover colours" group>
      <div
        className="flex flex-wrap items-center gap-1.5"
        data-part="cover-colors"
      >
        <Button
          type="button"
          variant={value ? "outline" : "secondary"}
          size="sm"
          className="h-6 px-2 text-xs"
          aria-pressed={!value}
          onClick={() => onChange(null)}
        >
          Tenant default
        </Button>
        {COVER_PRESETS.map((p) => (
          <Tooltip key={p.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={p.label}
                aria-pressed={picked === p.key}
                className={cn(
                  "size-6 rounded-md border border-border",
                  picked === p.key &&
                    "ring-2 ring-ring ring-offset-1 ring-offset-background"
                )}
                style={{ background: p.horizon }}
                onClick={() =>
                  onChange({ horizon: p.horizon, wave: p.wave, crest: p.crest })
                }
              />
            </TooltipTrigger>
            <TooltipContent variant="panel">{p.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </Field>
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
export function useObjectReport(kind: ReportKind) {
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
 * Export menu: `target` is read on click, so it follows the list. A
 * server-paged list answers it asynchronously, with every matching id. */
export function reportExport(
  openReport: (t: ReportTarget) => void,
  target: () => ReportTarget | Promise<ReportTarget>,
  disabled = false
): ExtraExport {
  return {
    key: "pdf-report",
    label: "PDF report…",
    disabled,
    onSelect: () => {
      const t = target()
      if (t instanceof Promise) void t.then(openReport, apiErrorToast)
      else openReport(t)
    },
  }
}

/** A detail page's **PDF report…** button. */
export function ObjectReportButton({
  kind,
  id,
  name,
}: {
  kind: ReportKind
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
