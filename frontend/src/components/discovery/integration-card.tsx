import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DiscoverySettings, DiscoveryStatus } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/ui/info-tip"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TimeCell } from "@/components/cells/time-ago"

// The body of the Discovery card under Settings → Integrations (#451): the
// deployment switch (stored, or locked by DANBYTE_DISCOVERY_ENABLED) and
// the transports discovery may log in with, most secure first.

function SwitchRow({
  label,
  info,
  checked,
  disabled,
  reason,
  badge,
  onChange,
}: {
  label: string
  info: React.ReactNode
  checked: boolean
  disabled?: boolean
  /** Why it is disabled, in a tooltip over the switch. */
  reason?: string
  badge?: React.ReactNode
  onChange?: (v: boolean) => void
}) {
  const control = (
    <Switch
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={label}
    />
  )
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs whitespace-nowrap">{label}</span>
        <InfoTip>{info}</InfoTip>
        <span className="ml-auto">
          {disabled && reason ? (
            <Tooltip>
              {/* A Tooltip trigger overwrites data-state; the span keeps the
                switch's own. */}
              <TooltipTrigger asChild>
                <span className="inline-flex">{control}</span>
              </TooltipTrigger>
              <TooltipContent variant="panel">{reason}</TooltipContent>
            </Tooltip>
          ) : (
            control
          )}
        </span>
      </div>
      {badge && <div className="flex">{badge}</div>}
    </div>
  )
}

export function DeploymentRow({ status }: { status: DiscoveryStatus }) {
  const qc = useQueryClient()
  const d = status.deployment
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      api<DiscoveryStatus>("/api/discovery/deployment/", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (s) => {
      qc.setQueryData(["discovery", "status"], s)
      toast.success(
        s.deployment.enabled
          ? "Discovery allowed on this deployment"
          : "Discovery off for this deployment"
      )
    },
    onError: (err) => apiErrorToast(err),
  })
  const locked = d.source === "env"
  const badge = locked ? (
    <Badge variant={d.enabled ? "success" : "secondary"}>
      {d.enabled
        ? "Locked on by the deployment"
        : "Locked off by the deployment"}
    </Badge>
  ) : null
  return (
    <div className="space-y-0.5">
      <SwitchRow
        label="This deployment"
        info={
          locked ? (
            <>
              Set by{" "}
              <code className="font-mono">DANBYTE_DISCOVERY_ENABLED</code> in
              the server environment, so nobody can change it here. Remove the
              variable to switch it from this card.
            </>
          ) : (
            <>
              Whether any tenant may use discovery. Deployment admins switch it;
              every change is in the change log.
            </>
          )
        }
        checked={d.enabled}
        disabled={locked || !d.can_change || save.isPending}
        reason={
          locked
            ? undefined
            : !d.can_change
              ? "Deployment admins change this."
              : undefined
        }
        badge={badge}
        onChange={(v) => save.mutate(v)}
      />
      {!locked && d.changed_at && (
        <p className="text-[11px] text-muted-foreground">
          {d.enabled ? "Turned on" : "Turned off"} by{" "}
          {d.changed_by || "someone"} <TimeCell iso={d.changed_at} />
        </p>
      )}
    </div>
  )
}

const TRANSPORT_INFO = {
  ssh_key:
    "SSH to Linux and Windows hosts with a key login, after the host's SSH key was accepted. Tried first.",
  ssh_password:
    "SSH with a password login, after the host's SSH key was accepted. Turning it off also stops password logins to Linux hosts.",
  winrm:
    "WinRM over HTTPS with the server certificate verified and a client certificate. Tried last, for hosts without SSH. Plain HTTP, NTLM, Basic and CredSSP are never used.",
}

export function TransportRows({ active }: { active: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["discovery", "settings"],
    queryFn: () => api<DiscoverySettings>("/api/discovery/settings/"),
    enabled: active,
  })
  const save = useMutation({
    mutationFn: (patch: Partial<DiscoverySettings["transports"]>) =>
      api<DiscoverySettings>("/api/discovery/settings/", {
        method: "PATCH",
        body: JSON.stringify({ transports: patch }),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["discovery", "settings"], d)
      toast.success("Discovery transports saved")
    },
    onError: (err) => apiErrorToast(err),
  })
  if (!active || !q.data?.transports) return null
  const s = q.data
  const t = s.transports
  const off = !s.can_change || save.isPending
  const why = !s.can_change ? "Tenant admins change this." : undefined
  const winrmReason = s.winrm.available ? why : s.winrm.reason
  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <SwitchRow
        label="SSH key login"
        info={TRANSPORT_INFO.ssh_key}
        checked={t.ssh_key}
        disabled={off}
        reason={why}
        onChange={(v) => save.mutate({ ssh_key: v })}
      />
      <SwitchRow
        label="SSH password login"
        info={TRANSPORT_INFO.ssh_password}
        checked={t.ssh_password}
        disabled={off}
        reason={why}
        onChange={(v) => save.mutate({ ssh_password: v })}
      />
      <SwitchRow
        label="WinRM over HTTPS"
        info={TRANSPORT_INFO.winrm}
        checked={t.winrm && s.winrm.available}
        disabled={off || !s.winrm.available}
        reason={winrmReason}
        badge={
          !s.winrm.available ? (
            <Badge variant="secondary">{s.winrm.label}</Badge>
          ) : undefined
        }
        onChange={(v) => save.mutate({ winrm: v })}
      />
    </div>
  )
}

export function DiscoveryCardBody({ status }: { status: DiscoveryStatus }) {
  return (
    <div className="space-y-2">
      <DeploymentRow status={status} />
      <TransportRows active={status.active} />
    </div>
  )
}
