import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  ApiError,
  api,
  type ModuleBayRow,
  type ModuleTypeOption,
  type ModuleWritePayload,
  type Status,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ScrollFrame } from "@/components/table-scroll"
import { Section } from "@/components/ui/section"
import {
  FormCheckbox,
  FormCombobox,
  FormStatusSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { StatusBadge } from "@/components/status-badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { invalidatePortCounts } from "@/lib/port-utilization"
import { useSaveObject } from "@/lib/save-object"

/** The statuses a module may wear: the catalog's, offered to modules. */
function useModuleStatuses(enabled = true) {
  return useQuery({
    queryKey: ["statuses", "module"],
    queryFn: () =>
      apiAll<Status>("/api/statuses/?available_to=module&picker=1"),
    enabled,
    staleTime: 5 * 60_000,
  })
}

/** An installed module's status, and - for whoever may change the device -
 * the catalog's statuses to set it to. It drives the module's status LEDs. */
function ModuleStatusCell({
  deviceId,
  module,
  canWrite,
}: {
  deviceId: string
  module: NonNullable<ModuleBayRow["module"]>
  canWrite: boolean
}) {
  const qc = useQueryClient()
  const statuses = useModuleStatuses(canWrite)
  const set = useMutation({
    mutationFn: (statusId: string) =>
      api(`/api/modules/${module.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ status_id: statusId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["device-module-bays", deviceId] })
      void qc.invalidateQueries({ queryKey: ["device-leds"] })
    },
    onError: (err) => apiErrorToast(err, "Couldn't set the module's status"),
  })
  const badge = module.status ? (
    <StatusBadge status={module.status} />
  ) : (
    <span className="text-muted-foreground">-</span>
  )
  if (!canWrite) return badge
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="rounded-md"
        disabled={set.isPending}
        aria-label={`Status of ${module.module_type.name}`}
      >
        {badge}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto">
        <DropdownMenuRadioGroup
          value={module.status?.id ?? ""}
          onValueChange={(v) => v && set.mutate(v)}
        >
          {(statuses.data?.results ?? []).map((s) => (
            <DropdownMenuRadioItem key={s.id} value={s.id}>
              <StatusBadge status={s} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The device's module bays and what's installed in them. Installing a
 * module stamps its interfaces onto the device ({module} → bay position);
 * removing it takes them away again. */
export function DeviceModulesPane({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canWrite = canDo("device", "change")
  const [installBay, setInstallBay] = useState<ModuleBayRow | null>(null)
  const [removing, setRemoving] = useState<ModuleBayRow | null>(null)

  const q = useQuery({
    queryKey: ["device-module-bays", deviceId],
    queryFn: () => apiAll<ModuleBayRow>(`/api/module-bays/?device=${deviceId}`),
  })
  const bays = q.data?.results ?? []

  if (!q.isLoading && !q.isError && bays.length === 0) return null

  return (
    <Section title="Modules" count={bays.length}>
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ScrollFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bay</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Installed module</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead>Description</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {bays.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell className="num font-mono text-xs">
                    {b.position || "-"}
                  </TableCell>
                  <TableCell>
                    {b.module ? (
                      <Link
                        to="/module-types/$id"
                        params={{ id: b.module.module_type.id }}
                        className="link"
                      >
                        {b.module.module_type.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">empty</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {b.module ? (
                      <ModuleStatusCell
                        deviceId={deviceId}
                        module={b.module}
                        canWrite={canWrite}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {b.module?.serial_number || "-"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {b.description || "-"}
                  </TableCell>
                  <TableCell>
                    {canWrite && (
                      <div className="flex justify-end">
                        {b.module ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setRemoving(b)}
                          >
                            Remove
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setInstallBay(b)}
                          >
                            Install…
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollFrame>
      )}

      <InstallModuleDialog
        deviceId={deviceId}
        bay={installBay}
        onOpenChange={(o) => !o && setInstallBay(null)}
      />

      <RemoveModuleDialog
        deviceId={deviceId}
        target={
          removing?.module
            ? {
                moduleId: removing.module.id,
                typeName: removing.module.module_type.name,
                bayName: removing.name,
              }
            : null
        }
        onOpenChange={(o) => !o && setRemoving(null)}
      />
    </Section>
  )
}

/** Everything a seated or removed module changes: the bay list, the
 * composed faceplate, the stamped interfaces, the photo/3D markers'
 * occupancy, and the device itself - its effective 3D model lists the
 * bays' parts, so the assembled model follows. */
export function invalidateModuleCaches(qc: QueryClient, deviceId: string) {
  qc.invalidateQueries({ queryKey: ["device-module-bays", deviceId] })
  qc.invalidateQueries({ queryKey: ["device-modules-faceplate", deviceId] })
  qc.invalidateQueries({ queryKey: ["device-interfaces", deviceId] })
  qc.invalidateQueries({
    predicate: (x) =>
      typeof x.queryKey[0] === "string" && x.queryKey[0].includes("interface"),
  })
  qc.invalidateQueries({ queryKey: ["device-power-ports", deviceId] })
  qc.invalidateQueries({ queryKey: ["device-face-ports", deviceId] })
  qc.invalidateQueries({ queryKey: ["device", deviceId] })
  invalidatePortCounts(qc)
}

/** Remove the module in a bay, after a confirm. Shared by the Modules pane
 * and the 3D model viewer's bay menu: one write, one set of refreshes. */
export function RemoveModuleDialog({
  deviceId,
  target,
  onOpenChange,
  onRemoved,
}: {
  deviceId: string
  target: { moduleId: string; typeName: string; bayName: string } | null
  onOpenChange: (open: boolean) => void
  onRemoved?: () => void
}) {
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: (moduleId: string) =>
      api<void>(`/api/modules/${moduleId}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateModuleCaches(qc, deviceId)
      toast.success("Module removed - its interfaces are gone too")
      onRemoved?.()
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!target} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove {target?.typeName} from {target?.bayName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The interfaces this module contributed to the device are removed
            with it (matched by name).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={(e) => {
              e.preventDefault()
              if (target) remove.mutate(target.moduleId)
            }}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** What a module save answers: an install's created counts, a replace's
 * re-stamp report, and the components taken over either way. */
interface InstallResult {
  created_interfaces?: number
  adopted?: string[]
  interfaces?: { adopted?: string[] }
}

/** The module in a bay, for the dialog's replace and edit modes. */
export interface SeatedModule {
  id: string
  module_type: { id: string; name: string }
  status?: { id: string } | null
  serial_number: string
}

/** Install a module into a bay. Exported so the 2D photo faceplate and the 3D
 * room can open the same dialog from a clicked bay marker - one write path,
 * one set of cache invalidations, whichever surface the click came from. `bay`
 * needs only id + name (a marker doesn't know the bay's position). */
export function InstallModuleDialog({
  deviceId,
  bay,
  onOpenChange,
  onInstalled,
  seated = null,
  mode = "install",
  manufacturerId = null,
}: {
  deviceId: string
  bay: { id: string; name: string; position?: string } | null
  onOpenChange: (open: boolean) => void
  /** Extra refresh work for the host - the module/interface/face-port caches
   * are already invalidated here. */
  onInstalled?: () => void
  /** The module already in the bay: `replace` swaps its type (the server
   * re-stamps its interfaces), `edit` changes its status and serial. */
  seated?: SeatedModule | null
  mode?: "install" | "replace" | "edit"
  /** Offer this manufacturer's module types first: the chassis' own. All
   * types show when it has none. */
  manufacturerId?: string | null
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const [moduleTypeId, setModuleTypeId] = useState<string | null>(null)
  const [statusId, setStatusId] = useState<string | null>(null)
  const [serial, setSerial] = useState("")
  const statuses = useModuleStatuses(!!bay)
  // The server named interfaces a type swap would drop: saving again
  // confirms their removal.
  const [confirmRemove, setConfirmRemove] = useState(false)
  // The server named same-named components the device already has that the
  // module may take over: the option to adopt them, off until ticked.
  const [adoptable, setAdoptable] = useState<string[]>([])
  const [adopt, setAdopt] = useState(false)
  const existing = mode === "install" ? null : seated

  useEffect(() => {
    if (!bay) return
    setModuleTypeId(existing?.module_type.id ?? null)
    setStatusId(existing?.status?.id ?? null)
    setSerial(existing?.serial_number ?? "")
    setConfirmRemove(false)
    setAdoptable([])
    setAdopt(false)
    reset()
    // Keyed on the module's id: a host building `seated` inline must not
    // wipe what is being typed on every render.
  }, [bay, existing?.id, reset])
  // The catalog's default for modules, once it has loaded.
  const defaultStatus =
    statuses.data?.results.find((s) => s.default_for.includes("module"))?.id ??
    null
  const pickedStatus = statusId ?? defaultStatus

  const types = useQuery({
    queryKey: ["module-types-picker"],
    queryFn: () => apiAll<ModuleTypeOption>("/api/module-types/?picker=1"),
    enabled: !!bay && mode !== "edit",
    staleTime: 10 * 60_000,
  })
  const ownMake = useQuery({
    queryKey: ["module-types-picker", { manufacturer: manufacturerId }],
    queryFn: () =>
      apiAll<ModuleTypeOption>(
        `/api/module-types/?picker=1&manufacturer=${manufacturerId}`
      ),
    enabled: !!bay && mode !== "edit" && !!manufacturerId,
    staleTime: 10 * 60_000,
  })
  const typeOptions =
    manufacturerId && ownMake.data?.results.length
      ? ownMake.data.results
      : (types.data?.results ?? [])

  const install = useMutation({
    mutationFn: () => {
      if (existing) {
        const body: Record<string, unknown> = {
          serial_number: serial.trim(),
          status_id: pickedStatus,
        }
        if (mode === "replace") body.module_type_id = moduleTypeId
        if (confirmRemove) body.confirm_remove = true
        if (adopt) body.adopt_components = true
        return saveObject<InstallResult>({
          objectType: "api.module",
          endpoint: "/api/modules/",
          id: existing.id,
          payload: body,
        })
      }
      const payload: ModuleWritePayload = {
        device_id: deviceId,
        module_bay_id: bay!.id,
        module_type_id: moduleTypeId!,
        status_id: pickedStatus,
        serial_number: serial.trim(),
      }
      if (adopt) payload.adopt_components = true
      return saveObject<InstallResult>({
        objectType: "api.module",
        endpoint: "/api/modules/",
        payload,
      })
    },
    onSuccess: (r) => {
      // Everything a seated module changes, invalidated HERE so every host -
      // the Modules pane, the 2D faceplate, the 3D room and viewer -
      // refreshes the same way.
      invalidateModuleCaches(qc, deviceId)
      const adopted = r.adopted?.length ?? r.interfaces?.adopted?.length ?? 0
      const took = adopted ? ` - ${adopted} adopted` : ""
      if (mode === "install") {
        const n = r.created_interfaces ?? 0
        toast.success(
          `Module installed${n ? ` - ${n} interface${n === 1 ? "" : "s"} added` : ""}${took}`
        )
      } else
        toast.success(
          (mode === "replace" ? "Module replaced" : "Module saved") + took
        )
      onInstalled?.()
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
      if (
        err instanceof ApiError &&
        err.status === 400 &&
        err.body &&
        typeof err.body === "object" &&
        "confirm_remove" in err.body
      )
        setConfirmRemove(true)
      if (
        err instanceof ApiError &&
        err.status === 400 &&
        err.body &&
        typeof err.body === "object" &&
        "adoptable" in err.body
      ) {
        const names = (err.body as { adoptable?: unknown }).adoptable
        setAdoptable(Array.isArray(names) ? names.map(String) : [])
      }
    },
  })
  const title =
    mode === "replace"
      ? `Replace the module in ${bay?.name ?? ""}`
      : mode === "edit"
        ? `Edit the module in ${bay?.name ?? ""}`
        : `Install a module in ${bay?.name ?? ""}`

  return (
    <Dialog open={!!bay} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {mode === "edit" ? (
            <DialogDescription>{existing?.module_type.name}</DialogDescription>
          ) : (
            <DialogDescription>
              The module type's interfaces are stamped onto this device -{" "}
              <code className="font-mono">{"{module}"}</code> in their names
              resolves to “{bay?.position || "?"}”.
            </DialogDescription>
          )}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (moduleTypeId || mode === "edit") install.mutate()
          }}
          className="grid gap-4"
        >
          {mode !== "edit" && (
            <FormCombobox
              label="Module type"
              value={moduleTypeId}
              onChange={(v) => {
                setModuleTypeId(v)
                setConfirmRemove(false)
                setAdoptable([])
                setAdopt(false)
              }}
              placeholder="Pick a module type"
              searchPlaceholder="Search module types…"
              emptyText="No module types - import or add them under DCIM → Catalog → Module types."
              options={typeOptions.map((t) => ({
                value: t.id,
                label: t.part_number ? `${t.name} (${t.part_number})` : t.name,
              }))}
              error={fieldErrors.module_type_id}
            />
          )}
          <FormStatusSelect
            value={pickedStatus}
            onChange={setStatusId}
            options={statuses.data?.results ?? []}
            error={fieldErrors.status_id}
          />
          <FormText
            label="Serial number"
            value={serial}
            onChange={setSerial}
            mono
            hint="optional"
            error={fieldErrors.serial_number}
          />
          {adoptable.length > 0 && (
            <FormCheckbox
              label="Adopt existing components"
              checked={adopt}
              onChange={setAdopt}
              info={`The module takes over ${adoptable.join(", ")} - same ports, so their cables, IP addresses and settings stay.`}
            />
          )}
          {confirmRemove && fieldErrors.confirm_remove && (
            <p className="text-sm text-destructive">
              {fieldErrors.confirm_remove}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={(mode !== "edit" && !moduleTypeId) || install.isPending}
            >
              {install.isPending
                ? mode === "install"
                  ? "Installing…"
                  : "Saving…"
                : mode === "install"
                  ? "Install"
                  : mode === "edit"
                    ? "Save"
                    : confirmRemove
                      ? "Replace anyway"
                      : "Replace"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
