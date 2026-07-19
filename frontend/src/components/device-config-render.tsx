import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Play } from "lucide-react"

import { api } from "@/lib/api"
import type { ExportTemplate, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Section } from "@/components/ui/section"
import { FormSelect } from "@/components/forms"

// Renders a device-typed export template against this device → intended config.
// The same endpoint Ansible/AWX pulls via /api/devices/<id>/render/.
export function DeviceConfigRender({
  deviceId,
  bound,
}: {
  deviceId: string
  /** The device's config-template binding (own override + resolved). */
  bound?: {
    own: { id: string; name: string } | null
    resolved: { id: string; name: string } | null
  } | null
}) {
  // Preselect the resolved binding (device override → role → platform);
  // picking another template in the select remains a manual override.
  const [templateId, setTemplateId] = useState<string | null>(
    bound?.resolved?.id ?? null
  )
  const [output, setOutput] = useState<string | null>(null)

  const templates = useQuery({
    queryKey: ["export-templates", "device"],
    queryFn: () =>
      api<Paginated<ExportTemplate>>(
        "/api/export-templates/?object_type=device"
      ),
    staleTime: 5 * 60_000,
  })
  const options = (templates.data?.results ?? []).map((t) => ({
    value: t.id,
    label: t.name,
  }))

  const render = useMutation({
    mutationFn: () =>
      api<{ output: string }>(
        `/api/devices/${deviceId}/render/?template=${templateId}`
      ),
    onSuccess: (r) => setOutput(r.output),
    onError: (err) => setOutput(`⚠ ${err.message}`),
  })

  return (
    <Section
      title="Render config"
      description="from an export template (object type: device)"
    >
      <div className="space-y-3 rounded-lg border border-border p-4">
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No device export templates yet — create one under{" "}
            <span className="font-medium">Customize → Export templates</span>{" "}
            with object type <span className="font-mono">device</span>.
          </p>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <div className="w-64">
                <FormSelect
                  label="Template"
                  value={templateId}
                  onChange={setTemplateId}
                  options={options}
                  placeholder="Pick a template"
                />
              </div>
              <Button
                onClick={() => render.mutate()}
                disabled={!templateId || render.isPending}
              >
                {render.isPending ? (
                  <Spinner className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
                Render
              </Button>
            </div>
            {bound?.resolved && (
              <p className="text-xs text-muted-foreground">
                Bound via {bound.own ? "device" : "role/platform"}:{" "}
                <span className="font-medium">{bound.resolved.name}</span>
              </p>
            )}
            {output !== null && (
              <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
                {output || "(empty)"}
              </pre>
            )}
          </>
        )}
      </div>
    </Section>
  )
}
