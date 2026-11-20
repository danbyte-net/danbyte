import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Device,
  InventoryItemRow,
  LocationOption,
  Status,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useSiteOptions } from "@/lib/use-site-options"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCombobox,
  FormFooter,
  FormStatusSelect,
  useFieldErrors,
} from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import type { ObjectPickerSpec } from "@/components/object-picker"
import { StatusBadge } from "@/components/status-badge"

/**
 * The stock pool (docs/dcim/stock.md): where a part goes when it comes out
 * of a port or a bay - a site and location in stock, back onto its device,
 * or out as scrap or RMA.
 */

const LAST_KEY = "danbyte.stock.last-location"

/** The location last used for stock at `siteId` - a per-viewer convenience
 * kept in the browser; null when there is none or storage is blocked. */
export function lastStockLocation(siteId: string | null): string | null {
  if (!siteId) return null
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<
      string,
      string
    >
    return all[siteId] ?? null
  } catch {
    return null
  }
}

export function rememberStockLocation(
  siteId: string | null,
  locationId: string | null
) {
  if (!siteId) return
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Record<
      string,
      string | null
    >
    all[siteId] = locationId
    localStorage.setItem(LAST_KEY, JSON.stringify(all))
  } catch {
    // Storage blocked: nothing to remember.
  }
}

/** A device's site id - where its parts go to stock by default. Reads the
 * device detail (the device page's own cache). */
export function useDeviceSite(deviceId: string, enabled: boolean) {
  const q = useQuery({
    queryKey: ["device", deviceId],
    queryFn: () => api<Device>(`/api/devices/${deviceId}/`),
    enabled,
  })
  return q.data?.site?.id ?? null
}

/** The inventory-item statuses, for the status pickers. */
export function useItemStatuses(enabled = true) {
  return useQuery({
    queryKey: ["statuses", "inventoryitem"],
    queryFn: () =>
      apiAll<Status>("/api/statuses/?available_to=inventoryitem&picker=1"),
    enabled,
    staleTime: 5 * 60_000,
  })
}

/** Site and location of a stock place. */
export function StockPlaceFields({
  siteId,
  locationId,
  onSite,
  onLocation,
  errors,
}: {
  siteId: string | null
  locationId: string | null
  onSite: (id: string | null) => void
  onLocation: (id: string | null) => void
  errors: Record<string, string | undefined>
}) {
  const sites = useSiteOptions()
  const locations = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      apiAll<LocationOption>(`/api/locations/?picker=1&site=${siteId}`),
    enabled: !!siteId,
    staleTime: 5 * 60_000,
  })
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormCombobox
        label="Site"
        required
        value={siteId}
        onChange={(v) => {
          onSite(v)
          onLocation(lastStockLocation(v))
        }}
        options={sites.options.map((s) => ({ value: s.id, label: s.name }))}
        placeholder="Select a site…"
        searchPlaceholder="Search sites…"
        emptyText="No sites."
        error={errors.site_id}
      />
      <FormCombobox
        label="Location"
        value={locationId}
        onChange={onLocation}
        options={(locations.data?.results ?? []).map((l) => ({
          value: l.id,
          label: l.name,
        }))}
        noneLabel="No location"
        placeholder={siteId ? "Select a location…" : "Pick a site first"}
        searchPlaceholder="Search locations…"
        emptyText="No locations."
        disabled={!siteId}
        error={errors.location_id}
      />
    </div>
  )
}

/** "AMS · Box 3" - a stock place in words. */
export function stockPlaceText(
  r: Pick<InventoryItemRow, "site" | "location">
): string {
  return [r.site?.name, r.location?.name].filter(Boolean).join(" · ")
}

/**
 * The stock picker preset: parts in stock of `kind` - for a port, those
 * that fit its type (`fits`) - the device's site first (`nearSite`), then
 * the other sites the reader may see.
 */
export function useStockSpec({
  kind,
  fits,
  nearSite,
}: {
  kind: "transceiver" | "module"
  fits?: string
  nearSite?: string | null
}): ObjectPickerSpec<InventoryItemRow, InventoryItemRow> {
  return useMemo(() => {
    const scope = new URLSearchParams({ home: "stock", kind })
    if (fits) scope.set("fits", fits)
    if (nearSite) scope.set("near_site", nearSite)
    const qs = scope.toString()
    return {
      noun: kind,
      pickerEndpoint: `/api/inventory-items/?${qs}&picker=1`,
      pickerQueryKey: ["stock-items", kind, fits ?? "", nearSite ?? ""],
      optionLabel: (o) =>
        [o.part_id || o.name, o.serial_number].filter(Boolean).join(" · "),
      optionState: (o) => ({ hint: stockPlaceText(o) }),
      detailEndpoint: (id) => `/api/inventory-items/${id}/`,
      detailQueryKey: (id) => ["inventory-item", id],
      listEndpoint: `/api/inventory-items/?${qs}`,
      searchHint: "Search serial, part…",
      filters: [],
      columns: [
        { header: "Name", cell: (r) => r.name },
        {
          header: "Part ID",
          cell: (r) => (
            <span className="font-mono text-xs">{r.part_id || "-"}</span>
          ),
        },
        {
          header: "Serial",
          cell: (r) => (
            <span className="font-mono text-xs">{r.serial_number || "-"}</span>
          ),
        },
        {
          header: "Place",
          cell: (r) => (
            <span className="text-xs">{stockPlaceText(r) || "-"}</span>
          ),
        },
        { header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
      ],
    }
  }, [kind, fits, nearSite])
}

export type RemoveChoice = "stock" | "device" | "scrap" | "delete"

/** A removed part's way out: the request that sends it there. */
export interface RemoveTarget {
  /** POSTed `{site_id, location_id, status_id}` or `{device_id}`. */
  moveEndpoint: string
  /** DELETE - offered only where removing has always deleted (a module). */
  deleteEndpoint?: string
  deviceId: string
  /** The device's site: where stock starts. */
  siteId: string | null
}

/**
 * Remove a transceiver or a module: Move to stock (the default), Keep on
 * the device, Scrap / RMA - and, for a module, Delete as before.
 */
export function RemovePartDialog({
  open,
  onOpenChange,
  title,
  target,
  onDone,
  keepLabel = "Keep on device",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  target: RemoveTarget
  onDone: () => void
  keepLabel?: string
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [choice, setChoice] = useState<RemoveChoice>("stock")
  const [siteId, setSiteId] = useState<string | null>(target.siteId)
  const [locationId, setLocationId] = useState<string | null>(null)
  const [statusId, setStatusId] = useState<string | null>(null)
  const statuses = useItemStatuses(open)
  const statusList = statuses.data?.results ?? []

  useEffect(() => {
    if (!open) return
    setChoice("stock")
    setSiteId(target.siteId)
    setLocationId(lastStockLocation(target.siteId))
    reset()
  }, [open, target.siteId, reset])
  // Scrap / RMA starts on RMA, where the tenant still has it.
  useEffect(() => {
    if (choice !== "scrap") return
    const rma = statusList.find((s) => s.slug === "rma")
    setStatusId((cur) => cur ?? rma?.id ?? null)
  }, [choice, statusList])

  const save = useMutation({
    mutationFn: async () => {
      if (choice === "delete") {
        return api<void>(target.deleteEndpoint!, { method: "DELETE" })
      }
      const body =
        choice === "device"
          ? { device_id: target.deviceId }
          : {
              site_id: siteId,
              location_id: locationId,
              ...(choice === "scrap" && statusId
                ? { status_id: statusId }
                : {}),
            }
      return api<InventoryItemRow>(target.moveEndpoint, {
        method: "POST",
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      if (choice === "stock" || choice === "scrap") {
        rememberStockLocation(siteId, locationId)
      }
      qc.invalidateQueries({ queryKey: ["inventory"] })
      qc.invalidateQueries({ queryKey: ["stock-transceivers"] })
      toast.success(
        choice === "delete"
          ? "Removed"
          : choice === "device"
            ? "Kept on the device"
            : "Moved to stock"
      )
      onDone()
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const items: { value: RemoveChoice; label: string }[] = [
    { value: "stock", label: "Move to stock" },
    { value: "device", label: keepLabel },
    { value: "scrap", label: "Scrap / RMA" },
    ...(target.deleteEndpoint
      ? [{ value: "delete" as const, label: "Delete" }]
      : []),
  ]
  const ready =
    choice === "device" ||
    choice === "delete" ||
    (choice === "stock" && !!siteId) ||
    (choice === "scrap" && !!siteId && !!statusId)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Where the part goes
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) save.mutate()
          }}
          className="grid gap-4"
        >
          <SegmentedTabs
            label="Where it goes"
            items={items}
            value={choice}
            onValueChange={setChoice}
            wrap
          />
          {(choice === "stock" || choice === "scrap") && (
            <StockPlaceFields
              siteId={siteId}
              locationId={locationId}
              onSite={setSiteId}
              onLocation={setLocationId}
              errors={fieldErrors}
            />
          )}
          {choice === "scrap" && (
            <FormStatusSelect
              value={statusId}
              onChange={setStatusId}
              options={statusList}
              error={fieldErrors.status_id}
            />
          )}
          {choice === "delete" && (
            <p className="text-sm text-muted-foreground">
              Deletes the record with its serial.
            </p>
          )}
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={choice === "delete" ? "Delete" : "Remove"}
            submittingLabel={choice === "delete" ? "Deleting…" : "Removing…"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
