import { useCallback, useMemo, useState } from "react"
import { dash } from "@/components/cells/dash"
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AddActionsContext,
  useRegisterAddActions,
  type AddAction,
} from "@/components/device-add-actions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { DataTable, selectionColumn } from "@/components/data-table"
import {
  ComponentBulkBar,
  type BulkFieldSpec,
} from "@/components/component-bulk-bar"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  ComponentTemplateDialog,
  TEMPLATE_ENDPOINT,
  TEMPLATE_NOUN,
  TEMPLATE_QUERY_KEY,
  type AnyTemplate,
  type TemplateKind,
} from "@/components/component-template-dialog"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { DeviceTypeServicesSection } from "@/components/device-type-services-section"

// Bulk-editable fields per template kind — description everywhere; type on
// the port-ish kinds; interface templates add enabled/mgmt_only.
const DESC: BulkFieldSpec = {
  key: "description",
  label: "Description",
  kind: "text",
}
const TYPE: BulkFieldSpec = {
  key: "type",
  label: "Type",
  kind: "choice",
  choices: "interface_types",
}
const TEMPLATE_BULK_FIELDS: Record<string, BulkFieldSpec[]> = {
  interface: [
    TYPE,
    { key: "enabled", label: "Enabled", kind: "bool" },
    { key: "mgmt_only", label: "Management only", kind: "bool" },
    DESC,
  ],
  "console-port": [DESC],
  "console-server-port": [DESC],
  "power-port": [DESC],
  "power-outlet": [DESC],
  "rear-port": [DESC],
  "front-port": [DESC],
  "aux-port": [DESC],
  "module-bay": [DESC],
  "device-bay": [DESC],
  "inventory-item": [DESC],
}

// Services aren't a generic component template (they carry protocol/ports/
// monitor, not a port `type`), so they get their own tab + section rather than
// being squeezed into the shared ComponentTemplateDialog.
type SectionKind = TemplateKind | "service"

const typeCol: ColumnDef<AnyTemplate> = {
  id: "type",
  header: "Type",
  cell: ({ row }) =>
    row.original.type ? (
      <span className="font-mono text-xs">{row.original.type}</span>
    ) : (
      dash
    ),
}

// Per-kind middle columns, spliced between Name and Description.
const EXTRA_COLUMNS: Record<TemplateKind, ColumnDef<AnyTemplate>[]> = {
  interface: [
    typeCol,
    {
      id: "enabled",
      header: "Enabled",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.enabled ? "Yes" : "No"}</span>
      ),
    },
    {
      id: "mgmt_only",
      header: "Mgmt only",
      cell: ({ row }) =>
        row.original.mgmt_only ? <span className="text-xs">Yes</span> : dash,
    },
  ],
  "console-port": [typeCol],
  "console-server-port": [typeCol],
  "aux-port": [typeCol],
  "device-bay": [],
  "inventory-item": [
    {
      id: "manufacturer",
      header: "Manufacturer",
      cell: ({ row }) =>
        row.original.manufacturer ? (
          <span className="text-xs">{row.original.manufacturer.name}</span>
        ) : (
          dash
        ),
    },
    {
      id: "part_id",
      header: "Part ID",
      cell: ({ row }) =>
        row.original.part_id ? (
          <span className="font-mono text-xs">{row.original.part_id}</span>
        ) : (
          dash
        ),
    },
  ],
  "module-bay": [
    {
      id: "position",
      header: "Position",
      cell: ({ row }) =>
        row.original.position ? (
          <span className="num font-mono text-xs">{row.original.position}</span>
        ) : (
          dash
        ),
    },
  ],
  "power-port": [
    typeCol,
    {
      id: "maximum_draw",
      header: "Max draw",
      cell: ({ row }) =>
        row.original.maximum_draw != null ? (
          <span className="num text-xs">{row.original.maximum_draw} W</span>
        ) : (
          dash
        ),
    },
    {
      id: "allocated_draw",
      header: "Allocated",
      cell: ({ row }) =>
        row.original.allocated_draw != null ? (
          <span className="num text-xs">{row.original.allocated_draw} W</span>
        ) : (
          dash
        ),
    },
  ],
  "power-outlet": [
    typeCol,
    {
      id: "power_port",
      header: "Inlet",
      cell: ({ row }) =>
        row.original.power_port_template ? (
          <span className="font-mono text-xs">
            {row.original.power_port_template.name}
          </span>
        ) : (
          dash
        ),
    },
    {
      id: "feed_leg",
      header: "Feed leg",
      cell: ({ row }) =>
        row.original.feed_leg ? (
          <span className="text-xs">Leg {row.original.feed_leg}</span>
        ) : (
          dash
        ),
    },
  ],
  "rear-port": [
    typeCol,
    {
      id: "positions",
      header: "Positions",
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.positions}</span>
      ),
    },
  ],
  "front-port": [
    typeCol,
    {
      id: "rear_port",
      header: "Rear port",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.rear_port_template?.name}
          <span className="text-muted-foreground">
            {" "}
            · position {row.original.rear_port_position}
          </span>
        </span>
      ),
    },
  ],
}

const SECTIONS: { kind: TemplateKind; title: string; empty: string }[] = [
  {
    kind: "interface",
    title: "Interfaces",
    empty: "No interface templates.",
  },
  {
    kind: "console-port",
    title: "Console ports",
    empty: "No console port templates.",
  },
  {
    kind: "console-server-port",
    title: "Console server ports",
    empty: "No console server port templates.",
  },
  {
    kind: "power-port",
    title: "Power ports",
    empty: "No power port templates. Power ports are the inlets (PSUs).",
  },
  {
    kind: "power-outlet",
    title: "Power outlets",
    empty: "No power outlet templates. Outlets can feed from a power port.",
  },
  {
    kind: "rear-port",
    title: "Rear ports",
    empty: "No rear port templates. Add one before mapping front ports.",
  },
  {
    kind: "front-port",
    title: "Front ports",
    empty: "No front port templates. Each maps to a rear-port position.",
  },
  {
    kind: "device-bay",
    title: "Device bays",
    empty:
      'No device bay templates. Device bays are chassis slots that hold whole child devices (blades, FEX) — set the child type\'s subdevice role to "child".',
  },
  {
    kind: "module-bay",
    title: "Module bays",
    empty:
      "No module bay templates. Bays are slots that accept module types (line cards); {module} in the module's port names resolves to the bay's position.",
  },
  {
    kind: "inventory-item",
    title: "Inventory",
    empty:
      "No inventory item templates. Parts the hardware ships with — PSUs, fans, CPUs — stamp onto new devices as serial-trackable inventory.",
  },
  {
    kind: "aux-port",
    title: "Aux ports",
    empty:
      "No aux port templates. Aux ports model USB, video (HDMI/VGA/DP), card slots, grounding — everything the other kinds don't.",
  },
]

/** The nine component-template tables on a device-type detail page — one per
 * sub-tab so you don't scroll past eight sections to reach the ninth. */
export function DeviceTypeComponentsPane({
  deviceTypeId,
}: {
  deviceTypeId: string
}) {
  const { canDo } = useMe()
  const canWrite = canDo("devicetype", "change")
  const [kind, setKind] = useState<SectionKind>("interface")

  // Fetch every kind's list up front — cheap, and it gives the tab counts plus
  // instant switching. The keys/endpoints match TemplateSection's own query,
  // so the active section reads from this same cache (no double fetch).
  const counts = useQueries({
    queries: SECTIONS.map((s) => ({
      queryKey: [TEMPLATE_QUERY_KEY[s.kind], deviceTypeId],
      queryFn: () =>
        api<Paginated<AnyTemplate>>(
          `/api/${TEMPLATE_ENDPOINT[s.kind]}/?device_type=${deviceTypeId}`
        ),
    })),
  })
  const serviceCount = useQuery({
    queryKey: ["dt-service-templates", deviceTypeId],
    queryFn: () =>
      api<Paginated<unknown>>(
        `/api/device-type-services/?device_type=${deviceTypeId}`
      ),
  })

  const items = [
    ...SECTIONS.map((s, i) => ({
      value: s.kind,
      label: s.title,
      count: counts[i].data?.count ?? undefined,
    })),
    {
      value: "service" as const,
      label: "Services",
      count: serviceCount.data?.count ?? undefined,
    },
  ]
  const active = SECTIONS.find((s) => s.kind === kind) ?? SECTIONS[0]

  // The active section publishes its "Add" here, so tabs + action sit in one
  // strip (matches the device detail Components tab). Only one section mounts
  // at a time, so this is a single button in practice.
  const [addMap, setAddMap] = useState<Record<string, AddAction[]>>({})
  const registerAdd = useCallback<(key: string, actions: AddAction[]) => void>(
    (key, actions) => {
      setAddMap((m) => {
        if (actions.length === 0) {
          if (!(key in m)) return m
          const next = { ...m }
          delete next[key]
          return next
        }
        return { ...m, [key]: actions }
      })
    },
    []
  )
  const barAdds = useMemo(() => Object.values(addMap).flat(), [addMap])

  return (
    <AddActionsContext.Provider value={registerAdd}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-10 min-w-0 shrink-0 items-center gap-3 px-4 shadow-[inset_0_-1px_0_var(--border)] lg:px-6">
          <SegmentedTabs items={items} value={kind} onValueChange={setKind} />
          <div className="ml-auto flex items-center gap-2">
            {barAdds.length === 1 ? (
              <Button
                size="sm"
                disabled={barAdds[0].disabled}
                onClick={barAdds[0].onClick}
              >
                <Plus className="h-3.5 w-3.5" /> {barAdds[0].label}
              </Button>
            ) : barAdds.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-3.5 w-3.5" /> Add
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {barAdds.map((a, i) => (
                    <DropdownMenuItem
                      key={i}
                      disabled={a.disabled}
                      onSelect={a.onClick}
                    >
                      {a.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          {kind === "service" ? (
            <DeviceTypeServicesSection
              deviceTypeId={deviceTypeId}
              canWrite={canWrite}
            />
          ) : (
            <TemplateSection
              key={active.kind}
              kind={active.kind}
              empty={active.empty}
              deviceTypeId={deviceTypeId}
              canWrite={canWrite}
            />
          )}
        </div>
      </div>
    </AddActionsContext.Provider>
  )
}

function TemplateSection({
  kind,
  empty,
  deviceTypeId,
  canWrite,
}: {
  kind: TemplateKind
  empty: string
  deviceTypeId: string
  canWrite: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<AnyTemplate | null>(null)
  const [deleting, setDeleting] = useState<AnyTemplate | null>(null)

  // Publish the Add button up into the shared sub-tab bar.
  useRegisterAddActions(
    `dt-${kind}`,
    canWrite ? [{ label: "Add", onClick: () => setAdding(true) }] : []
  )

  const [selected, setSelected] = useState<AnyTemplate[]>([])
  const q = useQuery({
    queryKey: [TEMPLATE_QUERY_KEY[kind], deviceTypeId],
    queryFn: () =>
      api<Paginated<AnyTemplate>>(
        `/api/${TEMPLATE_ENDPOINT[kind]}/?device_type=${deviceTypeId}`
      ),
  })

  const columns = useMemo<ColumnDef<AnyTemplate>[]>(
    () => [
      ...(canWrite ? [selectionColumn<AnyTemplate>()] : []),
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="font-mono font-medium">{row.original.name}</span>
        ),
      },
      ...EXTRA_COLUMNS[kind],
      {
        id: "description",
        header: "Description",
        cell: ({ row }) =>
          row.original.description ? (
            <span className="text-xs text-muted-foreground">
              {row.original.description}
            </span>
          ) : (
            dash
          ),
      },
      {
        id: "actions",
        header: "",
        enableHiding: false,
        cell: ({ row }) =>
          canWrite ? (
            <div className="flex justify-end gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setEditing(row.original)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={() => setDeleting(row.original)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null,
      },
    ],
    [kind, canWrite]
  )

  const rows = q.data?.results ?? []

  return (
    <section className="space-y-3">
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          embedded
          onSelectedRowsChange={setSelected}
        />
      )}

      <ComponentBulkBar
        endpoint={`/api/${TEMPLATE_ENDPOINT[kind]}/`}
        kindLabel={`${kind.replace(/-/g, " ")} template`}
        selected={selected}
        onCleared={() => setSelected([])}
        invalidate={[[TEMPLATE_QUERY_KEY[kind], deviceTypeId]]}
        fields={TEMPLATE_BULK_FIELDS[kind]}
        canDelete={canWrite}
      />

      <ComponentTemplateDialog
        kind={kind}
        deviceTypeId={deviceTypeId}
        template={editing}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      />

      <TemplateDeleteDialog
        kind={kind}
        deviceTypeId={deviceTypeId}
        template={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </section>
  )
}

function TemplateDeleteDialog({
  kind,
  deviceTypeId,
  template,
  onOpenChange,
}: {
  kind: TemplateKind
  deviceTypeId: string
  template: AnyTemplate | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/${TEMPLATE_ENDPOINT[kind]}/${template!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${template!.name}`)
      qc.invalidateQueries({
        queryKey: [TEMPLATE_QUERY_KEY[kind], deviceTypeId],
      })
      // Dependents reference these across sections; refresh them too.
      if (kind === "rear-port")
        qc.invalidateQueries({
          queryKey: [TEMPLATE_QUERY_KEY["front-port"], deviceTypeId],
        })
      if (kind === "power-port")
        qc.invalidateQueries({
          queryKey: [TEMPLATE_QUERY_KEY["power-outlet"], deviceTypeId],
        })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!template} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {template?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes this {TEMPLATE_NOUN[kind]} from the device type. Existing
            devices keep their components — only future devices are affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
