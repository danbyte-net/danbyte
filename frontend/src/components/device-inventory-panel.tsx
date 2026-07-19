import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { docsUrl } from "@/lib/docs"
import { CopyButton } from "@/components/kv-card"
import { Section } from "@/components/ui/section"

interface DeviceInventory {
  host: string
  ansible_host: string | null
  groups: string[]
  hostvars: Record<string, unknown>
}

// Read-only "what Ansible sees" for this device — the groups it lands in and the
// hostvars Danbyte exports, the exact slice of /api/inventory/ansible/ for this
// host. Lets a user verify the export without curling the API.
export function DeviceInventoryPanel({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-inventory", deviceId],
    queryFn: () => api<DeviceInventory>(`/api/devices/${deviceId}/inventory/`),
    staleTime: 60_000,
  })

  const data = q.data
  const hostvarsJson = data ? JSON.stringify(data.hostvars, null, 2) : ""

  return (
    <Section
      title="Ansible inventory"
      description="what a runner sees for this device"
      actions={hostvarsJson ? <CopyButton value={hostvarsJson} /> : undefined}
    >
      <div className="space-y-3 rounded-lg border border-border p-4">
        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {q.isError && (
          <p className="text-sm text-muted-foreground">
            Couldn't load the inventory for this device.
          </p>
        )}
        {data && (
          <>
            <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-[13px]">
              <span className="text-muted-foreground">ansible_host</span>
              <span className="font-mono text-[12px]">
                {data.ansible_host ?? (
                  <span className="text-muted-foreground">
                    — no primary IP set
                  </span>
                )}
              </span>
            </div>

            <div>
              <div className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                Groups
              </div>
              <div className="flex flex-wrap gap-1">
                {data.groups.map((g) => (
                  <span
                    key={g}
                    className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {g}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                A play can target any of these, e.g.{" "}
                <span className="font-mono">hosts: {data.groups[0]}</span>.
              </p>
            </div>

            <div>
              <div className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                Host vars
              </div>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
                {hostvarsJson}
              </pre>
            </div>

            <p className="text-[11px] text-muted-foreground">
              This mirrors the device's slice of{" "}
              <span className="font-mono">/api/inventory/ansible/</span>. See
              the{" "}
              <a
                href={docsUrl(
                  "features/iac-runner/#groups-and-interfaces-network-automation"
                )}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-2"
              >
                config-drift guide
              </a>
              .
            </p>
          </>
        )}
      </div>
    </Section>
  )
}
