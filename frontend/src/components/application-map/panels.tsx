import { Link } from "@tanstack/react-router"
import { ArrowUpRight } from "lucide-react"

import { ColorBadge } from "@/components/cells/color-badge"
import { PanelRow, PanelSection, PanelShell } from "@/components/map-panel"
import { OpenLink } from "@/components/open-link"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import type { ApplicationFlow, FlowEnd } from "@/lib/api"
import { endHost, flowServiceLabel } from "@/lib/flows"

import type { AppBand, AppMapRef } from "./model"

// The Application map's detail panels (#163), in the maps' one panel
// layout (PanelShell): an application's facts, a host's installs, a flow
// end's flows, and a line's flows - each flow with its status pill, its
// ends and service, and a way to its application's Flows tab.

const LINK = "hover:underline"

const END_KIND: Record<FlowEnd["kind"], string> = {
  ip: "Address",
  range: "Range",
  prefix: "Prefix",
  any: "Any",
}

/** An end as a link to its object, with its device or VM. */
function EndText({ end }: { end: FlowEnd }) {
  const host = endHost(end)
  const label =
    end.kind === "any" ? (
      "Any"
    ) : end.id && end.kind === "ip" ? (
      <Link to="/ips/$id" params={{ id: end.id }} className={LINK}>
        {end.label}
      </Link>
    ) : end.id && end.kind === "prefix" ? (
      <Link to="/prefixes/$id" params={{ id: end.id }} className={LINK}>
        {end.label}
      </Link>
    ) : end.id && end.kind === "range" ? (
      <Link to="/ip-ranges/$id" params={{ id: end.id }} className={LINK}>
        {end.label}
      </Link>
    ) : (
      end.label
    )
  return (
    <span>
      <span className="font-mono">{label}</span>
      {host && <span className="text-muted-foreground"> {host.name}</span>}
    </span>
  )
}

/** One flow: its name and pill, then its facts. */
function FlowFacts({ flow: f }: { flow: ApplicationFlow }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
        {f.status && <StatusBadge status={f.status} />}
      </div>
      <PanelRow label="Source">
        <EndText end={f.source} />
      </PanelRow>
      <PanelRow label="Destination">
        <EndText end={f.destination} />
      </PanelRow>
      <PanelRow label="Service">
        <span className="font-mono">{flowServiceLabel(f)}</span>
        {f.service && (
          <span className="text-muted-foreground"> {f.service.name}</span>
        )}
      </PanelRow>
      <PanelRow label="Direction">{f.direction_display}</PanelRow>
      <PanelRow label="Application">
        <Link
          to="/applications/$id"
          params={{ id: f.application.id }}
          className={LINK}
        >
          {f.application.name}
        </Link>
      </PanelRow>
      <div className="flex justify-end pt-1">
        <Button asChild size="xs" variant="outline">
          <Link
            to="/applications/$id"
            params={{ id: f.application.id }}
            search={{ tab: "flows" }}
            aria-label={`Open ${f.name} in the Flows tab`}
          >
            <ArrowUpRight /> Flows tab
          </Link>
        </Button>
      </div>
    </div>
  )
}

/** The flows a line or an end stands for, one section each. */
function FlowList({ flows }: { flows: readonly ApplicationFlow[] }) {
  return (
    <>
      {flows.map((f) => (
        <PanelSection key={f.id} label="Flow">
          <FlowFacts flow={f} />
        </PanelSection>
      ))}
    </>
  )
}

export function CardPanel({
  refd,
  onClose,
}: {
  refd: AppMapRef
  onClose: () => void
}) {
  if (refd.kind === "application") {
    const a = refd.app
    return (
      <PanelShell
        label="Application"
        title={a.name}
        onClose={onClose}
        footer={
          <>
            <OpenLink to="/applications/$id" params={{ id: a.id }}>
              Open application
            </OpenLink>
            <OpenLink
              to="/applications/$id"
              params={{ id: a.id }}
              search={{ tab: "installs" }}
            >
              Installs
            </OpenLink>
          </>
        }
      >
        {a.path && a.path !== a.name && (
          <PanelRow label="Path">{a.path}</PanelRow>
        )}
        {a.parent && (
          <PanelRow label="Parent">
            <Link
              to="/applications/$id"
              params={{ id: a.parent.id }}
              className={LINK}
            >
              {a.parent.name}
            </Link>
          </PanelRow>
        )}
        {a.manufacturer && (
          <PanelRow label="Manufacturer">{a.manufacturer.name}</PanelRow>
        )}
        <PanelRow label="Installs">
          <span className="num">{a.install_count}</span>
        </PanelRow>
        <PanelRow label="Flows">
          <span className="num">{a.flow_count}</span>
        </PanelRow>
        <PanelRow label="Children">
          <span className="num">{a.child_count}</span>
        </PanelRow>
        {a.tags.length > 0 && (
          <PanelRow label="Tags">
            <span className="inline-flex flex-wrap justify-end gap-1">
              {a.tags.map((t) => (
                <ColorBadge key={t.id} name={t.name} color={t.color} />
              ))}
            </span>
          </PanelRow>
        )}
        {a.description && (
          <PanelSection label="Description">{a.description}</PanelSection>
        )}
      </PanelShell>
    )
  }

  if (refd.kind === "host") {
    const h = refd.host
    return (
      <PanelShell
        label={h.kind === "device" ? "Device" : "Virtual machine"}
        title={h.name}
        onClose={onClose}
        footer={
          h.kind === "device" ? (
            <OpenLink to="/devices/$id" params={{ id: h.id }}>
              Open device
            </OpenLink>
          ) : (
            <OpenLink to="/virtual-machines/$id" params={{ id: h.id }}>
              Open virtual machine
            </OpenLink>
          )
        }
      >
        <PanelRow label="Kind">
          {h.kind === "device" ? "Device" : "Virtual machine"}
        </PanelRow>
        <PanelSection label="Installed">
          {h.installs.map((i) => {
            const color = h.colors?.[i.application.id]
            return (
              <PanelRow key={i.id} label={i.version || "-"}>
                {/* The application's colour, as its card's edge and its
                    lines wear it. */}
                <span
                  className="inline-flex items-center gap-1.5"
                  data-app-color={color}
                >
                  {color && (
                    <span
                      aria-hidden
                      className="h-3.5 w-[3px] shrink-0 rounded-sm"
                      style={{ backgroundColor: color }}
                    />
                  )}
                  <Link
                    to="/applications/$id"
                    params={{ id: i.application.id }}
                    className={LINK}
                  >
                    {i.application.name}
                  </Link>
                </span>
              </PanelRow>
            )
          })}
        </PanelSection>
      </PanelShell>
    )
  }

  const e = refd.end
  const host = endHost(e)
  return (
    <PanelShell
      label="Flow end"
      title={host?.name ?? (e.kind === "any" ? "Any" : e.label)}
      onClose={onClose}
      footer={
        e.device ? (
          <OpenLink to="/devices/$id" params={{ id: e.device.id }}>
            Open device
          </OpenLink>
        ) : e.vm ? (
          <OpenLink to="/virtual-machines/$id" params={{ id: e.vm.id }}>
            Open virtual machine
          </OpenLink>
        ) : undefined
      }
    >
      <PanelRow label={END_KIND[e.kind]}>
        <EndText end={{ ...e, device: null, vm: null }} />
      </PanelRow>
      <PanelRow label="Application">
        <Link
          to="/applications/$id"
          params={{ id: refd.application.id }}
          className={LINK}
        >
          {refd.application.name}
        </Link>
      </PanelRow>
      <FlowList flows={refd.flows} />
    </PanelShell>
  )
}

export function FlowsPanel({
  flows,
  onClose,
}: {
  flows: readonly ApplicationFlow[]
  onClose: () => void
}) {
  const title = flows.length === 1 ? flows[0].name : `${flows.length} flows`
  return (
    <PanelShell label="Flows" title={title} onClose={onClose}>
      <FlowList flows={flows} />
    </PanelShell>
  )
}

/** A Flows row's title clicked: its application. */
export function BandPanel({
  band,
  flows,
  onClose,
}: {
  band: AppBand
  flows: number
  onClose: () => void
}) {
  const app = band.application
  if (!app) return null
  return (
    <PanelShell
      label="Application"
      title={app.name}
      onClose={onClose}
      footer={
        <>
          <OpenLink to="/applications/$id" params={{ id: app.id }}>
            Open application
          </OpenLink>
          <OpenLink
            to="/applications/$id"
            params={{ id: app.id }}
            search={{ tab: "flows" }}
          >
            Flows tab
          </OpenLink>
        </>
      }
    >
      {app.path && app.path !== app.name && (
        <PanelRow label="Path">{app.path}</PanelRow>
      )}
      <PanelRow label="Flows on the map">
        <span className="num">{flows}</span>
      </PanelRow>
    </PanelShell>
  )
}
