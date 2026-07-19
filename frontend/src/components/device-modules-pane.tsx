import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ModuleBayRow,
  type ModuleTypeOption,
  type ModuleWritePayload,
  type Paginated,
} from "@/lib/api"
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
import { Section } from "@/components/ui/section"
import { FormCombobox, FormText, useFieldErrors } from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

/** The device's module bays and what's installed in them. Installing a
 * module stamps its interfaces onto the device ({module} → bay position);
 * removing it takes them away again. */
export function DeviceModulesPane({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canWrite = canDo("device", "change")
  const qc = useQueryClient()
  const [installBay, setInstallBay] = useState<ModuleBayRow | null>(null)
  const [removing, setRemoving] = useState<ModuleBayRow | null>(null)

  const q = useQuery({
    queryKey: ["device-module-bays", deviceId],
    queryFn: () =>
      api<Paginated<ModuleBayRow>>(`/api/module-bays/?device=${deviceId}`),
  })
  const bays = q.data?.results ?? []

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["device-module-bays", deviceId] })
    qc.invalidateQueries({ queryKey: ["device-modules-faceplate", deviceId] })
    qc.invalidateQueries({ queryKey: ["device-interfaces", deviceId] })
    qc.invalidateQueries({
      predicate: (x) =>
        typeof x.queryKey[0] === "string" &&
        (x.queryKey[0] as string).includes("interface"),
    })
  }

  const remove = useMutation({
    mutationFn: (moduleId: string) =>
      api<void>(`/api/modules/${moduleId}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate()
      toast.success("Module removed — its interfaces are gone too")
      setRemoving(null)
    },
    onError: (err) => apiErrorToast(err),
  })

  if (!q.isLoading && !q.isError && bays.length === 0) return null

  return (
    <Section title="Modules" count={bays.length}>
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bay</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Installed module</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {bays.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell className="num font-mono text-xs">
                    {b.position || "—"}
                  </TableCell>
                  <TableCell>
                    {b.module ? (
                      <Link
                        to="/module-types/$id"
                        params={{ id: b.module.module_type.id }}
                        className="text-primary hover:underline"
                      >
                        {b.module.module_type.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">empty</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {b.module?.serial_number || "—"}
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
        </div>
      )}

      <InstallModuleDialog
        deviceId={deviceId}
        bay={installBay}
        onOpenChange={(o) => !o && setInstallBay(null)}
        onInstalled={invalidate}
      />

      <AlertDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing?.module?.module_type.name} from {removing?.name}?
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
              className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (removing?.module) remove.mutate(removing.module.id)
              }}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

function InstallModuleDialog({
  deviceId,
  bay,
  onOpenChange,
  onInstalled,
}: {
  deviceId: string
  bay: ModuleBayRow | null
  onOpenChange: (open: boolean) => void
  onInstalled: () => void
}) {
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [moduleTypeId, setModuleTypeId] = useState<string | null>(null)
  const [serial, setSerial] = useState("")

  useEffect(() => {
    if (!bay) return
    setModuleTypeId(null)
    setSerial("")
    reset()
  }, [bay, reset])

  const types = useQuery({
    queryKey: ["module-types-picker"],
    queryFn: () =>
      api<Paginated<ModuleTypeOption>>("/api/module-types/?picker=1"),
    enabled: !!bay,
    staleTime: 10 * 60_000,
  })

  const install = useMutation({
    mutationFn: () => {
      const payload: ModuleWritePayload = {
        device_id: deviceId,
        module_bay_id: bay!.id,
        module_type_id: moduleTypeId!,
        serial_number: serial.trim(),
      }
      return api<{ created_interfaces?: number }>("/api/modules/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (r) => {
      const n = r.created_interfaces ?? 0
      toast.success(
        `Module installed${n ? ` — ${n} interface${n === 1 ? "" : "s"} added` : ""}`
      )
      onInstalled()
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={!!bay} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install a module in {bay?.name}</DialogTitle>
          <DialogDescription>
            The module type's interfaces are stamped onto this device —{" "}
            <code className="font-mono">{"{module}"}</code> in their names
            resolves to “{bay?.position || "?"}”.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (moduleTypeId) install.mutate()
          }}
          className="grid gap-4"
        >
          <FormCombobox
            label="Module type"
            value={moduleTypeId}
            onChange={setModuleTypeId}
            placeholder="Pick a module type"
            searchPlaceholder="Search module types…"
            emptyText="No module types — import or add them under DCIM → Module types."
            options={(types.data?.results ?? []).map((t) => ({
              value: t.id,
              label: t.part_number ? `${t.name} (${t.part_number})` : t.name,
            }))}
            error={fieldErrors.module_type_id}
          />
          <FormText
            label="Serial number"
            value={serial}
            onChange={setSerial}
            mono
            hint="optional"
            error={fieldErrors.serial_number}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!moduleTypeId || install.isPending}>
              {install.isPending ? "Installing…" : "Install"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
