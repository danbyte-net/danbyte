import { createFileRoute, Link } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Activity } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Device,
  type Service,
  type ServiceMonitorResponse,
  type VirtualMachine,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/services/$id")({
  component: ServiceDetail,
})

function ServiceDetail() {
  const { id } = Route.useParams()
  const query = useQuery({
    queryKey: ["service", id],
    queryFn: () => api<Service>(`/api/services/${id}/`),
  })

  if (query.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (query.isError)
    return (
      <div className="p-6">
        <QueryError error={query.error} />
      </div>
    )
  if (!query.data) return null
  return <ServiceDetailBody service={query.data} />
}

function ServiceDetailBody({ service: s }: { service: Service }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">("overview")
  const { humanIds } = useMe()

  // The monitor endpoint resolves the target IP as: the service's own IP,
  // else the parent device/VM's primary IP. The Service payload only carries
  // the parent's id+name, so fetch the parent to learn whether it has a
  // primary IP — but only when the service has no IP of its own.
  const needsParent = !s.ip_address && !!(s.device || s.virtual_machine)
  const parentQuery = useQuery({
    queryKey: ["service-parent", s.device?.id ?? s.virtual_machine?.id],
    // Device and VirtualMachine share the same `primary_ip` shape — narrow to
    // that so the union return type doesn't trip up the query generics.
    queryFn: (): Promise<Pick<Device, "primary_ip">> =>
      s.device
        ? api<Device>(`/api/devices/${s.device.id}/`)
        : api<VirtualMachine>(
            `/api/virtual-machines/${s.virtual_machine!.id}/`
          ),
    enabled: needsParent,
  })

  const parentPrimaryIp = parentQuery.data?.primary_ip ?? null
  const resolvableIp =
    s.ip_address?.ip_address ?? parentPrimaryIp?.ip_address ?? null
  // Until the parent fetch settles we don't yet know if a primary IP exists,
  // so don't claim "no IP" — keep the button busy rather than show the wrong
  // tooltip and then flip to enabled.
  const resolvingParent = needsParent && parentQuery.isPending
  const canMonitor = !!resolvableIp

  const monitor = useMutation({
    mutationFn: () =>
      api<ServiceMonitorResponse>(`/api/services/${s.id}/monitor/`, {
        method: "POST",
      }),
    onSuccess: (data) =>
      toast.success(
        `Monitoring ${data.monitored} port${
          data.monitored === 1 ? "" : "s"
        } on ${data.ip}`
      ),
    onError: (err) => apiErrorToast(err),
  })

  const detailRows: KvRow[] = [
    ...(humanIds && s.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{s.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Protocol",
      value: <Badge variant="secondary">{s.protocol_display}</Badge>,
      copy: s.protocol_display,
    },
    {
      label: "Ports",
      value: s.ports.length ? (
        <span className="font-mono text-[13px]">{s.ports.join(", ")}</span>
      ) : (
        dash
      ),
      copy: s.ports.join(", "),
    },
    {
      label: "IP",
      value: s.ip_address ? (
        <Link
          to="/ips/$id"
          params={{ id: s.ip_address.id }}
          className="font-mono text-[13px] hover:underline"
        >
          {s.ip_address.ip_address}
        </Link>
      ) : (
        dash
      ),
      copy: s.ip_address?.ip_address ?? "",
    },
    {
      label: "Parent",
      value: s.device ? (
        <Link
          to="/devices/$id"
          params={{ id: s.device.id }}
          className="hover:underline"
        >
          {s.device.name}
        </Link>
      ) : s.virtual_machine ? (
        <Link
          to="/virtual-machines/$id"
          params={{ id: s.virtual_machine.id }}
          className="hover:underline"
        >
          {s.virtual_machine.name}
        </Link>
      ) : (
        dash
      ),
      copy: s.device?.name ?? s.virtual_machine?.name ?? "",
    },
    {
      label: "Description",
      value: s.description || dash,
      copy: s.description,
    },
  ]

  const cfEntries = Object.entries(s.custom_fields ?? {}).filter(
    ([k]) => k && !k.startsWith("_")
  )
  const customFieldRows: KvRow[] = cfEntries.map(([k, v]) => ({
    label: k,
    value: renderCustomValue(v),
    copy: typeof v === "string" ? v : JSON.stringify(v),
  }))

  return (
    <DetailShell
      backTo="/services"
      backLabel="Services"
      title={s.name}
      presence={{ type: "service", id: s.id }}
      actions={
        <MonitorButton
          pending={monitor.isPending}
          busy={resolvingParent}
          disabledReason={
            canMonitor || resolvingParent
              ? undefined
              : "No IP to monitor — set the service's IP or a primary IP on its device / VM."
          }
          onClick={() => monitor.mutate()}
        />
      }
      hero={
        <>
          {/* Overview strip — name + protocol/ports, tags, description. */}
          <section className="flex shrink-0 flex-col gap-3 border-b border-border px-6 py-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {s.name}
              </h1>
              <Badge variant="secondary">{s.protocol_display}</Badge>
              {s.ports.length > 0 && (
                <span className="font-mono text-sm text-muted-foreground">
                  {s.ports.join(", ")}
                </span>
              )}
            </div>
            {s.tags.length > 0 && <TagList tags={s.tags} />}
            {s.description && (
              <p className="max-w-prose text-sm leading-relaxed text-foreground">
                {s.description}
              </p>
            )}
          </section>
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        {/* Summary — details, custom fields, timestamps. */}
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Details" rows={detailRows} />
          {customFieldRows.length > 0 && (
            <KvCard title="Custom fields" rows={customFieldRows} />
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="text-muted-foreground/70">Created</span>
            <TimeCell iso={s.created_at} />
          </span>
          <span className="flex items-center gap-1">
            <span className="text-muted-foreground/70">Updated</span>
            <TimeCell iso={s.updated_at} />
          </span>
        </div>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.service" objectId={s.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.service" objectId={s.id} />
      </DetailTab>
    </DetailShell>
  )
}

function MonitorButton({
  pending,
  busy,
  disabledReason,
  onClick,
}: {
  /** The monitor mutation is in flight. */
  pending: boolean
  /** The parent fetch hasn't settled yet — disable, but don't blame the IP. */
  busy: boolean
  /** When set, the button is disabled and this text is shown in a tooltip. */
  disabledReason?: string
  onClick: () => void
}) {
  const disabled = pending || busy || !!disabledReason
  const btn = (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <Activity className="h-3.5 w-3.5" />
      {pending ? "Monitoring…" : "Monitor"}
    </Button>
  )
  // Only the "no resolvable IP" case gets a tooltip explaining why. Disabled
  // buttons don't fire pointer events, so the tooltip trigger needs a
  // focusable/hoverable span wrapper.
  if (!disabledReason) return btn
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            {btn}
          </span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function renderCustomValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === "") {
    return dash
  }
  if (typeof v === "boolean") {
    return v ? (
      <Badge variant="secondary">true</Badge>
    ) : (
      <Badge variant="outline">false</Badge>
    )
  }
  if (typeof v === "number") return <span className="num">{v}</span>
  if (typeof v === "string") return v
  return (
    <span className="font-mono text-xs text-muted-foreground">
      {JSON.stringify(v)}
    </span>
  )
}
