import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type DeviceBayRow, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Section } from "@/components/ui/section"
import { DevicePicker } from "@/components/device-picker"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

/** The chassis's device bays and the child devices installed in them —
 * blades, FEX: whole devices, unlike modules (which contribute ports). */
export function DeviceBaysPane({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canWrite = canDo("device", "change")
  const qc = useQueryClient()
  const [installBay, setInstallBay] = useState<DeviceBayRow | null>(null)

  const q = useQuery({
    queryKey: ["device-device-bays", deviceId],
    queryFn: () =>
      api<Paginated<DeviceBayRow>>(`/api/device-bays/?device=${deviceId}`),
  })
  const bays = q.data?.results ?? []

  const setInstalled = useMutation({
    mutationFn: ({
      bayId,
      childId,
    }: {
      bayId: string
      childId: string | null
    }) =>
      api<DeviceBayRow>(`/api/device-bays/${bayId}/`, {
        method: "PATCH",
        body: JSON.stringify({ installed_device_id: childId }),
      }),
    onSuccess: (_, { childId }) => {
      qc.invalidateQueries({ queryKey: ["device-device-bays", deviceId] })
      toast.success(childId ? "Device installed" : "Bay emptied")
      setInstallBay(null)
    },
    onError: (err) => apiErrorToast(err),
  })

  if (!q.isLoading && !q.isError && bays.length === 0) return null

  return (
    <Section title="Device bays" count={bays.length}>
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
                <TableHead>Installed device</TableHead>
                <TableHead>Description</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {bays.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell>
                    {b.installed_device ? (
                      <Link
                        to="/devices/$id"
                        params={{ id: b.installed_device.id }}
                        className="text-primary hover:underline"
                      >
                        {b.installed_device.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">empty</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {b.description || "—"}
                  </TableCell>
                  <TableCell>
                    {canWrite && (
                      <div className="flex justify-end">
                        {b.installed_device ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() =>
                              setInstalled.mutate({
                                bayId: b.id,
                                childId: null,
                              })
                            }
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

      <InstallChildDialog
        deviceId={deviceId}
        bay={installBay}
        onOpenChange={(o) => !o && setInstallBay(null)}
        onPick={(childId) =>
          installBay && setInstalled.mutate({ bayId: installBay.id, childId })
        }
        busy={setInstalled.isPending}
      />
    </Section>
  )
}

function InstallChildDialog({
  deviceId,
  bay,
  onOpenChange,
  onPick,
  busy,
}: {
  deviceId: string
  bay: DeviceBayRow | null
  onOpenChange: (open: boolean) => void
  onPick: (childId: string) => void
  busy: boolean
}) {
  const [childId, setChildId] = useState<string | null>(null)
  return (
    <Dialog
      open={!!bay}
      onOpenChange={(o) => {
        if (!o) setChildId(null)
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install a device in {bay?.name}</DialogTitle>
          <DialogDescription>
            The child device keeps its own ports, IPs and lifecycle — the bay
            just records where it physically lives.
          </DialogDescription>
        </DialogHeader>
        <DevicePicker
          label="Child device"
          value={childId}
          onChange={setChildId}
          excludeIds={[deviceId]}
          placeholder="Pick a device"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!childId || busy}
            onClick={() => childId && onPick(childId)}
          >
            {busy ? "Installing…" : "Install"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
