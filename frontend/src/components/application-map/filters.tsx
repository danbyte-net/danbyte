import { Filter, X } from "lucide-react"

import { BarMenuTrigger } from "@/components/map-toolbar"
import { PopoverField } from "@/components/topology/filters-popover"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import { MultiCombobox } from "@/components/ui/multi-combobox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  Application,
  ApplicationFlow,
  FlowProtocol,
  InstalledSoftware,
  Status,
} from "@/lib/api"
import { FLOW_PROTOCOLS } from "@/lib/flows"

import type { AppMapView } from "./model"
import { activeFilters } from "./use-app-map"
import type { AppMapFilters } from "./use-app-map"

// The Application map's Filters (#163): applications (several), and for
// the flows a status, a protocol and a host - the flows touching it; the
// Tree keeps the applications installed on that host. Each has its Any.

/** The hosts a filter can name: every device and VM with an install or
 * at a flow's end, by name. */
export function hostOptions(
  installs: readonly InstalledSoftware[],
  flows: readonly ApplicationFlow[]
): { value: string; label: string; group: string }[] {
  const out = new Map<string, { value: string; label: string; group: string }>()
  const add = (kind: "device" | "vm", id: string, name: string) =>
    out.set(`${kind}:${id}`, {
      value: `${kind}:${id}`,
      label: name,
      group: kind === "device" ? "Devices" : "Virtual machines",
    })
  for (const i of installs) {
    if (i.device) add("device", i.device.id, i.device.name)
    else if (i.virtual_machine)
      add("vm", i.virtual_machine.id, i.virtual_machine.name)
  }
  for (const f of flows)
    for (const e of [f.source, f.destination]) {
      if (e.device) add("device", e.device.id, e.device.name)
      else if (e.vm) add("vm", e.vm.id, e.vm.name)
    }
  return [...out.values()].sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      a.label.localeCompare(b.label, undefined, { numeric: true })
  )
}

export function AppMapFiltersPopover({
  view,
  value,
  onChange,
  applications,
  statuses,
  hosts,
}: {
  view: AppMapView
  value: AppMapFilters
  onChange: (patch: Partial<AppMapFilters>) => void
  applications: readonly Application[]
  statuses: readonly Status[]
  hosts: ReturnType<typeof hostOptions>
}) {
  const active = activeFilters(value, view)
  const picked = new Set(value.applications)
  const byId = new Map(applications.map((a) => [a.id, a]))
  const flows = view === "flows"
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarMenuTrigger>
          <Filter /> Filters
          {active > 0 && (
            <Badge variant="secondary" className="num h-4 px-1 text-[10px]">
              {active}
            </Badge>
          )}
        </BarMenuTrigger>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3">
        <PopoverField label="Applications">
          <MultiCombobox
            options={applications
              .filter((a) => !picked.has(a.id))
              .map((a) => ({ value: a.id, label: a.path || a.name }))}
            onAdd={(rows) =>
              onChange({
                applications: [
                  ...value.applications,
                  ...rows.map((r) => r.value),
                ],
              })
            }
            placeholder="Any application"
            searchPlaceholder="Search applications…"
            className="h-8 w-full text-xs"
          />
          {value.applications.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {value.applications.map((id) => (
                <Badge key={id} variant="secondary" className="gap-1">
                  {byId.get(id)?.name ?? "Application"}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="opacity-80 hover:opacity-100"
                        aria-label="Remove"
                        onClick={() =>
                          onChange({
                            applications: value.applications.filter(
                              (x) => x !== id
                            ),
                          })
                        }
                      >
                        <X className="size-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" variant="default">
                      Remove
                    </TooltipContent>
                  </Tooltip>
                </Badge>
              ))}
            </div>
          )}
        </PopoverField>
        {flows && (
          <>
            <PopoverField label="Status">
              <Combobox
                value={value.status || null}
                onChange={(v) => onChange({ status: v ?? "" })}
                options={statuses.map((s) => ({
                  value: s.id,
                  label: s.name,
                  color: s.color || null,
                  badge: true,
                }))}
                noneLabel="Any status"
                placeholder="Any status"
                className="h-8 w-full text-xs"
              />
            </PopoverField>
            <PopoverField label="Protocol">
              <Combobox
                value={value.protocol || null}
                onChange={(v) =>
                  onChange({ protocol: (v ?? "") as FlowProtocol | "" })
                }
                options={FLOW_PROTOCOLS.map((p) => ({
                  value: p.value,
                  label: p.label,
                }))}
                noneLabel="Any protocol"
                placeholder="Any protocol"
                className="h-8 w-full text-xs"
              />
            </PopoverField>
          </>
        )}
        <PopoverField label={flows ? "Touching host" : "Installed on"}>
          <Combobox
            value={value.host || null}
            onChange={(v) => onChange({ host: v ?? "" })}
            options={hosts}
            noneLabel="Any host"
            placeholder="Any host"
            className="h-8 w-full text-xs"
          />
        </PopoverField>
        {active > 0 && (
          <Button
            size="xs"
            variant="outline"
            className="w-full"
            onClick={() =>
              onChange({
                applications: [],
                status: "",
                protocol: "",
                host: "",
              })
            }
          >
            Clear filters
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
