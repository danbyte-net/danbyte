import { useCallback, useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { InstalledSoftware, Service } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useSaveObject } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FormCombobox,
  FormDate,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { ApplicationPicker } from "@/components/application-picker"
import { DevicePicker } from "@/components/device-picker"
import { VMPicker } from "@/components/vm-picker"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import { useEolSettings } from "@/components/cells/eol-cell"
import { buildInstalledSoftwareColumns } from "@/components/columns/installed-software-columns"

// The Software tab on device and VM pages (#436): what runs on the object,
// regardless of ports. Add and edit in a dialog; delete one or many through
// the shared safe bulk-delete bar.

export type SoftwareParent = { kind: "device" | "vm"; id: string }

const param = (p: SoftwareParent) =>
  p.kind === "device" ? `device=${p.id}` : `virtual_machine=${p.id}`

export const softwareQueryKey = (p: SoftwareParent) =>
  ["installed-software", p.kind, p.id] as const

export function InstalledSoftwarePane({ parent }: { parent: SoftwareParent }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("installedsoftware", "add")
  const canEdit = canDo("installedsoftware", "change")
  const canDelete = canDo("installedsoftware", "delete")
  const eol = useEolSettings()
  const [editing, setEditing] = useState<InstalledSoftware | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<InstalledSoftware | null>(null)
  const [selected, setSelected] = useState<InstalledSoftware[]>([])

  const q = useQuery({
    queryKey: softwareQueryKey(parent),
    queryFn: () =>
      apiAll<InstalledSoftware>(`/api/installed-software/?${param(parent)}`),
  })
  const rows = q.data?.results ?? []
  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["installed-software"] })
    qc.invalidateQueries({ queryKey: ["lifecycle"] })
  }, [qc])

  const columns = useMemo(
    () =>
      buildInstalledSoftwareColumns<InstalledSoftware>({
        omit: ["parent"],
        selection: canDelete,
        eol: eol.enabled,
        warningDays: eol.data?.warning_days,
        actions: {
          onEdit: setEditing,
          canEdit: () => canEdit,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [canEdit, canDelete, eol.enabled, eol.data?.warning_days]
  )

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />

  return (
    <div className="space-y-3">
      {canAdd && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add software
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No software recorded." />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="installed-software"
          embedded
          searchable
          searchPlaceholder="Search software…"
          onSelectedRowsChange={setSelected}
          selectedRows={selected}
        />
      )}
      <InstalledSoftwareDialog
        parent={parent}
        install={editing}
        open={adding || editing != null}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
        onSaved={() => {
          invalidate()
          setAdding(false)
          setEditing(null)
        }}
      />
      <InstalledSoftwareDeleteDialog
        install={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={invalidate}
      />
      <SafeBulkDeleteBar
        selected={selected}
        endpoint="/api/installed-software/"
        noun={["install", "installs"]}
        invalidate={[["installed-software"], ["lifecycle"]]}
        onCleared={() => setSelected([])}
        canDelete={canDelete}
      />
    </div>
  )
}

const PARENT_KINDS = [
  { value: "device", label: "Device" },
  { value: "vm", label: "Virtual machine" },
] as const

/** Add or edit one install. Either the parent is fixed (device and VM
 * Software tabs) and the user picks the application, or the application is
 * fixed (its Installed on tab) and the user picks a device or VM. The service
 * picker lists the parent's own services only; a blank cycle is derived from
 * the version. */
export function InstalledSoftwareDialog({
  parent: fixedParent,
  application,
  install,
  open,
  onOpenChange,
  onSaved,
}: {
  install: InstalledSoftware | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (saved: InstalledSoftware) => void
} & (
  | { parent: SoftwareParent; application?: undefined }
  | { parent?: undefined; application: { id: string } }
)) {
  const isEdit = !!install
  const saveObject = useSaveObject()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [parentKind, setParentKind] = useState<SoftwareParent["kind"]>("device")
  const [parentId, setParentId] = useState<string | null>(null)
  const parent: SoftwareParent | null =
    fixedParent ?? (parentId ? { kind: parentKind, id: parentId } : null)
  const [version, setVersion] = useState("")
  const [cycle, setCycle] = useState("")
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [releaseDate, setReleaseDate] = useState("")
  const [endOfSupport, setEndOfSupport] = useState("")
  const [description, setDescription] = useState("")

  useEffect(() => {
    if (!open) return
    setApplicationId(application?.id ?? install?.application.id ?? null)
    setParentKind(install?.virtual_machine ? "vm" : "device")
    setParentId(install?.device?.id ?? install?.virtual_machine?.id ?? null)
    setVersion(install?.version ?? "")
    // A derived cycle shows as its placeholder, so clearing stays derived.
    setCycle(install?.cycle_manual ? install.cycle : "")
    setServiceId(install?.service?.id ?? null)
    setReleaseDate(install?.release_date ?? "")
    setEndOfSupport(install?.end_of_support ?? "")
    setDescription(install?.description ?? "")
    reset()
  }, [open, install, application?.id, reset])

  const services = useQuery({
    queryKey: ["services", parent?.kind, parent?.id],
    queryFn: () =>
      apiAll<Service>(
        `/api/services/?${parent!.kind === "device" ? "device" : "vm"}=${parent!.id}`
      ),
    enabled: open && !!parent,
  })

  // The service belongs to the parent, so a new parent drops it.
  const pickParent = (id: string | null) => {
    setParentId(id)
    setServiceId(null)
  }

  const save = useMutation({
    mutationFn: () =>
      saveObject<InstalledSoftware>({
        objectType: "api.installedsoftware",
        endpoint: "/api/installed-software/",
        id: install?.id,
        nameField: "version",
        payload: {
          application_id: applicationId,
          ...(parent?.kind === "vm"
            ? { virtual_machine_id: parent.id }
            : { device_id: parent?.id ?? null }),
          version: version.trim(),
          cycle: cycle.trim(),
          service_id: serviceId,
          release_date: releaseDate || null,
          end_of_support: endOfSupport || null,
          description: description.trim(),
        },
      }),
    onSuccess: (saved) => {
      toast.success(
        isEdit
          ? `Updated ${saved.application.name}`
          : `Added ${saved.application.name}`
      )
      onSaved(saved)
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
          <DialogTitle>{isEdit ? "Edit software" : "Add software"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
          className="grid gap-4"
        >
          {fixedParent ? (
            <ApplicationPicker
              required
              value={applicationId}
              onChange={setApplicationId}
              error={fieldErrors.application_id}
            />
          ) : (
            <>
              <Field label="Installed on">
                <SegmentedTabs
                  items={PARENT_KINDS}
                  value={parentKind}
                  onValueChange={(v) => {
                    if (v === parentKind) return
                    setParentKind(v)
                    setParentId(null)
                    setServiceId(null)
                  }}
                />
              </Field>
              {parentKind === "device" ? (
                <DevicePicker
                  required
                  value={parentId}
                  onChange={pickParent}
                  error={fieldErrors.device_id}
                />
              ) : (
                <VMPicker
                  required
                  value={parentId}
                  onChange={pickParent}
                  error={fieldErrors.virtual_machine_id}
                />
              )}
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Version"
              value={version}
              onChange={setVersion}
              mono
              placeholder="16.4"
              error={fieldErrors.version}
            />
            <FormText
              label="Cycle"
              value={cycle}
              onChange={setCycle}
              mono
              placeholder={
                install && !install.cycle_manual && install.cycle
                  ? install.cycle
                  : "From version"
              }
              error={fieldErrors.cycle}
            />
          </div>
          <FormCombobox
            label="Service"
            hint="optional"
            value={serviceId}
            onChange={setServiceId}
            options={(services.data?.results ?? []).map((s) => ({
              value: s.id,
              label: s.name,
            }))}
            noneLabel="No service"
            placeholder="Select a service…"
            searchPlaceholder="Search services…"
            emptyText="No services here."
            error={fieldErrors.service_id}
          />
          <div className="grid grid-cols-2 gap-3">
            <FormDate
              label="Released"
              value={releaseDate}
              onChange={setReleaseDate}
              error={fieldErrors.release_date}
            />
            <FormDate
              label="End of support"
              value={endOfSupport}
              onChange={setEndOfSupport}
              error={fieldErrors.end_of_support}
            />
          </div>
          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save changes" : "Add software"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

function InstalledSoftwareDeleteDialog({
  install,
  onOpenChange,
  onDeleted,
}: {
  install: InstalledSoftware | null
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/installed-software/${install!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Removed ${install!.application.name}`)
      onOpenChange(false)
      onDeleted()
    },
    onError: (err) => apiErrorToast(err),
  })
  const label = install
    ? `${install.application.name} ${install.version}`.trim()
    : ""
  return (
    <AlertDialog open={!!install} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            This action can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
