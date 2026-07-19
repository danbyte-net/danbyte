import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type GhostEdgeData } from "@/lib/api"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/forms"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Combobox } from "@/components/ui/combobox"
import { apiErrorToast } from "@/lib/api-toast"

/**
 * Turn an LLDP "ghost" link into a real Cable. SNMP can't report the physical
 * connector, so the operator picks the cable type (and, if the devices are
 * adjacent on more than one link, which port pair to cable).
 */
export function MaterializeCableDialog({
  ghost,
  onClose,
}: {
  ghost: GhostEdgeData | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const choices = useDcimChoices()
  const [type, setType] = useState("")
  const [pairIdx, setPairIdx] = useState("0")

  // Reset the form each time a new ghost is opened.
  useEffect(() => {
    setType("")
    setPairIdx("0")
  }, [ghost])

  const create = useMutation({
    mutationFn: () => {
      if (!ghost) throw new Error("No link selected")
      const pair = ghost.pairs[Number(pairIdx)] ?? ghost.pairs[0]
      return api<{ cable_id: string }>(
        "/api/monitoring/topology/materialize-cable/",
        {
          method: "POST",
          body: JSON.stringify({
            source_device: ghost.source_device,
            remote_device: ghost.target_device,
            local_port: pair.a,
            remote_port: pair.b,
            type,
          }),
        }
      )
    },
    onSuccess: () => {
      toast.success("Cable created from LLDP link")
      qc.invalidateQueries({ queryKey: ["topology"] })
      qc.invalidateQueries({ queryKey: ["topology-ghosts"] })
      qc.invalidateQueries({ queryKey: ["device-topology"] })
      qc.invalidateQueries({ queryKey: ["device-topology-ghosts"] })
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })

  const open = ghost !== null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create cable from LLDP link</DialogTitle>
          <DialogDescription>
            These devices are LLDP neighbours but aren't cabled in Danbyte. Pick
            the cable type to record the connection.
          </DialogDescription>
        </DialogHeader>

        {ghost && (
          <div className="grid gap-4">
            {ghost.pairs.length > 1 ? (
              <Field label="Port pair">
                <Select value={pairIdx} onValueChange={setPairIdx}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ghost.pairs.map((p, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {p.a} ↔ {p.b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <div className="text-sm">
                <span className="text-muted-foreground">Ports: </span>
                <span className="font-mono">
                  {ghost.pairs[0]?.a} ↔ {ghost.pairs[0]?.b}
                </span>
              </div>
            )}

            <Field label="Cable type">
              <Combobox
                value={type || null}
                onChange={(v) => setType(v ?? "")}
                options={choices.cable_types}
                placeholder="Select a type"
                searchPlaceholder="Search types…"
                emptyText="No types."
              />
            </Field>
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={create.isPending || !type}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create cable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
