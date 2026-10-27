import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  PrtgConnection,
  PrtgGroupLayout,
  PrtgLayoutPreview,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FormCheckbox, FormSelect, useFieldErrors } from "@/components/forms"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Section } from "@/components/ui/section"
import { PrtgGroupPicker } from "./group-picker"

export const GROUP_LAYOUTS: { value: PrtgGroupLayout; label: string }[] = [
  { value: "none", label: "Policy or default group" },
  { value: "sites", label: "Sites and locations" },
  { value: "roles", label: "Roles" },
  { value: "sites_roles", label: "Sites, then roles" },
]

export interface GroupLayoutValue {
  group_layout: PrtgGroupLayout
  layout_regions: boolean
  layout_locations: boolean
  layout_root_id: string
  layout_root_path: string
}

export function layoutOf(conn: PrtgConnection): GroupLayoutValue {
  return {
    group_layout: conn.group_layout ?? "none",
    layout_regions: conn.layout_regions ?? true,
    layout_locations: conn.layout_locations ?? true,
    layout_root_id: conn.layout_root_id ?? "",
    layout_root_path: conn.layout_root_path ?? "",
  }
}

/** The layout choice, its switches and the root picker. */
export function GroupLayoutFields({
  connection,
  value,
  onChange,
  errors = {},
  disabled,
}: {
  connection: PrtgConnection
  value: GroupLayoutValue
  onChange: (next: GroupLayoutValue) => void
  errors?: Record<string, string | undefined>
  disabled?: boolean
}) {
  const set = (patch: Partial<GroupLayoutValue>) =>
    onChange({ ...value, ...patch })
  const sites =
    value.group_layout === "sites" || value.group_layout === "sites_roles"
  return (
    <div className="grid gap-3">
      <FormSelect
        label="Layout"
        info="Where new devices go when no policy names a group. Danbyte creates the groups in PRTG, reuses one with the same name, and keeps its own groups named after the site, location or role."
        value={value.group_layout}
        onChange={(v) =>
          set({ group_layout: (v as PrtgGroupLayout | null) ?? "none" })
        }
        options={GROUP_LAYOUTS}
        disabled={disabled}
        error={errors.group_layout}
      />
      {value.group_layout !== "none" && (
        <>
          <PrtgGroupPicker
            connectionId={connection.id}
            label="Build under"
            value={value.layout_root_id || null}
            path={value.layout_root_path}
            onChange={(id, path) =>
              set({ layout_root_id: id ?? "", layout_root_path: path })
            }
            error={errors.layout_root_id}
          />
          {!value.layout_root_id && (
            <p className="text-xs text-muted-foreground">
              Blank uses the registration group
              {connection.register_group_path
                ? ` ${connection.register_group_path}`
                : ""}
              .
            </p>
          )}
          {sites && (
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <FormCheckbox
                label="Region groups"
                checked={value.layout_regions}
                onChange={(v) => set({ layout_regions: v })}
                disabled={disabled}
              />
              <FormCheckbox
                label="Location groups"
                checked={value.layout_locations}
                onChange={(v) => set({ layout_locations: v })}
                disabled={disabled}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  region: "Region",
  site: "Site",
  location: "Location",
  role: "Role",
}

/** The tree the layout builds for up to 20 of the tenant's objects, from
 * Danbyte's data and PRTG's last group list. */
export function GroupLayoutPreview({
  connectionId,
  value,
}: {
  connectionId: string
  value: GroupLayoutValue
}) {
  const params = new URLSearchParams({
    layout: value.group_layout,
    regions: value.layout_regions ? "1" : "0",
    locations: value.layout_locations ? "1" : "0",
    root: value.layout_root_id,
  })
  const preview = useQuery({
    queryKey: ["prtg-layout-preview", connectionId, params.toString()],
    queryFn: () =>
      api<PrtgLayoutPreview>(
        `/api/prtg/connections/${connectionId}/layout-preview/?${params}`
      ),
    enabled: value.group_layout !== "none",
    staleTime: 30_000,
  })
  if (value.group_layout === "none") return null
  if (preview.isLoading) return <Loading />
  if (preview.error) return <QueryError error={preview.error} />
  const data = preview.data
  if (!data) return null
  if (!data.root)
    return (
      <p className="text-xs text-muted-foreground">
        Pick the probe or group to build under.
      </p>
    )
  const rows = data.rows
  return (
    <div className="grid gap-1.5" data-testid="prtg-layout-preview">
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">No devices yet.</p>
      )}
      {rows.map((row) => (
        <div
          key={`${row.object.kind}-${row.object.id}`}
          className="flex min-w-0 flex-wrap items-center gap-1 text-xs"
        >
          <span className="text-muted-foreground">
            {data.root?.name || data.root?.path}
          </span>
          {row.path.map((p, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span className={p.exists ? "" : "font-medium"}>{p.name}</span>
              {!p.exists && (
                <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                  New {KIND_LABEL[p.kind]?.toLowerCase() ?? "group"}
                </Badge>
              )}
            </span>
          ))}
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono">{row.object.name}</span>
        </div>
      ))}
    </div>
  )
}

/** The Overview's Group layout card: the setting, editable in place, and
 * its preview. */
export function PrtgGroupLayoutCard({
  connection,
  canManage,
}: {
  connection: PrtgConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [value, setValue] = useState<GroupLayoutValue>(() =>
    layoutOf(connection)
  )
  const { fieldErrors, handleApiError } = useFieldErrors()
  const stored = layoutOf(connection)
  const dirty = JSON.stringify(stored) !== JSON.stringify(value)
  const save = useMutation({
    mutationFn: () =>
      api<PrtgConnection>(`/api/prtg/connections/${connection.id}/`, {
        method: "PATCH",
        body: JSON.stringify(value),
      }),
    onSuccess: () => {
      toast.success("Group layout saved")
      void qc.invalidateQueries({ queryKey: ["prtg-connections"] })
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })
  return (
    <Section
      title="Group layout"
      actions={
        canManage &&
        dirty && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setValue(stored)}
              disabled={save.isPending}
            >
              Reset
            </Button>
            <Button
              size="sm"
              onClick={() => save.mutate()}
              disabled={save.isPending}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <GroupLayoutFields
          connection={connection}
          value={value}
          onChange={setValue}
          errors={fieldErrors}
          disabled={!canManage}
        />
        <GroupLayoutPreview connectionId={connection.id} value={value} />
      </div>
    </Section>
  )
}
