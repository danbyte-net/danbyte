import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type CircuitTermination,
  type CircuitTermSide,
  type CircuitTerminationWritePayload,
  type Paginated,
  type ProviderNetwork,
  type SiteOption,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { cn } from "@/lib/utils"

type EndpointKind = "site" | "provider_network"

const SIDE_OPTIONS: { value: CircuitTermSide; label: string }[] = [
  { value: "A", label: "A side" },
  { value: "Z", label: "Z side" },
]

/**
 * Create or edit one circuit termination. The endpoint is exactly one of a
 * site or a provider network; the side is fixed when editing or when the
 * caller presets it (the per-side "Add termination" buttons).
 */
export function CircuitTerminationDialog({
  circuitId,
  termination,
  presetSide,
  open,
  onOpenChange,
}: {
  circuitId: string
  /** Existing termination to edit, or null to create. */
  termination?: CircuitTermination | null
  /** Locks the A/Z select when creating from a per-side button. */
  presetSide?: CircuitTermSide | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isEdit = !!termination
  const sideFixed = isEdit || !!presetSide
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [side, setSide] = useState<CircuitTermSide>("A")
  const [kind, setKind] = useState<EndpointKind>("site")
  const [siteId, setSiteId] = useState<string | null>(null)
  const [providerNetworkId, setProviderNetworkId] = useState<string | null>(
    null
  )
  const [portSpeed, setPortSpeed] = useState("")
  const [upstreamSpeed, setUpstreamSpeed] = useState("")
  const [xconnectId, setXconnectId] = useState("")
  const [ppInfo, setPpInfo] = useState("")
  const [description, setDescription] = useState("")

  // Reset the form every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setSide(termination?.term_side ?? presetSide ?? "A")
    setKind(termination?.provider_network ? "provider_network" : "site")
    setSiteId(termination?.site?.id ?? null)
    setProviderNetworkId(termination?.provider_network?.id ?? null)
    setPortSpeed(
      termination?.port_speed_kbps != null
        ? String(termination.port_speed_kbps)
        : ""
    )
    setUpstreamSpeed(
      termination?.upstream_speed_kbps != null
        ? String(termination.upstream_speed_kbps)
        : ""
    )
    setXconnectId(termination?.xconnect_id ?? "")
    setPpInfo(termination?.pp_info ?? "")
    setDescription(termination?.description ?? "")
    reset()
  }, [open, termination, presetSide, reset])

  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/?picker=1"),
    enabled: open && kind === "site",
    staleTime: 10 * 60_000,
  })
  const providerNetworks = useQuery({
    queryKey: ["provider-networks-picker"],
    queryFn: () => api<Paginated<ProviderNetwork>>("/api/provider-networks/"),
    enabled: open && kind === "provider_network",
    staleTime: 10 * 60_000,
  })

  const canSubmit = kind === "site" ? !!siteId : !!providerNetworkId

  const mutation = useMutation({
    mutationFn: () => {
      const payload: CircuitTerminationWritePayload = {
        circuit_id: circuitId,
        term_side: side,
        site_id: kind === "site" ? siteId : null,
        provider_network_id:
          kind === "provider_network" ? providerNetworkId : null,
        port_speed_kbps: portSpeed.trim() === "" ? null : Number(portSpeed),
        upstream_speed_kbps:
          upstreamSpeed.trim() === "" ? null : Number(upstreamSpeed),
        xconnect_id: xconnectId.trim(),
        pp_info: ppInfo.trim(),
        description: description.trim(),
      }
      if (isEdit)
        return api<CircuitTermination>(
          `/api/circuit-terminations/${termination!.id}/`,
          { method: "PATCH", body: JSON.stringify(payload) }
        )
      return api<CircuitTermination>("/api/circuit-terminations/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["circuit", circuitId] })
      qc.invalidateQueries({ queryKey: ["circuits"] })
      toast.success(
        isEdit ? `Updated ${side} side termination` : `Terminated ${side} side`
      )
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  function switchKind(next: EndpointKind) {
    if (next === kind) return
    setKind(next)
    setSiteId(null)
    setProviderNetworkId(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${side} side termination` : "Add termination"}
          </DialogTitle>
          <DialogDescription>
            Terminate this circuit on a site or on a provider network — exactly
            one of the two.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) mutation.mutate()
          }}
          className="grid gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            {sideFixed ? (
              <Field label="Side" error={fieldErrors.term_side}>
                <div className="flex h-9 items-center rounded-md border border-border bg-muted/40 px-3 text-sm text-muted-foreground">
                  {side} side
                </div>
              </Field>
            ) : (
              <FormSelect
                label="Side"
                value={side}
                onChange={(v) => setSide((v as CircuitTermSide) ?? "A")}
                options={SIDE_OPTIONS}
                error={fieldErrors.term_side}
              />
            )}
            <Field label="Endpoint type">
              <div className="flex h-9 items-center gap-1 rounded-md border border-border p-0.5">
                {(
                  [
                    ["site", "Site"],
                    ["provider_network", "Provider network"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => switchKind(value)}
                    className={cn(
                      "inline-flex h-full flex-1 items-center justify-center rounded-[5px] px-2 text-xs font-medium transition-colors",
                      kind === value
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          {kind === "site" ? (
            <FormCombobox
              label="Site"
              value={siteId}
              onChange={setSiteId}
              placeholder="Pick site"
              searchPlaceholder="Search sites…"
              emptyText="No sites."
              options={(sites.data?.results ?? []).map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              error={fieldErrors.site_id}
            />
          ) : (
            <FormCombobox
              label="Provider network"
              value={providerNetworkId}
              onChange={setProviderNetworkId}
              placeholder="Pick provider network"
              searchPlaceholder="Search provider networks…"
              emptyText="No provider networks."
              options={(providerNetworks.data?.results ?? []).map((n) => ({
                value: n.id,
                label: n.name,
              }))}
              error={fieldErrors.provider_network_id}
            />
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Port speed (kbps)"
              type="number"
              min={0}
              value={portSpeed}
              onChange={setPortSpeed}
              placeholder="1000000"
              error={fieldErrors.port_speed_kbps}
            />
            <FormText
              label="Upstream speed (kbps)"
              type="number"
              min={0}
              hint="if asymmetric"
              value={upstreamSpeed}
              onChange={setUpstreamSpeed}
              placeholder="500000"
              error={fieldErrors.upstream_speed_kbps}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Cross-connect ID"
              mono
              value={xconnectId}
              onChange={setXconnectId}
              error={fieldErrors.xconnect_id}
            />
            <FormText
              label="Patch panel / port"
              mono
              value={ppInfo}
              onChange={setPpInfo}
              error={fieldErrors.pp_info}
            />
          </div>
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={isEdit ? "Save changes" : "Add termination"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
