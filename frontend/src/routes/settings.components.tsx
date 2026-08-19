import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronUp, Plus, RotateCcw, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/components")({
  component: ComponentPopoverSettings,
})

interface ComponentPopoverConfig {
  popover_fields: string[]
  is_default: boolean
  available: string[]
  defaults: string[]
}

/** Labels + hints for the server's vocabulary - an unknown key still renders
 * (raw), so a newly-added server field is never invisible here. */
const FIELD_META: Record<string, { label: string; hint: string }> = {
  name: { label: "Name", hint: "The interface, linked to its page" },
  type: { label: "Type", hint: "Connector / interface type" },
  state: {
    label: "State",
    hint: "Disabled · no cable · up with speed and cable type",
  },
  vlan: { label: "VLAN", hint: "Access VLAN, or the trunk summary" },
  live: {
    label: "Live (SNMP)",
    hint: "Observed oper status and speed, when polled",
  },
  ips: {
    label: "IP addresses",
    hint: "Up to three assigned addresses, linked",
  },
  description: { label: "Description", hint: "The interface's description" },
  mac: { label: "MAC address", hint: "The interface's MAC" },
  mtu: { label: "MTU", hint: "Configured MTU" },
  lag: { label: "LAG", hint: "The aggregation group it belongs to" },
  tags: { label: "Tags", hint: "The interface's tags" },
}

const meta = (key: string) =>
  FIELD_META[key] ?? { label: key, hint: "Server-defined field" }

/**
 * Which fields a faceplate port's hover card shows, in what order - the
 * component analogue of the floor-plan tile popover. Deployment-wide; every
 * device page's faceplate (2D) reads the same list.
 */
function ComponentPopoverSettings() {
  const qc = useQueryClient()
  const { canManageDeployment } = useMe()
  const q = useQuery({
    queryKey: ["deployment-component-popover"],
    queryFn: () =>
      api<ComponentPopoverConfig>("/api/deployment/component-popover/"),
  })

  const [fields, setFields] = useState<string[] | null>(null)
  useEffect(() => {
    if (q.data && fields === null) setFields(q.data.popover_fields)
  }, [q.data, fields])

  const save = useMutation({
    mutationFn: (next: string[]) =>
      api<ComponentPopoverConfig>("/api/deployment/component-popover/", {
        method: "PUT",
        body: JSON.stringify({ popover_fields: next }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["deployment-component-popover"], data)
      qc.invalidateQueries({ queryKey: ["component-popover"] })
      // The server answers a reset with the defaults it now falls back to -
      // reflect that rather than showing an empty list.
      setFields(data.popover_fields)
      toast.success("Popover fields saved")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data || fields === null)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>

  const remaining = q.data.available.filter((k) => !fields.includes(k))
  const commit = (next: string[]) => {
    setFields(next)
    save.mutate(next)
  }
  const move = (i: number, by: number) => {
    const next = [...fields]
    const [f] = next.splice(i, 1)
    next.splice(i + by, 0, f)
    commit(next)
  }

  return (
    <div className="max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-base font-semibold">Component popover</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          What hovering a port on a device faceplate shows, top to bottom. A
          field with no value on that port simply doesn't render, so a rich list
          costs nothing on sparse interfaces. Deployment-wide.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        {fields.map((key, i) => (
          <div
            key={key}
            className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">
                {meta(key).label}
              </span>
              <span className="block truncate text-[11.5px] text-muted-foreground">
                {meta(key).hint}
              </span>
            </span>
            {canManageDeployment && (
              <span className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={i === 0}
                  title="Move up"
                  onClick={() => move(i, -1)}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={i === fields.length - 1}
                  title="Move down"
                  onClick={() => move(i, 1)}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  title="Remove"
                  onClick={() => commit(fields.filter((k) => k !== key))}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </span>
            )}
          </div>
        ))}
        {fields.length === 0 && (
          <p className="px-3 py-4 text-[13px] text-muted-foreground">
            No fields - the popover falls back to the defaults.
          </p>
        )}
      </div>

      {canManageDeployment && (
        <div className="space-y-2">
          {remaining.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {remaining.map((key) => (
                <Button
                  key={key}
                  variant="outline"
                  size="sm"
                  title={meta(key).hint}
                  onClick={() => commit([...fields, key])}
                >
                  <Plus className="h-3 w-3" /> {meta(key).label}
                </Button>
              ))}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => commit([])}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
          </Button>
        </div>
      )}
    </div>
  )
}
