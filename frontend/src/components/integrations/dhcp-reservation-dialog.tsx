import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Plus } from "lucide-react"

import { api, type DhcpReservation, type DhcpScope } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormSelect, FormText } from "@/components/forms"
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
      toast.success(
        isEdit ? "Reservation updated on the server" : "Reservation created"
      )
      qc.invalidateQueries({ queryKey: ["dhcp-reservations"] })
      qc.invalidateQueries({ queryKey: ["dhcp-scopes"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit reservation ${reservation.ip}` : "New reservation"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {!isEdit && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <FormSelect
                  label="Scope"
                  value={scope}
                  onChange={(v) => setScope(v ?? "")}
                  options={scopes.map((s) => ({
                    value: s.id,
                    label: `${s.scope_id}${s.name ? ` — ${s.name}` : ""}`,
                  }))}
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
            />
          )}
          <FormText
            label="MAC address"
            value={mac}
            onChange={setMac}
            required
            mono
            placeholder="aa:bb:cc:00:11:22"
          />
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            placeholder="printer-1"
          />
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="optional"
          />
          <p className="text-[11px] text-muted-foreground">
            Saving writes the reservation to the DHCP server immediately.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              save.isPending ||
              !mac.trim() ||
              (!isEdit && (!ip.trim() || !scope))
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
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
