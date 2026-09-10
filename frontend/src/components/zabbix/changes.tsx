import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  ZabbixApplyResult,
  ZabbixChange,
  ZabbixConnection,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

/**
 * The review queue - what Danbyte would write, waiting for a person.
 *
 * A change is a proposal, never a record: applying one removes it. "Needs a
 * decision" cannot be applied at all, and is drawn differently so it does not
 * read as one more thing to click Apply on.
 */

const KIND_VARIANT: Record<string, "secondary" | "warning" | "destructive"> = {
  create_host: "secondary",
  update_host: "secondary",
  ambiguous: "warning",
  prune_host: "destructive",
}

export function ZabbixChanges({
  connection,
  changes,
  loading,
}: {
  connection: ZabbixConnection
  changes: ZabbixChange[]
  loading: boolean
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canApply = canDo("zabbixchange", "change")

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["zabbix-changes"] })
    void qc.invalidateQueries({ queryKey: ["zabbix-links"] })
  }

  const apply = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; detail: string }>(
        `/api/zabbix/changes/${id}/apply/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      toast.success(r.detail)
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const dismiss = useMutation({
    mutationFn: (id: string) =>
      api(`/api/zabbix/changes/${id}/dismiss/`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Dismissed")
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const applyAll = useMutation({
    mutationFn: () =>
      api<ZabbixApplyResult>("/api/zabbix/changes/apply-all/", {
        method: "POST",
        body: JSON.stringify({ connection: connection.id }),
      }),
    onSuccess: (r) => {
      toast.success(
        `Applied ${r.applied}${r.failed ? `, ${r.failed} failed` : ""}.`
      )
      // One toast per refusal, in Zabbix's own words: "these two templates
      // both define icmpping" is a rule to fix, and a count is not.
      for (const e of r.errors ?? []) {
        toast.error(`${e.device || "Host"}: ${e.detail}`)
      }
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })

  const applicable = changes.filter((c) => c.applicable)
  const busy = apply.isPending || dismiss.isPending || applyAll.isPending

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">
          To review{" "}
          <span className="num text-xs font-normal text-muted-foreground">
            {changes.length}
          </span>
        </h2>
        {canApply && applicable.length > 1 && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => applyAll.mutate()}
          >
            {applyAll.isPending
              ? "Applying…"
              : `Apply ${applicable.length} changes`}
          </Button>
        )}
      </div>

      {loading ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">Loading…</p>
      ) : changes.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">
          {connection.provision_mode === "off"
            ? "Provisioning is off, so Danbyte proposes nothing."
            : "Nothing to review - Zabbix matches what Danbyte expects."}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {changes.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px]"
            >
              <Badge variant={KIND_VARIANT[c.kind] ?? "secondary"}>
                {c.kind_display}
              </Badge>
              <span className="min-w-0 flex-1">
                {c.device ? (
                  <Link
                    to="/devices/$id"
                    params={{ id: c.device.id }}
                    className="link"
                  >
                    {c.device.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
                <ChangeDetail change={c} />
              </span>
              {canApply && (
                <span className="flex shrink-0 items-center gap-2">
                  {c.applicable ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => apply.mutate(c.id)}
                    >
                      Apply
                    </Button>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      resolve in Zabbix or Danbyte
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => dismiss.mutate(c.id)}
                  >
                    Dismiss
                  </Button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** What would actually be written, in a sentence. */
function ChangeDetail({ change }: { change: ZabbixChange }) {
  const d = change.detail
  if (change.kind === "ambiguous")
    return (
      <span className="block text-[12px] text-muted-foreground">
        {String(d.reason ?? "")}
      </span>
    )
  if (change.kind === "prune_host")
    return (
      <span className="block text-[12px] text-muted-foreground">
        Deletes <span className="font-mono">{String(d.host_name ?? "")}</span>{" "}
        from Zabbix - Danbyte created it and no longer has a reason for it.
      </span>
    )
  if (change.kind === "link_template") {
    const add = (d.add ?? []) as string[]
    return (
      <span className="block text-[12px] text-muted-foreground">
        Links {add.join(", ")}
        {d.add_snmp_interface
          ? " - and adds the SNMP interface Zabbix needs before it will."
          : "."}
      </span>
    )
  }
  if (change.kind === "update_host") {
    const changes = (d.changes ?? {}) as Record<string, unknown>
    const fields = Object.entries(changes)
      // `_interfaceid` is how the write is addressed, not something being
      // changed; `_address` is a change, it just goes to a different call.
      .filter(([k]) => k !== "_interfaceid")
      .map(([k, v]) =>
        k === "_address" ? `address → ${String(v)}` : `${k} → ${String(v)}`
      )
    return (
      <span className="block text-[12px] text-muted-foreground">
        {fields.length > 0 ? fields.join(", ") : "No writable difference."}
      </span>
    )
  }
  const templates = (d.templates ?? []) as string[]
  return (
    <span className="block text-[12px] text-muted-foreground">
      Creates a host{d.site ? ` in group “${String(d.site)}”` : ""}
      {templates.length > 0 ? `, with ${templates.join(", ")}` : ""}.
    </span>
  )
}
