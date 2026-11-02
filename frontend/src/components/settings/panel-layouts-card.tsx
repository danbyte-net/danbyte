import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import type { DragEndEvent } from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Plus, RotateCcw, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import type {
  FloorPlanTilePanel,
  PanelLayoutCatalog,
  PanelLayoutItem,
  PanelLayoutRow,
  PanelLayoutScope,
  PanelObjectKind,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import { InfoTip } from "@/components/ui/info-tip"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { SettingsCard } from "@/components/settings/settings-card"
import {
  FieldScopeHeading,
  FieldScopeRow,
  useCustomFieldMeta,
} from "@/components/settings/field-list-editor"
import { PanelLayoutBody } from "@/components/floorplan/object-detail-panel"
import { cn } from "@/lib/utils"

const KINDS: { value: PanelObjectKind; label: string }[] = [
  { value: "device", label: "Devices" },
  { value: "rack", label: "Racks" },
  { value: "cabinet", label: "Cabinets" },
]

const SCOPE_LABEL: Record<PanelLayoutScope, string> = {
  default: "Default",
  device_type: "Device type",
  device_role: "Device role",
  profile: "Profile",
  rack_type: "Rack type",
  rack_role: "Rack role",
  cabinet_type: "Cabinet type",
  cabinet_role: "Cabinet role",
}

/** Where each scope's objects are listed. */
const SCOPE_LIST: Partial<Record<PanelLayoutScope, string>> = {
  device_type: "/api/device-types/",
  device_role: "/api/device-roles/",
  profile: "/api/device-profiles/",
  rack_type: "/api/rack-types/",
  rack_role: "/api/rack-roles/",
  cabinet_type: "/api/cabinet-types/",
  cabinet_role: "/api/cabinet-roles/",
}

type ScopeKey = string
const keyOf = (scope: PanelLayoutScope, id: string | null): ScopeKey =>
  `${scope}:${id ?? ""}`

/** Each entry with a stable id for the sortable list. */
interface Entry {
  uid: string
  item: PanelLayoutItem
}
let uidSeq = 0
const toEntries = (items: PanelLayoutItem[]): Entry[] =>
  items.map((item) => ({ uid: `e${++uidSeq}`, item }))

/**
 * Settings → Floor plans → Detail panels: which fields a floor plan's
 * device, rack or cabinet panel shows, and in what order - for the
 * tenant's default, or for one device type, role or profile (a rack or
 * cabinet: its type or role). The most specific layout wins.
 */
export function PanelLayoutsCard() {
  const qc = useQueryClient()
  const [kind, setKind] = useState<PanelObjectKind>("device")
  const catalog = useQuery({
    queryKey: ["panel-layout-catalog"],
    queryFn: () => api<PanelLayoutCatalog>("/api/panel-layouts/catalog/"),
  })
  const rows = useQuery({
    queryKey: ["panel-layouts"],
    queryFn: () => api<{ results: PanelLayoutRow[] }>("/api/panel-layouts/"),
  })
  const [sel, setSel] = useState<ScopeKey>(keyOf("default", null))
  // A scope picked to add, with its name, before it is saved.
  const [pending, setPending] = useState<{
    scope: PanelLayoutScope
    id: string
    name: string
  } | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)

  const cat = catalog.data?.[kind]
  const mine = useMemo(
    () => (rows.data?.results ?? []).filter((r) => r.object_kind === kind),
    [rows.data, kind]
  )
  const row = mine.find((r) => keyOf(r.scope, r.scope_id) === sel) ?? null
  const [scope, scopeId] = sel.split(":") as [PanelLayoutScope, string]
  const tenantDefault = mine.find((r) => r.scope === "default")
  const inherited = tenantDefault?.items ?? cat?.default ?? []
  const saved = row?.items ?? (scope === "default" ? inherited : null)

  // The working copy follows the scope picked (and what is saved for it).
  const savedKey = JSON.stringify(saved ?? inherited)
  useEffect(() => {
    if (cat) setEntries(toEntries(JSON.parse(savedKey) as PanelLayoutItem[]))
  }, [sel, kind, cat, savedKey])

  const items = useMemo(() => entries?.map((e) => e.item) ?? [], [entries])
  const dirty =
    !!entries &&
    (saved === null || JSON.stringify(items) !== JSON.stringify(saved))

  const save = useMutation({
    mutationFn: () =>
      row
        ? api<PanelLayoutRow>(`/api/panel-layouts/${row.id}/`, {
            method: "PUT",
            body: JSON.stringify({ items }),
          })
        : api<PanelLayoutRow>("/api/panel-layouts/", {
            method: "POST",
            body: JSON.stringify({
              object_kind: kind,
              scope,
              scope_id: scopeId || null,
              items,
            }),
          }),
    onSuccess: () => {
      setPending(null)
      void qc.invalidateQueries({ queryKey: ["panel-layouts"] })
      void qc.invalidateQueries({ queryKey: ["floor-plan-tile-panel"] })
      toast.success("Panel layout saved")
    },
    onError: (e) => apiErrorToast(e),
  })
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/panel-layouts/${row!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      setSel(keyOf("default", null))
      void qc.invalidateQueries({ queryKey: ["panel-layouts"] })
      void qc.invalidateQueries({ queryKey: ["floor-plan-tile-panel"] })
      toast.success("Panel layout removed")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (catalog.isError) return <QueryError error={catalog.error} />
  if (rows.isError) return <QueryError error={rows.error} />

  const title =
    scope === "default"
      ? "Default"
      : `${SCOPE_LABEL[scope]} · ${row?.scope_name || pending?.name || ""}`

  return (
    <SettingsCard
      title="Detail panels"
      description={
        <span className="inline-flex items-center gap-1.5">
          What a device, rack or cabinet panel on a floor plan shows.
          <InfoTip>
            A device takes the layout of its device type, else its role, else
            its first profile with one, else the default. A rack or cabinet
            takes its type&apos;s, else its role&apos;s, else the default. A
            field with nothing to say is left out.
          </InfoTip>
        </span>
      }
      layout="flush"
      onSave={() => save.mutate()}
      dirty={dirty}
      saving={save.isPending}
      saveLabel="Save layout"
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty}
            onClick={() => setEntries(toEntries(saved ?? inherited))}
          >
            Reset
          </Button>
          {scope === "default" && cat && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEntries(toEntries(cat.default))}
            >
              Restore defaults
            </Button>
          )}
          {row && (
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {remove.isPending ? "Removing…" : "Inherit"}
            </Button>
          )}
        </>
      }
    >
      <div className="border-b border-border px-4 py-2">
        <SegmentedTabs
          value={kind}
          onValueChange={(k) => {
            setKind(k)
            setPending(null)
            setSel(keyOf("default", null))
          }}
          items={KINDS}
        />
      </div>
      {!cat || !entries ? (
        <Loading />
      ) : (
        <div className="flex flex-col lg:flex-row">
          <aside className="w-full shrink-0 border-b border-border p-3 lg:w-60 lg:border-r lg:border-b-0">
            <FieldScopeHeading first>Applies to</FieldScopeHeading>
            <FieldScopeRow
              active={sel === keyOf("default", null)}
              onSelect={() => setSel(keyOf("default", null))}
              label="Default"
              custom={!!tenantDefault}
            />
            {cat.scopes
              .filter((s) => s !== "default")
              .map((s) => {
                const list = mine.filter((r) => r.scope === s)
                const p = pending?.scope === s ? pending : null
                if (!list.length && !p) return null
                return (
                  <div key={s}>
                    <FieldScopeHeading>{SCOPE_LABEL[s]}</FieldScopeHeading>
                    {list.map((r) => (
                      <FieldScopeRow
                        key={r.id}
                        active={sel === keyOf(r.scope, r.scope_id)}
                        onSelect={() => setSel(keyOf(r.scope, r.scope_id))}
                        label={r.scope_name || "Missing"}
                        custom
                      />
                    ))}
                    {p && !list.some((r) => r.scope_id === p.id) && (
                      <FieldScopeRow
                        active={sel === keyOf(p.scope, p.id)}
                        onSelect={() => setSel(keyOf(p.scope, p.id))}
                        label={p.name}
                        custom={false}
                      />
                    )}
                  </div>
                )
              })}
            <AddScope
              scopes={cat.scopes.filter((s) => s !== "default")}
              taken={new Set(mine.map((r) => keyOf(r.scope, r.scope_id)))}
              onAdd={(p) => {
                setPending(p)
                setSel(keyOf(p.scope, p.id))
              }}
            />
          </aside>
          <div className="min-w-0 flex-1 p-4">
            <h2 className="text-sm font-semibold">{title}</h2>
            <LayoutEditor
              entries={entries}
              onChange={setEntries}
              fields={cat.fields}
              cfModel={cat.cf_model}
            />
          </div>
          <div className="w-full shrink-0 border-t border-border bg-muted/30 p-4 lg:w-96 lg:border-t-0 lg:border-l">
            <h2 className="mb-2 text-sm font-semibold">Preview</h2>
            <LayoutPreview
              kind={kind}
              scope={scope}
              scopeId={scopeId || null}
              items={items}
            />
          </div>
        </div>
      )}
    </SettingsCard>
  )
}

/** Pick a type, role or profile to give its own layout. */
function AddScope({
  scopes,
  taken,
  onAdd,
}: {
  scopes: PanelLayoutScope[]
  taken: Set<string>
  onAdd: (p: { scope: PanelLayoutScope; id: string; name: string }) => void
}) {
  const [scope, setScope] = useState<PanelLayoutScope | null>(null)
  const list = useQuery({
    queryKey: ["panel-layout-scope-options", scope],
    queryFn: () =>
      apiAll<{ id: string; name?: string; model?: string; display?: string }>(
        SCOPE_LIST[scope!]!
      ),
    enabled: !!scope && !!SCOPE_LIST[scope],
  })
  const label = (o: { name?: string; model?: string; display?: string }) =>
    o.display || o.name || o.model || ""
  return (
    <div className="mt-3 grid gap-1.5 border-t border-border pt-3">
      <Combobox
        aria-label="Layout for"
        placeholder="Add a layout for…"
        value={scope}
        onChange={(v) => setScope(v as PanelLayoutScope | null)}
        options={scopes.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
      />
      {scope && (
        <Combobox
          aria-label={SCOPE_LABEL[scope]}
          placeholder={`Pick a ${SCOPE_LABEL[scope].toLowerCase()}…`}
          value={null}
          onChange={(id) => {
            const o = list.data?.results.find((x) => x.id === id)
            if (!id || !o) return
            onAdd({ scope, id, name: label(o) })
            setScope(null)
          }}
          options={(list.data?.results ?? [])
            .filter((o) => !taken.has(keyOf(scope, o.id)))
            .map((o) => ({ value: o.id, label: label(o) }))}
        />
      )}
    </div>
  )
}

/** The ordered entries, dragged into place, and the chips that add one. */
export function LayoutEditor({
  entries,
  onChange,
  fields,
  cfModel,
}: {
  entries: Entry[]
  onChange: (next: Entry[]) => void
  fields: { key: string; label: string; computed: boolean }[]
  cfModel: string
}) {
  const cfMeta = useCustomFieldMeta([cfModel], { skipHidden: true })
  const label = (key: string) =>
    key.startsWith("cf:")
      ? (cfMeta[`cf_${key.slice(3)}`]?.label ?? key.slice(3))
      : (fields.find((f) => f.key === key)?.label ?? key)
  const used = new Set(
    entries.flatMap((e) => ("field" in e.item ? [e.item.field] : []))
  )
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = entries.findIndex((x) => x.uid === active.id)
    const to = entries.findIndex((x) => x.uid === over.id)
    if (from < 0 || to < 0) return
    onChange(arrayMove(entries, from, to))
  }
  const add = (item: PanelLayoutItem) =>
    onChange([...entries, ...toEntries([item])])
  const groups = [
    {
      title: "Attributes",
      keys: fields.filter((f) => !f.computed).map((f) => f.key),
    },
    {
      title: "Blocks",
      keys: fields.filter((f) => f.computed).map((f) => f.key),
    },
    {
      title: "Custom fields",
      keys: Object.keys(cfMeta).map((k) => `cf:${k.slice(3)}`),
    },
  ]
  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={entries.map((e) => e.uid)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="mt-3 flex flex-col gap-1" data-layout-list>
            {entries.map((e) => (
              <SortableEntry
                key={e.uid}
                entry={e}
                label={"field" in e.item ? label(e.item.field) : ""}
                onRename={(s) =>
                  onChange(
                    entries.map((x) =>
                      x.uid === e.uid ? { ...x, item: { section: s } } : x
                    )
                  )
                }
                onRemove={() =>
                  onChange(entries.filter((x) => x.uid !== e.uid))
                }
              />
            ))}
            {entries.length === 0 && (
              <li className="rounded-md border border-dashed border-border px-2 py-3 text-center text-[13px] text-muted-foreground">
                Nothing - the panel shows only its title.
              </li>
            )}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="mt-4 space-y-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => add({ section: "Section" })}
        >
          <Plus className="h-3.5 w-3.5" /> Section
        </Button>
        {groups.map((g) => {
          const rest = g.keys.filter((k) => !used.has(k))
          if (!rest.length) return null
          return (
            <div key={g.title}>
              <p className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                {g.title}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {rest.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => add({ field: k })}
                    className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-[12px] text-muted-foreground hover:border-solid hover:text-foreground"
                  >
                    <Plus className="h-3 w-3" />
                    {label(k)}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function SortableEntry({
  entry,
  label,
  onRename,
  onRemove,
}: {
  entry: Entry
  label: string
  onRename: (s: string) => void
  onRemove: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.uid })
  const section = "section" in entry.item
  const name = section ? (entry.item as { section: string }).section : label
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-layout-entry={
        section ? "section" : (entry.item as { field: string }).field
      }
      className={cn(
        "flex items-center gap-2 rounded-md border border-border px-2 py-1",
        section && "mt-2 bg-muted/50 first:mt-0",
        isDragging && "relative z-10 bg-muted opacity-90"
      )}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground/60 hover:text-foreground"
        aria-label={`Drag ${name || "section"}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      {section ? (
        <Input
          aria-label="Section label"
          value={name}
          maxLength={64}
          onChange={(e) => onRename(e.target.value)}
          className="h-6 flex-1 border-transparent bg-transparent px-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase shadow-none md:text-[11px] dark:bg-transparent"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        aria-label={`Remove ${name || "section"}`}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </li>
  )
}

/** The panel as the layout draws it, for one object in the scope. */
function LayoutPreview({
  kind,
  scope,
  scopeId,
  items,
}: {
  kind: PanelObjectKind
  scope: PanelLayoutScope
  scopeId: string | null
  items: PanelLayoutItem[]
}) {
  // Sent once the list stops changing for a moment.
  const [sent, setSent] = useState(items)
  useEffect(() => {
    const t = window.setTimeout(() => setSent(items), 300)
    return () => window.clearTimeout(t)
  }, [items])
  const q = useQuery({
    queryKey: ["panel-layout-preview", kind, scope, scopeId, sent],
    queryFn: () =>
      api<FloorPlanTilePanel | { kind: string; empty: true }>(
        "/api/panel-layouts/preview/",
        {
          method: "POST",
          body: JSON.stringify({
            object_kind: kind,
            scope,
            scope_id: scopeId,
            items: sent.filter((i) => !("section" in i) || i.section.trim()),
          }),
        }
      ),
    placeholderData: (prev) => prev,
  })
  if (q.isError) return <QueryError error={q.error} />
  const p = q.data
  if (!p) return <Loading className="min-h-24" />
  if ("empty" in p && p.empty)
    return (
      <p className="text-[13px] text-muted-foreground">
        Nothing to preview with yet.
      </p>
    )
  if (!("layout" in p)) return null
  const name =
    p.kind === "device"
      ? p.device.name
      : p.kind === "rack"
        ? p.rack.name
        : p.cabinet.name
  return (
    <div
      data-layout-preview
      className="w-80 max-w-full rounded-lg border border-border bg-background"
    >
      <div className="border-b border-border px-3 py-2 text-sm font-semibold">
        {name}
      </div>
      <div className="p-3 text-[12px]">
        <PanelLayoutBody p={p} />
      </div>
    </div>
  )
}
