import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import {
  api,
  type ModuleInterfaceTemplate,
  type ModuleType,
  type Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { KvCard, dash, mono, type KvRow } from "@/components/kv-card"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { DeviceTypeFaceplatePane } from "@/components/device-type-faceplate-pane"
import { QueryError } from "@/components/query-error"
import { ModuleTypeDeleteDialog } from "@/routes/module-types.index"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/module-types/$id")({
  component: ModuleTypeDetail,
})

function ModuleTypeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["module-type", id],
    queryFn: () => api<ModuleType>(`/api/module-types/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body moduleType={q.data} />
}

function Body({ moduleType: m }: { moduleType: ModuleType }) {
  const [tab, setTab] = useState<
    "overview" | "faceplate" | "journal" | "history"
  >("overview")
  const { canDo } = useMe()
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<ModuleType | null>(null)
  const goBack = useCallback(() => nav({ to: "/module-types" }), [nav])

  const rows: KvRow[] = [
    {
      label: "Manufacturer",
      value: m.manufacturer ? (
        <Link
          to="/manufacturers/$id"
          params={{ id: m.manufacturer.id }}
          className="text-primary hover:underline"
        >
          {m.manufacturer.name}
        </Link>
      ) : (
        dash
      ),
    },
    { label: "Part number", value: mono(m.part_number) },
    {
      label: "Installed",
      value: <span className="num">{m.module_count}</span>,
    },
  ]

  return (
    <DetailShell
      backTo="/module-types"
      backLabel="Module types"
      title={m.name}
      actions={
        <>
          {canDo("moduletype", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/module-types/$id/edit" params={{ id: m.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("moduletype", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(m)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <section className="shrink-0 border-b border-border px-6 py-5">
          <div className="text-3xl font-semibold tracking-tight">{m.name}</div>
          {m.description && (
            <p className="mt-2 max-w-2xl text-[13px] text-muted-foreground">
              {m.description}
            </p>
          )}
        </section>
      }
      tabs={[
        {
          value: "overview",
          label: "Overview",
          count: m.interface_template_count,
        },
        { value: "faceplate", label: "Faceplate" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Module type" rows={rows} />
        </div>
        <div className="mt-6">
          <InterfaceTemplatesPane moduleTypeId={m.id} />
        </div>
      </DetailTab>
      <DetailTab value="faceplate">
        {/* Modules are 1U full-width blades to the builder; the layout is
            composed into the host device's render at its bay. */}
        <DeviceTypeFaceplatePane
          deviceType={{
            id: m.id,
            faceplate: m.faceplate,
            u_height: 1,
            rack_width: "full",
          }}
          moduleMode
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.moduletype" objectId={m.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.moduletype" objectId={m.id} />
      </DetailTab>

      <ModuleTypeDeleteDialog
        moduleType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** The interfaces this module contributes when installed. Names may carry
 * {module} (→ bay position) and {position} (→ stack member). */
function InterfaceTemplatesPane({ moduleTypeId }: { moduleTypeId: string }) {
  const { canDo } = useMe()
  const canWrite = canDo("moduletype", "change")
  const qc = useQueryClient()
  const [editing, setEditing] = useState<ModuleInterfaceTemplate | null>(null)
  const [adding, setAdding] = useState(false)

  const q = useQuery({
    queryKey: ["mt-interface-templates", moduleTypeId],
    queryFn: () =>
      api<Paginated<ModuleInterfaceTemplate>>(
        `/api/module-interface-templates/?module_type=${moduleTypeId}`
      ),
  })
  const del = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/module-interface-templates/${id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["mt-interface-templates", moduleTypeId],
      })
      qc.invalidateQueries({ queryKey: ["module-type", moduleTypeId] })
    },
    onError: (err) => apiErrorToast(err),
  })
  const rows = q.data?.results ?? []

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Interface templates
        </h3>
        {canWrite && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>
      {q.isError ? (
        <QueryError error={q.error} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No interface templates. Use{" "}
          <code className="font-mono">{"{module}"}</code> in names — it resolves
          to the bay's position when the module is installed.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Mgmt only</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono font-medium">
                    {t.name}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {t.type || "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.enabled ? "Yes" : "No"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.mgmt_only ? "Yes" : "—"}
                  </TableCell>
                  <TableCell>
                    {canWrite && (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setEditing(t)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => del.mutate(t.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ModuleInterfaceTemplateDialog
        moduleTypeId={moduleTypeId}
        template={editing}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      />
    </section>
  )
}

function ModuleInterfaceTemplateDialog({
  moduleTypeId,
  template,
  open,
  onOpenChange,
}: {
  moduleTypeId: string
  template: ModuleInterfaceTemplate | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const choices = useDcimChoices()
  const [name, setName] = useState("")
  const [type, setType] = useState("")
  const [enabled, setEnabled] = useState(true)
  const [mgmtOnly, setMgmtOnly] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(template?.name ?? "")
    setType(template?.type ?? "")
    setEnabled(template?.enabled ?? true)
    setMgmtOnly(template?.mgmt_only ?? false)
    reset()
  }, [open, template, reset])

  const editing = !!template
  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        module_type_id: moduleTypeId,
        name: name.trim(),
        type,
        enabled,
        mgmt_only: mgmtOnly,
      }
      if (editing)
        return api<ModuleInterfaceTemplate>(
          `/api/module-interface-templates/${template!.id}/`,
          { method: "PATCH", body: JSON.stringify(payload) }
        )
      return api<ModuleInterfaceTemplate>("/api/module-interface-templates/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["mt-interface-templates", moduleTypeId],
      })
      qc.invalidateQueries({ queryKey: ["module-type", moduleTypeId] })
      toast.success(editing ? "Template updated" : "Template created")
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit interface template" : "Add interface template"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <FormText
            label="Name"
            required
            autoFocus
            value={name}
            onChange={setName}
            mono
            placeholder="TenGigabitEthernet1/{module}/1"
            hint="{module} → bay position at install · {position} → stack member"
            error={fieldErrors.name}
          />
          <FormCombobox
            label="Type"
            value={type || null}
            onChange={(v) => setType(v ?? "")}
            noneLabel="No type"
            placeholder="Pick a type"
            searchPlaceholder="Search types…"
            emptyText="No types."
            options={choices.interface_types}
            error={fieldErrors.type}
          />
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <FormCheckbox
              label="Enabled"
              checked={enabled}
              onChange={setEnabled}
            />
            <FormCheckbox
              label="Management only"
              checked={mgmtOnly}
              onChange={setMgmtOnly}
            />
          </div>
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={editing ? "Save changes" : "Create template"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
