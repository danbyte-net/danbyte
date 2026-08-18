import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Plus } from "lucide-react"

import { api, type DhcpReservation, type DhcpScope } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { DhcpScopeDialog } from "@/components/integrations/dhcp-scope-dialog"

/** Create or edit a DHCP reservation. Saving pushes to the Windows server
 * first — the row only exists once the server accepted it. Scope and IP are
 * fixed after creation (that's how Windows keys reservations). */
export function DhcpReservationDialog({
  scopes,
  reservation,
  onOpenChange,
}: {
  scopes: DhcpScope[]
  /** Present = edit; absent = create. */
  reservation?: DhcpReservation
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const isEdit = !!reservation
  const [addingScope, setAddingScope] = useState(false)
  const canAddScope = canDo("dhcpscope", "add")
  const [scope, setScope] = useState(reservation?.scope ?? scopes[0]?.id ?? "")
  const [ip, setIp] = useState(reservation?.ip ?? "")
  const [mac, setMac] = useState(reservation?.mac ?? "")
  const [name, setName] = useState(reservation?.name ?? "")
  const [description, setDescription] = useState(reservation?.description ?? "")

  const save = useMutation({
    mutationFn: () => {
      const body = { scope, ip: ip.trim(), mac: mac.trim(), name, description }
      if (isEdit)
        return api<DhcpReservation>(
          `/api/dhcp-reservations/${reservation.id}/`,
          {
            method: "PATCH",
            body: JSON.stringify({ mac: mac.trim(), name, description }),
          }
        )
      return api<DhcpReservation>("/api/dhcp-reservations/", {
        method: "POST",
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      reset()
      toast.success(
        isEdit ? "Reservation updated on the server" : "Reservation created"
      )
      qc.invalidateQueries({ queryKey: ["dhcp-reservations"] })
      qc.invalidateQueries({ queryKey: ["dhcp-scopes"] })
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const ready = mac.trim() && (isEdit || (ip.trim() && scope))
  const selectedScope = scopes.find((s) => s.id === scope)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit reservation ${reservation.ip}` : "New reservation"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) save.mutate()
          }}
          className="grid gap-3"
        >
          {!isEdit && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <FormSelect
                  label="Scope"
                  value={scope}
                  onChange={(v) => setScope(v ?? "")}
                  options={scopes.map((s) => ({
                    value: s.id,
                    label: `${s.scope_id}${s.name ? ` — ${s.name}` : ""}${
                      s.is_local ? " · local" : ""
                    }`,
                  }))}
                  error={fieldErrors.scope}
                />
              </div>
              {canAddScope && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title="Create a new scope"
                  onClick={() => setAddingScope(true)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
          {!isEdit && (
            <FormText
              label="IP address"
              value={ip}
              onChange={setIp}
              required
              mono
              placeholder="10.77.0.60"
              error={fieldErrors.ip}
            />
          )}
          <FormText
            label="MAC address"
            value={mac}
            onChange={setMac}
            required
            mono
            placeholder="aa:bb:cc:00:11:22"
            error={fieldErrors.mac}
          />
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            placeholder="printer-1"
            error={fieldErrors.name}
          />
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="optional"
            error={fieldErrors.description}
          />
          <p className="text-[11px] text-muted-foreground">
            {selectedScope?.is_local
              ? "Local scope — the reservation is stored in Danbyte only."
              : "Saving writes the reservation to the DHCP server immediately."}
          </p>
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save changes" : "Create"}
          />
        </form>
      </DialogContent>
      {addingScope && (
        <DhcpScopeDialog
          onOpenChange={setAddingScope}
          onCreated={(s) => setScope(s.id)}
        />
      )}
    </Dialog>
  )
}
