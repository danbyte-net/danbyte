import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { HardDrive } from "lucide-react"

import { api } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/section"
import { Input } from "@/components/ui/input"
import { Field, FormCheckbox } from "@/components/forms"
import { TimeCell } from "@/components/cells/time-ago"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

interface RedfishPart {
  name: string
  serial: string
  health: string
}

interface RedfishState {
  device: string
  host: string
  port?: number
  verify_tls?: boolean
  enabled?: boolean
  has_credentials: boolean
  data: {
    system?: { manufacturer?: string; model?: string; health?: string }
    drives?: RedfishPart[]
    processors?: RedfishPart[]
    memory?: RedfishPart[]
    psus?: RedfishPart[]
    fans?: RedfishPart[]
  }
  reachable: boolean | null
  error: string
  polled_at: string | null
}

/**
 * The device's BMC (Redfish) - configure the endpoint, poll on demand, and
 * see the hardware the collector reconciled into the Hardware tab. iDRAC,
 * iLO, XClarity, Supermicro and UCS BMCs all speak Redfish.
 */
export function DeviceRedfishCard({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canWrite = canDo("device", "change")
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ["device-redfish", deviceId],
    queryFn: () =>
      api<RedfishState>(`/api/monitoring/devices/${deviceId}/redfish/`),
  })

  const [host, setHost] = useState("")
  const [port, setPort] = useState("443")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [verifyTls, setVerifyTls] = useState(false)
  useEffect(() => {
    if (!q.data) return
    setHost(q.data.host ?? "")
    setPort(String(q.data.port ?? 443))
    setVerifyTls(!!q.data.verify_tls)
  }, [q.data])

  const invalidateHardware = () => {
    qc.invalidateQueries({ queryKey: ["device-redfish", deviceId] })
    qc.invalidateQueries({ queryKey: ["device-inventory", deviceId] })
    qc.invalidateQueries({ queryKey: ["device-face-ports", deviceId] })
  }

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        host: host.trim(),
        port: Number(port) || 443,
        verify_tls: verifyTls,
      }
      // Credentials only travel when typed - blank means "keep stored".
      if (username || password) {
        payload.username = username
        payload.password = password
      }
      return api<RedfishState>(`/api/monitoring/devices/${deviceId}/redfish/`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      toast.success("BMC endpoint saved")
      setUsername("")
      setPassword("")
      invalidateHardware()
    },
    onError: (e) => apiErrorToast(e),
  })

  const poll = useMutation({
    mutationFn: () =>
      api<RedfishState>(`/api/monitoring/devices/${deviceId}/redfish-poll/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      if (r.reachable) toast.success("BMC polled - hardware reconciled")
      else toast.error(`BMC unreachable: ${r.error || "unknown error"}`)
      invalidateHardware()
    },
    onError: (e) => apiErrorToast(e),
  })

  const s = q.data
  const configured = !!s?.host
  const counts = s?.data
    ? (
        [
          ["drives", "disks"],
          ["processors", "CPUs"],
          ["memory", "DIMMs"],
          ["psus", "PSUs"],
          ["fans", "fans"],
        ] as const
      )
        .map(([k, label]) => {
          const list = (s.data[k] ?? []) as RedfishPart[]
          return list.length ? `${list.length} ${label}` : ""
        })
        .filter(Boolean)
        .join(" · ")
    : ""
  const failing = s?.data
    ? (["drives", "processors", "memory", "psus", "fans"] as const).flatMap(
        (k) =>
          ((s.data[k] ?? []) as RedfishPart[]).filter(
            (p) => p.health && p.health !== "ok"
          )
      )
    : []

  return (
    <Section
      title="BMC (Redfish)"
      actions={
        canWrite && configured ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => poll.mutate()}
            disabled={poll.isPending}
          >
            <HardDrive className="h-3.5 w-3.5" />
            {poll.isPending ? "Polling…" : "Poll now"}
          </Button>
        ) : undefined
      }
    >
      {/* No `p-4` - matches the sensors card it sits beside. Section draws no
          box, so the inset only misaligned the body from its own heading. */}
      <div className="grid gap-3">
        {configured && (
          <div className="grid gap-1 text-[13px]">
            <div className="flex items-center gap-2">
              {/* Shared Badge - same reachability treatment as the SNMP card. */}
              <Badge
                variant={
                  !s?.polled_at
                    ? "secondary"
                    : s?.reachable
                      ? "success"
                      : "destructive"
                }
              >
                {s?.polled_at
                  ? s?.reachable
                    ? "reachable"
                    : "unreachable"
                  : "never polled"}
              </Badge>
              {s?.polled_at && (
                <span className="text-muted-foreground">
                  last poll <TimeCell iso={s.polled_at} />
                </span>
              )}
            </div>
            {s?.error && (
              <p className="text-[12px] text-destructive">{s.error}</p>
            )}
            {counts && (
              <p className="text-muted-foreground">
                {s?.data.system?.manufacturer} {s?.data.system?.model} -{" "}
                {counts}
              </p>
            )}
            {failing.length > 0 && (
              <p className="text-[12px] text-destructive">
                {failing.length} part{failing.length === 1 ? "" : "s"} not
                healthy: {failing.map((p) => p.name).join(", ")}
              </p>
            )}
          </div>
        )}

        {canWrite ? (
          <div className="grid gap-3">
            <div className="grid grid-cols-[1fr_100px] gap-3">
              <Field label="BMC address" hint="iDRAC / iLO / XClarity IP">
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="192.168.10.5"
                  className="h-8 font-mono text-[13px]"
                />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  className="h-8 text-[13px]"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Username"
                hint={s?.has_credentials ? "blank = keep stored" : undefined}
              >
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  className="h-8 text-[13px]"
                />
              </Field>
              <Field
                label="Password"
                hint={s?.has_credentials ? "blank = keep stored" : undefined}
              >
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className="h-8 text-[13px]"
                />
              </Field>
            </div>
            <FormCheckbox
              label="Verify TLS"
              checked={verifyTls}
              onChange={setVerifyTls}
              hint="BMCs usually present self-signed certificates"
            />
            <div>
              <Button
                size="sm"
                onClick={() => save.mutate()}
                disabled={!host.trim() || save.isPending}
              >
                {save.isPending ? "Saving…" : configured ? "Save" : "Add BMC"}
              </Button>
            </div>
          </div>
        ) : !configured ? (
          <p className="text-sm text-muted-foreground">
            No BMC configured for this device.
          </p>
        ) : null}
      </div>
    </Section>
  )
}
