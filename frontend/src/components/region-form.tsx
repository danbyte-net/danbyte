import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Globe, X } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type BoundaryCandidate,
  type GeoBoundary,
  type Paginated,
  type Region,
  type RegionOption,
  type RegionWritePayload,
} from "@/lib/api"
import {
  Field,
  FormColor,
  FormCombobox,
  FormFooter,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useSaveObject } from "@/lib/save-object"

export interface RegionFormProps {
  region?: Region
  onSaved: (v: Region) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function RegionForm({ region, onSaved, onCancel }: RegionFormProps) {
  const isEdit = !!region
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const [name, setName] = useState(region?.name ?? "")
  const [slug, setSlug] = useState(region?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [parentId, setParentId] = useState<string | null>(
    region?.parent?.id ?? null
  )
  const [description, setDescription] = useState(region?.description ?? "")
  const [color, setColor] = useState(region?.color ?? "")
  const [boundary, setBoundary] = useState<GeoBoundary | null>(
    region?.boundary ?? null
  )
  const [boundaryLabel, setBoundaryLabel] = useState(
    region?.boundary_label ?? ""
  )
  const [lookupQ, setLookupQ] = useState("")
  const [candidates, setCandidates] = useState<BoundaryCandidate[] | null>(null)

  useEffect(() => {
    if (!region) return
    setName(region.name)
    setSlug(region.slug)
    setSlugDirty(true)
    setParentId(region.parent?.id ?? null)
    setDescription(region.description)
    setColor(region.color ?? "")
    setBoundary(region.boundary ?? null)
    setBoundaryLabel(region.boundary_label ?? "")
    reset()
  }, [region, reset])

  // One Nominatim request per explicit click - never per keystroke (OSM
  // usage policy). The chosen polygon is stored on the region, so it is
  // fetched exactly once.
  const lookup = useMutation({
    mutationFn: (q: string) =>
      api<{ results: BoundaryCandidate[] }>(
        `/api/regions/boundary-lookup/?${new URLSearchParams({ q })}`
      ),
    onSuccess: (data) => setCandidates(data.results),
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const regions = useQuery({
    queryKey: ["regions-picker"],
    queryFn: () => api<Paginated<RegionOption>>("/api/regions/?picker=1"),
    staleTime: 10 * 60_000,
  })
  // Can't be its own parent.
  const parentOptions = (regions.data?.results ?? [])
    .filter((r) => r.id !== region?.id)
    .map((r) => ({ value: r.id, label: r.name }))

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RegionWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        parent_id: parentId,
        description: description.trim(),
        color,
        boundary,
        boundary_label: boundary ? boundaryLabel : "",
      }
      return saveObject<Region>({
        objectType: "api.region",
        endpoint: "/api/regions/",
        id: isEdit ? region!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["regions"] })
      qc.invalidateQueries({ queryKey: ["regions-picker"] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Region" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={onNameChange}
          error={fieldErrors.name}
        />
        <FormText
          label="Slug"
          hint="URL-safe id"
          placeholder="us-east"
          value={slug}
          onChange={(v) => {
            setSlugDirty(true)
            setSlug(slugify(v))
          }}
          mono
          error={fieldErrors.slug}
        />
        <FormCombobox
          label="Parent region"
          hint="optional"
          value={parentId}
          onChange={setParentId}
          options={parentOptions}
          noneLabel="Top level"
          placeholder="Top level"
          searchPlaceholder="Search regions…"
          emptyText="No regions."
          error={fieldErrors.parent_id}
        />
      </FormSection>

      <FormSection title="Map" card>
        <FormColor
          label="Map color"
          hint="shades the boundary on maps"
          value={color}
          onChange={setColor}
        />
        <Field
          label="Map boundary"
          info={
            <>
              Searches OpenStreetMap for the region's outline - a country,
              municipality, or postal code - and stores the selected boundary on
              the region. Boundary data © OpenStreetMap contributors, ODbL.
            </>
          }
          error={fieldErrors.boundary}
        >
          {boundary ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs">
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {boundaryLabel || "Custom boundary"}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-6 px-1.5"
                onClick={() => {
                  setBoundary(null)
                  setBoundaryLabel("")
                }}
              >
                <X className="h-3.5 w-3.5" /> Clear
              </Button>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <div className="flex gap-2">
                <Input
                  value={lookupQ}
                  onChange={(e) => setLookupQ(e.target.value)}
                  placeholder="Place or postal code…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      if (lookupQ.trim()) lookup.mutate(lookupQ.trim())
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  disabled={!lookupQ.trim() || lookup.isPending}
                  onClick={() => lookup.mutate(lookupQ.trim())}
                >
                  {lookup.isPending ? "Searching…" : "Search OSM"}
                </Button>
              </div>
              {candidates && candidates.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No boundary found. Try the official name, or add the country.
                </p>
              )}
              {candidates && candidates.length > 0 && (
                <div className="grid gap-1">
                  {candidates.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-muted/60"
                      onClick={() => {
                        setBoundary(c.boundary)
                        setBoundaryLabel(c.label)
                        setCandidates(null)
                        setLookupQ("")
                      }}
                    >
                      <span className="min-w-0 truncate">{c.label}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {c.kind}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Field>
      </FormSection>

      <FormSection title="Notes" card>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create region"}
      />
    </form>
  )
}
