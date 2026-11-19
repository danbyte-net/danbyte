import { useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft } from "lucide-react"
import { toast } from "sonner"

import { api, formatBytes } from "@/lib/api"
import type { ModelPackLimits } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { DeleteButton } from "@/components/action-ribbon"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { TimeCell } from "@/components/cells/time-ago"
import { DataTable } from "@/components/data-table"
import { KvCard, dash, mono } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { SettingsHeader } from "@/components/settings/settings-card"
import {
  ModelPackStatusBadge,
  buildModelPackFindingColumns,
  buildModelPackPartColumns,
  buildModelPackTypeColumns,
  packLabel,
} from "@/components/columns/model-pack-columns"
import { useModelPack } from "@/components/model-pack-install-dialog"
import {
  BundleReport,
  InstallOutcomes,
  NeedsLine,
} from "@/components/model-pack-report"

type Tab = "overview" | "packs" | "types" | "models" | "checks" | "changelog"

export const Route = createFileRoute("/settings/device-library_/packs/$id")({
  component: ModelPackPage,
})

/** One 3D model pack: what it is, what installing it changed, what the
 * checker found, and its other versions. A bundle: its packs, their checks
 * and what the install did with each. */
function ModelPackPage() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>("overview")
  const [forgetting, setForgetting] = useState(false)
  const q = useModelPack(id)
  const limits = useQuery({
    queryKey: ["model-packs", "limits"],
    queryFn: () => api<ModelPackLimits>("/api/model-packs/limits/"),
  })
  const typeColumns = useMemo(() => buildModelPackTypeColumns(), [])
  const partColumns = useMemo(() => buildModelPackPartColumns(), [])
  const findingColumns = useMemo(() => buildModelPackFindingColumns(), [])

  const forget = useMutation({
    mutationFn: () => api(`/api/model-packs/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Pack forgotten")
      void qc.invalidateQueries({ queryKey: ["model-packs"] })
      void navigate({ to: "/settings/device-library" })
    },
    onError: (e) => apiErrorToast(e),
  })

  if (q.isError) return <QueryError error={q.error} />
  if (!q.data) return <Loading />
  const p = q.data
  const check = p.report.check
  const types = (p.installed_at ? p.result.types : p.report.import?.types) ?? []
  const isBundle = p.kind === "bundle"
  const outcomes = [...(p.result.requires ?? []), ...(p.result.packs ?? [])]

  return (
    <div className="max-w-6xl space-y-4">
      <Button variant="ghost" size="sm" asChild className="h-6 px-1">
        <Link to="/settings/device-library">
          <ChevronLeft className="h-3 w-3" /> Device library
        </Link>
      </Button>
      <div className="flex flex-wrap items-start gap-3">
        <SettingsHeader
          title={`${packLabel(p)} ${p.version}`.trim()}
          badge={<ModelPackStatusBadge status={p.status} />}
        />
        <div className="ml-auto">
          {limits.data?.can_install && (
            <DeleteButton label="Forget" onClick={() => setForgetting(true)} />
          )}
        </div>
      </div>
      <SegmentedTabs
        items={
          isBundle
            ? [
                { value: "overview", label: "Overview" },
                {
                  value: "packs",
                  label: "Packs",
                  count: p.report.packs?.length,
                },
                { value: "changelog", label: "Change log" },
              ]
            : [
                { value: "overview", label: "Overview" },
                { value: "types", label: "Types", count: types.length },
                {
                  value: "models",
                  label: "Models",
                  count: check?.parts.length,
                },
                {
                  value: "checks",
                  label: "Checks",
                  count: check?.findings.length,
                },
                { value: "changelog", label: "Change log" },
              ]
        }
        value={tab}
        onValueChange={setTab}
        label="Pack sections"
      />
      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-2">
          {isBundle ? (
            <KvCard
              title="Bundle"
              rows={[
                { label: "Name", value: p.name || dash },
                { label: "Bundle id", value: mono(p.slug) },
                { label: "Version", value: mono(p.version) },
                {
                  label: "Packs",
                  value: (
                    <span className="tabular-nums">
                      {p.report.packs?.length ?? 0}
                    </span>
                  ),
                },
                {
                  label: "Types",
                  value: <span className="tabular-nums">{p.types}</span>,
                },
              ]}
            />
          ) : (
            <KvCard
              title="Pack"
              rows={[
                { label: "Name", value: p.name || dash },
                { label: "Pack id", value: mono(p.slug) },
                { label: "Version", value: mono(p.version) },
                { label: "Licence", value: p.license || dash },
                { label: "Author", value: p.author || dash },
                {
                  label: "Types",
                  value: (
                    <span className="tabular-nums">
                      {types.filter((t) => t.action !== "error").length}
                    </span>
                  ),
                },
                {
                  label: "From bundle",
                  value: p.bundle ? (
                    p.bundle.id ? (
                      <Link
                        to="/settings/device-library/packs/$id"
                        params={{ id: p.bundle.id }}
                        className="link"
                      >
                        {`${p.bundle.name || p.bundle.slug} ${p.bundle.version}`.trim()}
                      </Link>
                    ) : (
                      `${p.bundle.name || p.bundle.slug} ${p.bundle.version}`.trim()
                    )
                  ) : (
                    dash
                  ),
                },
                {
                  label: "Needs",
                  value: p.needs.length ? (
                    <NeedsLine needs={p.needs} label={false} />
                  ) : (
                    dash
                  ),
                },
              ]}
            />
          )}
          <KvCard
            title="Install"
            rows={[
              {
                label: "Source",
                value:
                  p.source === "url" ? mono(p.source_url) : mono(p.filename),
              },
              { label: "Size", value: formatBytes(p.size) },
              { label: "SHA-256", value: mono(p.sha256), copy: p.sha256 },
              {
                label: "Installed",
                value: p.installed_at ? (
                  <TimeCell iso={p.installed_at} />
                ) : (
                  dash
                ),
              },
              { label: "By", value: p.installed_by || dash },
              {
                label: "Replace photos",
                value: p.installed_at
                  ? p.replace_photos
                    ? "Yes"
                    : "No"
                  : dash,
              },
              {
                label: "Update from pack",
                value: p.installed_at ? (p.overwrite ? "Yes" : "No") : dash,
              },
            ]}
          />
          {p.error && (
            <p className="text-sm text-destructive lg:col-span-2">{p.error}</p>
          )}
          {p.history.length > 0 && (
            <KvCard
              title="Other versions"
              rows={p.history.map((h) => ({
                label: h.version || "-",
                value: (
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      to="/settings/device-library/packs/$id"
                      params={{ id: h.id }}
                      className="link"
                    >
                      {h.installed_at ? (
                        <TimeCell iso={h.installed_at} />
                      ) : (
                        "Open"
                      )}
                    </Link>
                    <ModelPackStatusBadge status={h.status} />
                  </span>
                ),
              }))}
            />
          )}
        </div>
      )}
      {tab === "overview" && outcomes.length > 0 && (
        <InstallOutcomes outcomes={outcomes} />
      )}
      {tab === "packs" && <BundleReport pack={p} />}
      {tab === "types" && (
        <DataTable
          data={types}
          columns={typeColumns}
          tableId="model-pack-types"
          flexColumn="notes"
          autoColumns={false}
        />
      )}
      {tab === "models" && (
        <DataTable
          data={check?.parts ?? []}
          columns={partColumns}
          tableId="model-pack-parts"
          autoColumns={false}
        />
      )}
      {tab === "checks" && (
        <DataTable
          data={check?.findings ?? []}
          columns={findingColumns}
          tableId="model-pack-findings"
          flexColumn="message"
          autoColumns={false}
        />
      )}
      {tab === "changelog" && (
        <ChangeLogPanel objectType="api.modelpack" objectId={p.id} />
      )}

      <AlertDialog open={forgetting} onOpenChange={setForgetting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {packLabel(p)}?</AlertDialogTitle>
            <AlertDialogDescription>
              The record goes. The device and module types stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={forget.isPending}
              onClick={(e) => {
                e.preventDefault()
                forget.mutate()
              }}
            >
              {forget.isPending ? "Forgetting…" : "Forget"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
