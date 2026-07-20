import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  BookOpenText,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"

import {
  api,
  type DeviceComplianceStatus,
  type DeviceComplianceViolation,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { Markdown } from "@/components/markdown"
import { QueryError } from "@/components/query-error"
import { SEV_VARIANT, ruleSummary } from "@/routes/compliance"

export const Route = createFileRoute("/devices/$id_/compliance")({
  component: DeviceCompliancePage,
})

function DeviceCompliancePage() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["device-compliance", id],
    queryFn: () =>
      api<DeviceComplianceStatus>(`/api/compliance/devices/${id}/`),
    refetchOnWindowFocus: false,
  })
  const d = q.data

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-1.5 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <Button variant="ghost" size="sm" asChild className="h-6 px-1">
          <Link to="/devices/$id" params={{ id }}>
            <ChevronLeft className="h-3 w-3" />
            {d?.device.name ?? "Device"}
          </Link>
        </Button>
        <ChevronRight className="h-3 w-3 opacity-60" />
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Compliance
        </h1>
        {d && !d.all_clear && (
          <Badge variant="destructive" className="ml-2">
            {d.total} violation{d.total === 1 ? "" : "s"}
          </Badge>
        )}
        {d && d.all_clear && (
          <Badge variant="success" className="ml-2">
            Compliant
          </Badge>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`}
          />
          Re-evaluate
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        <div className="mx-auto max-w-4xl space-y-3">
          {q.isLoading && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {q.isError && <QueryError error={q.error} />}

          {d && d.all_clear && (
            <EmptyState title="All green — no violations.">
              {d.device.name} passes every enabled compliance rule.
            </EmptyState>
          )}

          {d && !d.all_clear && (
            <>
              <p className="text-sm text-muted-foreground">
                {d.device.name} currently fails {d.total} rule
                {d.total === 1 ? "" : "s"}.
              </p>
              {d.violations.map((v) => (
                <ViolationCard key={v.rule_id} v={v} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** One failed rule: severity, what the rule asserts, and (expandable) its
 * Markdown remediation guide. */
function ViolationCard({ v }: { v: DeviceComplianceViolation }) {
  const [open, setOpen] = useState(false)
  const isDrift = v.rule_id === "config-drift"

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Badge variant={SEV_VARIANT[v.severity]} className="capitalize">
          {v.severity}
        </Badge>
        {isDrift ? (
          <Link to="/config-drift" className="font-medium hover:underline">
            {v.rule_name}
          </Link>
        ) : (
          <Link
            to="/compliance-rules/$id"
            params={{ id: v.rule_id }}
            className="font-medium hover:underline"
          >
            {v.rule_name}
          </Link>
        )}
        {!isDrift && (
          <span className="font-mono text-xs text-muted-foreground">
            {ruleSummary(v)}
          </span>
        )}
        {v.remediation && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 gap-1 text-muted-foreground"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <BookOpenText className="h-3.5 w-3.5" />
            How to fix
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            />
          </Button>
        )}
      </div>
      {v.description && (
        <p className="px-4 pb-3 text-[13px] text-muted-foreground">
          {v.description}
        </p>
      )}
      {open && v.remediation && (
        <div className="border-t border-border px-4 py-3">
          <Markdown source={v.remediation} />
        </div>
      )}
    </div>
  )
}
