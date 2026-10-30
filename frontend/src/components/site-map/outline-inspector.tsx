import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Trash2, X } from "lucide-react"

import type {
  LocationPick,
  LocationTypeRef,
  SiteMapOutline,
  SiteMapOutlineWritePayload,
  SiteMapSite,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Field,
  FormCheckbox,
  FormColor,
  FormCombobox,
  QuickAddDialog,
} from "@/components/forms"

import type { Pt } from "./outline-geometry"

/** The type a location made from the map gets: the catalog's "Building",
 * when there is one. Matched by slug, then by name. */
export function buildingType<T extends LocationTypeRef & { slug?: string }>(
  types: T[] | undefined
): T | null {
  const list = types ?? []
  return (
    list.find((t) => t.slug === "building") ??
    list.find((t) => t.name.trim().toLowerCase() === "building") ??
    null
  )
}

/** The Location picker for an outline: locations of its site as their
 * colour badges, and "+" to make one (typed Building when that type
 * exists). */
export function OutlineLocationField({
  siteId,
  value,
  onChange,
  error,
}: {
  siteId: string | null
  value: string | null
  onChange: (id: string | null, created?: { id: string; name: string }) => void
  error?: string
}) {
  const qc = useQueryClient()
  const locs = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      apiAll<LocationPick>(
        `/api/locations/?${new URLSearchParams({ picker: "1", site: siteId ?? "" }).toString()}`
      ),
    enabled: !!siteId,
    staleTime: 60_000,
  })
  const types = useQuery({
    queryKey: ["location-types-picker"],
    queryFn: () => apiAll<LocationTypeRef>("/api/location-types/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const building = buildingType(types.data?.results)
  return (
    <FormCombobox
      label="Location"
      value={value}
      onChange={(v) => onChange(v)}
      options={(locs.data?.results ?? []).map((l) => ({
        value: l.id,
        label: l.name,
        color: l.color,
      }))}
      noneLabel="No location"
      placeholder={siteId ? "Select a location…" : "Pick a site first"}
      searchPlaceholder="Search locations…"
      emptyText="No locations at this site."
      error={error}
      quickAdd={
        siteId ? (
          <QuickAddDialog
            title={
              building ? `New ${building.name.toLowerCase()}` : "New location"
            }
            endpoint="/api/locations/"
            fixed={{
              site_id: siteId,
              ...(building ? { location_type_id: building.id } : {}),
            }}
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "code", label: "Code", placeholder: "A1" },
            ]}
            onCreated={(l) => {
              qc.invalidateQueries({ queryKey: ["locations-picker", siteId] })
              qc.invalidateQueries({ queryKey: ["locations"] })
              onChange(l.id, l)
            }}
          />
        ) : undefined
      }
    />
  )
}

/** Layout mode's right inspector for a selected outline. */
export function OutlineInspector({
  outline,
  siteName,
  canEdit,
  onPatch,
  onDelete,
  onClose,
}: {
  outline: SiteMapOutline
  siteName: string
  canEdit: boolean
  onPatch: (patch: SiteMapOutlineWritePayload) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(outline.label)
  useEffect(() => setLabel(outline.label), [outline.id, outline.label])
  return (
    <aside
      aria-label="Outline"
      className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Outline
        </span>
        <span className="flex items-center gap-2">
          <span className="num text-[11px] text-muted-foreground">
            {outline.points.length} points
          </span>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close inspector"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      <Field label="Site">
        <span className="text-[13px]">{siteName}</span>
      </Field>
      <OutlineLocationField
        siteId={canEdit ? outline.site_id : null}
        value={outline.location_id}
        onChange={(id) => onPatch({ location_id: id })}
      />
      <Field label="Label">
        <Input
          value={label}
          disabled={!canEdit}
          placeholder={outline.location?.code || outline.location?.name || ""}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== outline.label && onPatch({ label })}
          className="h-8 text-sm"
        />
      </Field>
      <FormColor
        label="Color"
        value={outline.color}
        onChange={(color) => canEdit && onPatch({ color })}
      />
      <FormCheckbox
        label="Locked"
        checked={outline.locked}
        disabled={!canEdit}
        onChange={(locked) => onPatch({ locked })}
      />
      {canEdit && !outline.locked && (
        <p className="text-[11px] text-muted-foreground">
          Drag a point · ＋ adds one · right-click removes one
        </p>
      )}
      {canEdit && (
        <div className="mt-auto border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete outline
          </Button>
        </div>
      )}
    </aside>
  )
}

/** After drawing: the site the outline belongs to (the nearest one you may
 * edit), its location and label, then create it. */
export function OutlineCreateDialog({
  points,
  sites,
  defaultSiteId,
  onCancel,
  onCreate,
}: {
  points: Pt[] | null
  sites: SiteMapSite[]
  defaultSiteId: string | null
  onCancel: () => void
  onCreate: (payload: SiteMapOutlineWritePayload) => void
}) {
  const [siteId, setSiteId] = useState<string | null>(defaultSiteId)
  const [locationId, setLocationId] = useState<string | null>(null)
  const [label, setLabel] = useState("")
  useEffect(() => {
    if (!points) return
    setSiteId(defaultSiteId)
    setLocationId(null)
    setLabel("")
  }, [points, defaultSiteId])
  const siteOptions = useMemo(
    () =>
      sites
        .filter((s) => s.can_edit)
        .map((s) => ({ value: s.id, label: s.name })),
    [sites]
  )
  return (
    <Dialog open={!!points} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>New outline</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <FormCombobox
            label="Site"
            required
            value={siteId}
            onChange={(v) => {
              setSiteId(v)
              setLocationId(null)
            }}
            options={siteOptions}
            placeholder="Select site"
            searchPlaceholder="Search sites…"
            emptyText="No sites."
          />
          <OutlineLocationField
            siteId={siteId}
            value={locationId}
            onChange={setLocationId}
          />
          <Field label="Label" hint="optional">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="h-8 text-sm"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!siteId}
            onClick={() =>
              points &&
              siteId &&
              onCreate({
                site_id: siteId,
                location_id: locationId,
                label: label.trim(),
                points,
              })
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
