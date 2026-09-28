import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronUp, Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Device, TopologyCardConfig } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useSaveObject } from "@/lib/save-object"
import { ColorBadge } from "@/components/cells/color-badge"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  FieldListEditor,
  useCustomFieldMeta,
} from "@/components/settings/field-list-editor"
import type { FieldMeta } from "@/components/settings/field-list-editor"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InfoTip } from "@/components/ui/info-tip"
import { Switch } from "@/components/ui/switch"
import {
  cardLineOptions,
  inheritedCardLines,
  rolesWithOwnLines,
} from "./card-lines"

/**
 * Card lines below the admin tiers: a device's own list (the device form and
 * the map's "Card lines…" dialog) and a saved view's (the Diagram's Display
 * popover). Each is Inherit or Custom; Custom holds an ordered list, and an
 * empty one - Name only - is a choice of its own, not "inherit".
 */

const CF_MODELS = ["device"] as const

/** The effective card lines for the active tenant, readable by any member.
 * Settings → Topology invalidates this key on save. */
export function useCardLineConfig(enabled = true) {
  return useQuery({
    queryKey: ["topology-card"],
    queryFn: () => api<TopologyCardConfig>("/api/topology-card/"),
    staleTime: 60_000,
    enabled,
  })
}

type Mode = "inherit" | "custom"

export function CardLinesEditor({
  value,
  onChange,
  config,
  inherited,
  from,
  compact = false,
  info,
}: {
  /** This level's own list; null inherits. */
  value: string[] | null
  onChange: (next: string[] | null) => void
  /** The vocabulary; undefined while it loads. */
  config: TopologyCardConfig | undefined
  /** What this level shows while it inherits. */
  inherited: string[]
  /** Where `inherited` comes from. */
  from: React.ReactNode
  /** The Display popover: no hints, and the add picker opens on demand. */
  compact?: boolean
  info?: React.ReactNode
}) {
  // Hidden custom fields never reach a card, so they are not offered.
  const cfMeta = useCustomFieldMeta(CF_MODELS, { skipHidden: true })
  // What a switch put aside, to give back when it is switched back: the
  // custom list before Inherit, the list before Name only.
  const stash = useRef<{ custom?: string[]; list?: string[] }>({})
  const [adding, setAdding] = useState(false)

  if (!config) return <Loading />

  const opts = cardLineOptions(config.available, cfMeta)
  const meta = compact
    ? (k: string): FieldMeta => ({ label: opts.meta(k).label, hint: "" })
    : opts.meta
  const custom = value !== null
  const shown = value ?? inherited
  const max = config.max_fields
  const nameOnly = custom && value.length === 0

  const setMode = (m: Mode) => {
    if (m === "custom") {
      if (!custom) onChange(stash.current.custom ?? [...inherited])
      return
    }
    if (custom) {
      stash.current.custom = value
      onChange(null)
    }
  }
  const setNameOnly = (on: boolean) => {
    if (!custom) return
    if (on) {
      if (value.length) stash.current.list = value
      onChange([])
      return
    }
    onChange(
      stash.current.list ?? (inherited.length ? inherited : config.defaults)
    )
  }

  return (
    <div className="grid gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <SegmentedTabs<Mode>
          value={custom ? "custom" : "inherit"}
          onValueChange={setMode}
          items={[
            { value: "inherit", label: "Inherit" },
            { value: "custom", label: "Custom" },
          ]}
        />
        {info && <InfoTip>{info}</InfoTip>}
        {custom && (
          <span className="ml-auto text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
            {value.length} of {max}
          </span>
        )}
      </div>

      {custom ? (
        <label className="flex items-center gap-2 text-[13px] whitespace-nowrap">
          <Switch
            size="sm"
            checked={nameOnly}
            onCheckedChange={setNameOnly}
            aria-label="Name only"
          />
          Name only
        </label>
      ) : (
        <p className="flex min-w-0 items-center gap-1.5 text-[11px] whitespace-nowrap text-muted-foreground">
          From {from}
        </p>
      )}

      <div>
        <FieldListEditor
          value={shown}
          onChange={onChange}
          editable={custom}
          meta={meta}
          groups={compact && !adding ? [] : opts.groups}
          available={opts.available}
          empty={
            compact ? "Just the name" : "The card shows just the device name."
          }
          max={max}
        />
        {compact && custom && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={!adding && value.length >= max}
            onClick={() => setAdding((a) => !a)}
          >
            {adding ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {adding ? "Done" : "Add line"}
          </Button>
        )}
      </div>
    </div>
  )
}

/** The Display popover's section: this saved view's own lines, over every
 * device's role and All devices lines (a device's own still wins). */
export function ViewCardLinesEditor({
  value,
  onChange,
}: {
  value: string[] | null
  onChange: (next: string[] | null) => void
}) {
  const config = useCardLineConfig()
  const cfg = config.data
  const differ = cfg ? rolesWithOwnLines(cfg) : 0
  return (
    <CardLinesEditor
      compact
      value={value}
      onChange={onChange}
      config={cfg}
      inherited={cfg?.fields ?? []}
      from={
        <>
          All devices
          {differ > 0 && (
            <span>
              · {differ} {differ === 1 ? "role differs" : "roles differ"}
            </span>
          )}
        </>
      }
      info="For this view. Inherit uses each device's role lines, else All devices; a device's own lines still win."
    />
  )
}

/** The device a "Card lines…" dialog edits, as the map knows it. */
export interface CardLinesTarget {
  id: string
  name: string
  role?: { slug?: string; name: string; color?: string } | null
}

/** One device's own card lines, from the map's context menu. Saved on the
 * device (PATCH `topology_card`, `device.change`), so every map shows it. */
export function CardLinesDialog({
  target,
  viewFields,
  onClose,
}: {
  target: CardLinesTarget | null
  /** The view's own lines, which the device inherits first. */
  viewFields?: string[] | null
  onClose: () => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Card lines</DialogTitle>
          <DialogDescription className="font-mono">
            {target?.name}
          </DialogDescription>
        </DialogHeader>
        {target && (
          <DeviceCardLines
            key={target.id}
            target={target}
            viewFields={viewFields ?? null}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DeviceCardLines({
  target,
  viewFields,
  onClose,
}: {
  target: CardLinesTarget
  viewFields: string[] | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const saveObject = useSaveObject()
  const config = useCardLineConfig()
  const device = useQuery({
    queryKey: ["device", target.id],
    queryFn: () => api<Device>(`/api/devices/${target.id}/`),
  })
  // undefined = untouched: the device's saved list.
  const [draft, setDraft] = useState<string[] | null | undefined>(undefined)

  const save = useMutation({
    mutationFn: (topology_card: string[] | null) =>
      saveObject<Device>({
        objectType: "api.device",
        endpoint: "/api/devices/",
        id: target.id,
        payload: { topology_card },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["topology"] })
      toast.success("Card lines updated")
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })

  const savedList = device.data?.topology_card ?? null
  const value = draft === undefined ? savedList : draft
  const dirty =
    draft !== undefined && JSON.stringify(draft) !== JSON.stringify(savedList)
  const inh = config.data
    ? inheritedCardLines(config.data, target.role?.slug, viewFields)
    : null
  const from =
    inh?.from.level === "view" ? (
      "this view"
    ) : inh?.from.level === "role" && target.role ? (
      <ColorBadge name={target.role.name} color={target.role.color} />
    ) : (
      "All devices"
    )

  return (
    <>
      {/* A set width: the dialog fits its content, and the add picker's
          chip rows would otherwise widen it as Custom opens. */}
      <div className="w-[min(33rem,calc(100vw-5rem))]">
        {device.isError ? (
          <QueryError error={device.error} />
        ) : !device.data ? (
          <Loading />
        ) : (
          <CardLinesEditor
            value={value}
            onChange={setDraft}
            config={config.data}
            inherited={inh?.fields ?? []}
            from={from}
            info="Saved on the device, so every map shows it."
          />
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!dirty || save.isPending || !device.data}
          onClick={() => save.mutate(value)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  )
}
