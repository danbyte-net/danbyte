import { useState } from "react"
import { Link } from "@tanstack/react-router"
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
import { Button } from "@/components/ui/button"
import { FormTextarea, useFieldErrors } from "@/components/forms"
import { TimeCell } from "@/components/cells/time-ago"
import { Loading } from "@/components/loading"
import { useDiscoveryStatus } from "./status"

// Host discovery settings (#451), under Monitoring → Settings beside the
// address discovery sweep: the deployment switch (stored, or locked by
// DANBYTE_DISCOVERY_ENABLED), the tenant switch's state (changed on
// Settings → Integrations), the transports discovery may log in with,
// most secure first, nmap, and the deny subnets. The only place these are
// changed. Every control saves as it changes and nothing here is a <form>,
// so it can sit inside the monitoring settings form.

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
              variable to switch it here.
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
    "SSH to Linux and Windows hosts with a key login, after the host's SSH key was accepted. Tried before a password of the same credential source.",
  ssh_password:
    "SSH with a password login, after the host's SSH key was accepted. Turning it off stops every password login, Linux and Windows.",
  winrm:
    "WinRM over HTTPS with the server certificate verified and a client certificate. Tried after SSH of the same credential source, for hosts without SSH. Plain HTTP, NTLM, Basic and CredSSP are never used.",
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

export function NmapRow({ active }: { active: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["discovery", "settings"],
    queryFn: () => api<DiscoverySettings>("/api/discovery/settings/"),
    enabled: active,
  })
  const save = useMutation({
    mutationFn: (nmap: boolean) =>
      api<DiscoverySettings>("/api/discovery/settings/", {
        method: "PATCH",
        body: JSON.stringify({ nmap }),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["discovery", "settings"], d)
      toast.success(d.nmap.enabled ? "nmap on" : "nmap off")
    },
    onError: (err) => apiErrorToast(err),
  })
  if (!active || !q.data?.nmap) return null
  const s = q.data
  const n = s.nmap
  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <SwitchRow
        label="nmap"
        info={
          <>
            Service scans may use an nmap the administrator installed, for
            better service and version recognition. Danbyte never installs it;
            set <code className="font-mono">NMAP_BINARY</code> or put nmap on
            the service user&apos;s PATH. Unprivileged connect scans only, no
            scripts.
          </>
        }
        checked={n.enabled}
        disabled={!s.can_change || !n.available || save.isPending}
        reason={!n.available ? n.reason : "Tenant admins change this."}
        badge={
          <Badge
            variant={n.available ? "secondary" : "warning"}
            className="font-mono"
          >
            {n.label}
          </Badge>
        }
        onChange={(v) => save.mutate(v)}
      />
    </div>
  )
}

/** Deny subnets: CIDRs, any VRF, nothing in discovery ever contacts. */
export function DenySubnetsField({ active }: { active: boolean }) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const q = useQuery({
    queryKey: ["discovery", "settings"],
    queryFn: () => api<DiscoverySettings>("/api/discovery/settings/"),
    enabled: active,
  })
  const [text, setText] = useState<string | null>(null)
  const value = text ?? (q.data?.deny_subnets ?? []).join("\n")
  const save = useMutation({
    mutationFn: () =>
      api<DiscoverySettings>("/api/discovery/settings/", {
        method: "PATCH",
        body: JSON.stringify({
          deny_subnets: value
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["discovery", "settings"], d)
      toast.success("Deny subnets saved")
      setText(null)
      reset()
    },
    onError: (err) => {
      if (handleApiError(err) !== null) apiErrorToast(err)
    },
  })
  if (!active || !q.data) return null
  const canChange = q.data.can_change
  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <FormTextarea
        label="Deny subnets"
        rows={4}
        value={value}
        onChange={setText}
        placeholder="10.20.0.0/16"
        hint={canChange ? undefined : "read only"}
        error={fieldErrors.deny_subnets}
        info="Never contacted by package inventory or service scans. One CIDR per line, any VRF. The monitoring deny subnets apply as well."
      />
      {canChange && text !== null && (
        <div className="flex justify-end gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setText(null)
              reset()
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save subnets"}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The tenant switch, read-only here: it is turned on and off with the
 *  other integrations. */
function TenantRow({ status }: { status: DiscoveryStatus }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs whitespace-nowrap">This tenant</span>
      <InfoTip>
        The Discovery integration switch for this tenant. Tenant admins turn it
        on and off under Settings → Integrations.
      </InfoTip>
      <span className="ml-auto flex items-center gap-2">
        <Badge variant={status.enabled ? "success" : "secondary"}>
          {status.enabled ? "On" : "Off"}
        </Badge>
        <Link to="/settings/integrations" className="link text-xs">
          Integrations
        </Link>
      </span>
    </div>
  )
}

/** Everything host discovery has to set, for one status answer. The
 *  deployment row always renders, so a deployment admin can switch it while
 *  the tenant switch is still off. */
export function HostDiscoveryBody({ status }: { status: DiscoveryStatus }) {
  return (
    <div className="space-y-2">
      <DeploymentRow status={status} />
      <TenantRow status={status} />
      {status.active ? (
        <>
          <TransportRows active />
          <NmapRow active />
          <DenySubnetsField active />
        </>
      ) : (
        <p className="border-t border-border pt-2 text-xs text-muted-foreground">
          {status.deployment_enabled
            ? "Off for this tenant."
            : "Off for this deployment."}
        </p>
      )}
    </div>
  )
}

/** Host discovery, as the monitoring settings show it. */
export function HostDiscoverySettings() {
  const status = useDiscoveryStatus()
  if (status.isLoading) return <Loading />
  if (!status.data?.deployment) return null
  return <HostDiscoveryBody status={status.data} />
}
