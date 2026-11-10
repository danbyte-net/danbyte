import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Wand2 } from "lucide-react"
import { toast } from "sonner"

import { ApiError, api } from "@/lib/api"
import type { VulnVersionScheme } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import {
  bestConfidence,
  bulkPayload,
  coverage,
  nextStep,
  preselect,
  rowErrors,
} from "@/lib/vuln-suggestions"
import type {
  BulkCreateResult,
  MappingSuggestion,
  SuggestionSubject,
  SuggestionsPage,
} from "@/lib/vuln-suggestions"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { buildSuggestionColumns } from "@/components/columns/vulnerability-suggestion-columns"
import { MappingDialog } from "@/components/vulnerabilities/mapping-card"
import { useVulnSettings } from "@/components/vulnerabilities/use-vuln-settings"

// Suggest mappings (#451): every unmapped platform, application and device
// type in use, with a proposed product, ticked when the proposal is high
// confidence; "Create N mappings" maps the ticked ones in one request.

const PAGE = 1000
export const SUGGESTIONS_KEY = ["vulnerabilities", "mapping-suggestions"]

type TypeFilter = "all" | SuggestionSubject
type ConfFilter = "all" | "high" | "medium" | "low" | "none"

const TYPES: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "platform", label: "Platforms" },
  { value: "application", label: "Applications" },
  { value: "device_type", label: "Device types" },
]

const CONFIDENCES: { value: ConfFilter; label: string }[] = [
  { value: "all", label: "Any" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "No candidate" },
]

/** Whoever may change a platform, application or device type. */
export function useCanSuggestMappings(): boolean {
  const { canDo } = useMe()
  return (
    canDo("platform", "change") ||
    canDo("application", "change") ||
    canDo("devicetype", "change")
  )
}

export function SuggestMappingsButton({
  variant = "outline",
}: {
  variant?: "outline" | "default"
}) {
  const settings = useVulnSettings()
  const can = useCanSuggestMappings()
  const [open, setOpen] = useState(false)
  if (!settings.enabled || !can) return null
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Wand2 className="h-3.5 w-3.5" /> Suggest mappings
      </Button>
      {open && <SuggestMappingsDialog onOpenChange={setOpen} />}
    </>
  )
}

export function SuggestMappingsDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [nvd, setNvd] = useState(0)
  const q = useQuery({
    queryKey: [...SUGGESTIONS_KEY, nvd],
    queryFn: () =>
      api<SuggestionsPage>(
        `/api/vulnerabilities/mappings/suggestions/?page_size=${PAGE}${nvd ? "&nvd=true" : ""}`
      ),
    placeholderData: (prev) => prev,
  })
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [schemes, setSchemes] = useState<Record<string, VulnVersionScheme>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [type, setType] = useState<TypeFilter>("all")
  const [conf, setConf] = useState<ConfFilter>("all")
  const [picker, setPicker] = useState<MappingSuggestion | null>(null)

  // Ticked once, when the rows first arrive; later answers (an NVD lookup, a
  // row mapped by hand) keep what the operator chose.
  useEffect(() => {
    if (q.data && selected === null) setSelected(preselect(q.data.results))
  }, [q.data, selected])
  const ticked = useMemo(() => {
    const ids = new Set(rows.map((r) => r.id))
    return new Set([...(selected ?? [])].filter((id) => ids.has(id)))
  }, [rows, selected])

  const shown = useMemo(
    () =>
      rows.filter(
        (r) =>
          (type === "all" || r.subject_type === type) &&
          (conf === "all" || bestConfidence(r) === conf)
      ),
    [rows, type, conf]
  )
  const selectable = shown.filter((r) => r.candidates.length)
  const tickedShown = selectable.filter((r) => ticked.has(r.id)).length
  const allState: boolean | "indeterminate" =
    tickedShown === 0
      ? false
      : tickedShown === selectable.length
        ? true
        : "indeterminate"

  const columns = useMemo(
    () =>
      buildSuggestionColumns({
        selected: ticked,
        onToggle: (id, on) =>
          setSelected((prev) => {
            const next = new Set(prev ?? [])
            if (on) next.add(id)
            else next.delete(id)
            return next
          }),
        onToggleAll: (on) =>
          setSelected((prev) => {
            const next = new Set(prev ?? [])
            for (const r of selectable)
              if (on) next.add(r.id)
              else next.delete(r.id)
            return next
          }),
        allState,
        picked,
        onPickCandidate: (id, identifier) =>
          setPicked((p) => ({ ...p, [id]: identifier })),
        schemes,
        onScheme: (id, scheme) => setSchemes((p) => ({ ...p, [id]: scheme })),
        onOpenPicker: setPicker,
        errors,
      }),
    [ticked, selectable, allState, picked, schemes, errors]
  )

  const payload = bulkPayload(rows, ticked, picked, schemes)
  const { covered, blank } = coverage(rows, ticked)

  const create = useMutation({
    mutationFn: () =>
      api<BulkCreateResult>("/api/vulnerabilities/mappings/bulk-create/", {
        method: "POST",
        body: JSON.stringify(payload.body),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["vulnerabilities"] })
      qc.invalidateQueries({ queryKey: ["vulnerability-coverage"] })
      const n = res.created.length
      const fetched = res.created
        .map((m) => m.identifier)
        .filter((id) => !id.startsWith("cpe:2.3:h:"))
      toast.success(`Created ${n} ${n === 1 ? "mapping" : "mappings"}`, {
        description: fetched.length
          ? nextStep(res.update_source, fetched)
          : undefined,
        action:
          res.update_source === "browser"
            ? {
                label: "Sync now",
                onClick: () => nav({ to: "/settings/vulnerabilities/sync" }),
              }
            : undefined,
      })
      onOpenChange(false)
    },
    onError: (e) => {
      if (e instanceof ApiError && e.body && typeof e.body === "object") {
        const per = rowErrors(
          (e.body as { errors?: unknown }).errors,
          payload.ids
        )
        if (Object.keys(per).length) {
          setErrors(per)
          toast.error(
            `${Object.keys(per).length} could not be mapped; nothing was created`
          )
          return
        }
      }
      apiErrorToast(e)
    },
  })

  const data = q.data
  const n = payload.body.length
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="6xl">
        <DialogHeader>
          <DialogTitle>Suggest mappings</DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <Loading />
        ) : q.isError ? (
          <QueryError error={q.error} />
        ) : !rows.length ? (
          <EmptyState title="Nothing to suggest">
            Everything in use is mapped.
          </EmptyState>
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedTabs
                items={TYPES}
                value={type}
                onValueChange={setType}
              />
              <SegmentedTabs
                items={CONFIDENCES}
                value={conf}
                onValueChange={setConf}
              />
              {data && data.nvd_pending > 0 && data.nvd_status !== "off" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={q.isFetching}
                  onClick={() => setNvd((v) => v + 1)}
                >
                  {q.isFetching && nvd
                    ? "Searching…"
                    : `Search NVD for ${data.nvd_pending}`}
                </Button>
              )}
              {data?.nvd_status === "limited" && (
                <span className="text-xs whitespace-nowrap text-muted-foreground">
                  NVD limit reached; try again in {data.retry_after ?? 30} s
                </span>
              )}
            </div>
            <DataTable
              data={shown}
              columns={columns}
              tableId="vulnerability-mapping-suggestions"
              embedded
              enableExport={false}
              flexColumn="product"
              total={data && data.count > rows.length ? data.count : undefined}
            />
          </div>
        )}
        <DialogFooter className="items-center">
          {n > 0 && (
            <span className="mr-auto text-xs whitespace-nowrap text-muted-foreground">
              Covers {covered}
              {blank > 0 && ` · ${blank} without a version cannot match`}
            </span>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!n || create.isPending}
            onClick={() => {
              setErrors({})
              create.mutate()
            }}
          >
            {create.isPending
              ? "Creating…"
              : `Create ${n} ${n === 1 ? "mapping" : "mappings"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
      {picker && (
        <MappingDialog
          subject={picker.subject_type}
          object={picker}
          mapping={null}
          first
          onOpenChange={(o) => !o && setPicker(null)}
        />
      )}
    </Dialog>
  )
}
