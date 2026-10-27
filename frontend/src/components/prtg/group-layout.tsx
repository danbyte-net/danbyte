import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
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

type PreviewObject = PrtgLayoutPreview["rows"][number]["object"]

interface TreeNode {
  name: string
  kind: string
  exists: boolean
  children: TreeNode[]
  /** Objects that land in this group itself. */
  objects: PreviewObject[]
  /** Objects in this group and every group under it. */
  total: number
}

/** The preview's rows as the tree PRTG will get under the root. */
export function layoutTree(data: PrtgLayoutPreview): TreeNode {
  const root: TreeNode = {
    name: data.root?.name || data.root?.path || "Root",
    kind: "root",
    exists: true,
    children: [],
    objects: [],
    total: 0,
  }
  for (const row of data.rows) {
    let node = root
    node.total += 1
    for (const step of row.path) {
      let child = node.children.find((c) => c.name === step.name)
      if (!child) {
        child = {
          name: step.name,
          kind: step.kind,
          exists: step.exists,
          children: [],
          objects: [],
          total: 0,
        }
        node.children.push(child)
      }
      child.total += 1
      node = child
    }
    node.objects.push(row.object)
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    )
    n.objects.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    )
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

function countLabel(objects: PreviewObject[] | number): string {
  if (typeof objects === "number")
    return `${objects} ${objects === 1 ? "object" : "objects"}`
  const vms = objects.filter((o) => o.kind === "virtual_machine").length
  const devices = objects.length - vms
  const parts = []
  if (devices) parts.push(`${devices} ${devices === 1 ? "device" : "devices"}`)
  if (vms) parts.push(`${vms} ${vms === 1 ? "VM" : "VMs"}`)
  return parts.join(", ")
}

/** What a group's own objects lack, named by the kind of its subgroups. */
function missingLabel(node: TreeNode): string {
  const kinds = new Set(node.children.map((c) => c.kind))
  if (kinds.has("role")) return "No role"
  if (kinds.has("location")) return "No location"
  if (kinds.has("site") || kinds.has("region")) return "No site"
  return "Not placed"
}

function ObjectList({ objects }: { objects: PreviewObject[] }) {
  return (
    <ul className="grid gap-0.5 py-0.5 pl-5">
      {objects.map((o) => (
        <li
          key={`${o.kind}-${o.id}`}
          className="truncate font-mono text-xs text-muted-foreground"
        >
          {o.name}
        </li>
      ))}
    </ul>
  )
}

function TreeRow({
  label,
  kind,
  isNew,
  count,
  objects,
  muted,
}: {
  label: string
  kind?: string
  isNew?: boolean
  count: string
  objects: PreviewObject[]
  muted?: boolean
}) {
  const [open, setOpen] = useState(false)
  const canOpen = objects.length > 0
  return (
    <div>
      <button
        type="button"
        className="flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-xs hover:bg-muted/50 disabled:hover:bg-transparent"
        onClick={() => setOpen((v) => !v)}
        disabled={!canOpen}
        aria-expanded={canOpen ? open : undefined}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            !canOpen && "invisible"
          )}
        />
        <span
          className={cn(
            "truncate",
            muted ? "text-muted-foreground" : "font-medium"
          )}
        >
          {label}
        </span>
        {kind && <span className="shrink-0 text-muted-foreground">{kind}</span>}
        {isNew && (
          <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px]">
            New group
          </Badge>
        )}
        <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
          {count}
        </span>
      </button>
      {open && <ObjectList objects={objects} />}
    </div>
  )
}

function TreeBranch({ node }: { node: TreeNode }) {
  return (
    <div className="ml-2 border-l border-border pl-2">
      {node.children.map((child) => (
        <div key={child.name}>
          <TreeRow
            label={child.name}
            kind={KIND_LABEL[child.kind]}
            isNew={!child.exists}
            count={countLabel(
              child.children.length ? child.total : child.objects
            )}
            objects={child.children.length ? [] : child.objects}
          />
          {child.children.length > 0 && <TreeBranch node={child} />}
        </div>
      ))}
      {node.objects.length > 0 && node.children.length > 0 && (
        <TreeRow
          label={missingLabel(node)}
          kind={`stays in ${node.name}`}
          count={countLabel(node.objects)}
          objects={node.objects}
          muted
        />
      )}
      {node.objects.length > 0 && node.children.length === 0 && (
        <ObjectList objects={node.objects} />
      )}
    </div>
  )
}

/** The tree the layout builds for the tenant's devices and VMs, from
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
  if (data.rows.length === 0)
    return <p className="text-xs text-muted-foreground">No devices yet.</p>
  const tree = layoutTree(data)
  const total = data.total ?? data.rows.length
  return (
    <div className="grid gap-1" data-testid="prtg-layout-preview">
      <div className="flex items-center gap-1.5 px-1 text-xs">
        <span className="font-medium">{tree.name}</span>
        <span className="ml-auto text-muted-foreground tabular-nums">
          {countLabel(tree.total)}
        </span>
      </div>
      <TreeBranch node={tree} />
      {total > data.rows.length && (
        <p className="px-1 text-xs text-muted-foreground">
          First {data.rows.length} of {total} devices and VMs.
        </p>
      )}
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
