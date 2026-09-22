import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Download, Play } from "lucide-react"

import { api } from "@/lib/api"
import type {
  ConfigBundle,
  DeviceBundleRenderResult,
  DeviceRenderFile,
  DeviceRenderResult,
  ExportTemplate,
  Paginated,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Section } from "@/components/ui/section"
import { FormSelect } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TimeCell } from "@/components/cells/time-ago"
import { DiffLine } from "@/components/device-drift-panel"

// The picker holds two catalogs - single templates and bundles - so its value
// carries the kind, and the render call is built from that.
type Choice = { kind: "template" | "bundle"; id: string }

function encode(p: Choice): string {
  return `${p.kind}:${p.id}`
}
function decode(v: string | null): Choice | null {
  if (!v) return null
  const i = v.indexOf(":")
  const kind = v.slice(0, i)
  if (kind !== "template" && kind !== "bundle") return null
  return { kind, id: v.slice(i + 1) }
}

type Rendered =
  | { kind: "template"; file: DeviceRenderFile }
  | {
      kind: "bundle"
      name: string
      bundleId: string
      files: DeviceRenderFile[]
    }
  | { kind: "error"; message: string }

// Renders a device-typed export template - or a whole bundle - against this
// device → intended config. The same endpoint Ansible/AWX pulls via
// /api/devices/<id>/render/.
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
  const [value, setValue] = useState<string | null>(
    bound?.resolved ? encode({ kind: "template", id: bound.resolved.id }) : null
  )
  const [result, setResult] = useState<Rendered | null>(null)

  const templates = useQuery({
    queryKey: ["export-templates", "device"],
    queryFn: () =>
      api<Paginated<ExportTemplate>>(
        "/api/export-templates/?object_type=device"
      ),
    staleTime: 5 * 60_000,
  })
  const bundles = useQuery({
    queryKey: ["config-bundles"],
    queryFn: () => api<Paginated<ConfigBundle>>("/api/config-bundles/"),
    staleTime: 5 * 60_000,
  })
  const options = (templates.data?.results ?? []).map((t) => ({
    value: encode({ kind: "template", id: t.id }),
    label: t.name,
  }))
  const bundleOptions = (bundles.data?.results ?? []).map((b) => ({
    value: encode({ kind: "bundle", id: b.id }),
    label: b.name,
  }))
  const groups = bundleOptions.length
    ? [{ label: "Bundles", options: bundleOptions }]
    : []

  const pick = decode(value)
  const render = useMutation({
    mutationFn: async (): Promise<Rendered> => {
      if (!pick) throw new Error("Pick a template or bundle.")
      if (pick.kind === "bundle") {
        const r = await api<DeviceBundleRenderResult>(
          `/api/devices/${deviceId}/render/?bundle=${pick.id}`
        )
        return {
          kind: "bundle",
          name: r.bundle,
          bundleId: pick.id,
          files: Object.values(r.files),
        }
      }
      const file = await api<DeviceRenderResult>(
        `/api/devices/${deviceId}/render/?template=${pick.id}`
      )
      return { kind: "template", file }
    },
    onSuccess: setResult,
    onError: (err) => setResult({ kind: "error", message: err.message }),
  })

  const nothingToPick = options.length === 0 && bundleOptions.length === 0

  return (
    <Section
      title="Render config"
      description="from an export template or bundle (object type: device)"
    >
      <div className="space-y-3 rounded-lg border border-border p-4">
        {nothingToPick ? (
          <p className="text-sm text-muted-foreground">
            No device export templates yet - create one under{" "}
            <span className="font-medium">Customize → Export templates</span>{" "}
            with object type <span className="font-mono">device</span>.
          </p>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <div className="w-64">
                <FormSelect
                  label="Template"
                  value={value}
                  onChange={setValue}
                  options={options}
                  groups={groups}
                  placeholder="Pick a template"
                />
              </div>
              <Button
                onClick={() => render.mutate()}
                disabled={!pick || render.isPending}
              >
                {render.isPending ? (
                  <Spinner className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
                Render
              </Button>
              {pick?.kind === "bundle" && (
                <Button variant="outline" asChild>
                  {/* A file download, not SPA navigation: a plain anchor with
                      `download` hands the tarball straight to the browser. */}
                  <a
                    href={`/api/devices/${deviceId}/render/?bundle=${pick.id}&archive=tar`}
                    download
                  >
                    <Download className="size-4" />
                    Download .tar
                  </a>
                </Button>
              )}
            </div>
            {bound?.resolved && (
              <p className="text-xs text-muted-foreground">
                Bound via {bound.own ? "device" : "role/platform"}:{" "}
                <span className="font-medium">{bound.resolved.name}</span>
              </p>
            )}
            {result?.kind === "error" && (
              <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
                ⚠ {result.message}
              </pre>
            )}
            {result?.kind === "template" && <RenderedFile file={result.file} />}
            {result?.kind === "bundle" && (
              <BundleFiles key={result.bundleId} files={result.files} />
            )}
          </>
        )}
      </div>
    </Section>
  )
}

/** One segmented tab per file, labelled by its path on the device. */
function BundleFiles({ files }: { files: DeviceRenderFile[] }) {
  const [path, setPath] = useState<string>(files.length ? files[0].path : "")
  if (files.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        This bundle has no templates.
      </p>
    )
  const active = files.find((f) => f.path === path) ?? files[0]
  return (
    <div className="space-y-3">
      <SegmentedTabs
        items={files.map((f) => ({
          value: f.path,
          label: <span className="font-mono">{f.path}</span>,
        }))}
        value={active.path}
        onValueChange={setPath}
      />
      <RenderedFile key={active.path} file={active} />
    </div>
  )
}

type View = "rendered" | "diff"

/** The render output with its push state above it: the content hash, whether
 * the box already has this exact file, and - when it does not - the diff
 * against what was last pushed. */
function RenderedFile({ file }: { file: DeviceRenderFile }) {
  const [view, setView] = useState<View>("rendered")
  const hasDiff = file.drift === true && file.diff.length > 0
  const showDiff = hasDiff && view === "diff"
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">
          {file.sha256.slice(0, 12)}
        </span>
        <PushBadge file={file} />
        {hasDiff && (
          <SegmentedTabs<View>
            className="ml-auto"
            items={[
              { value: "rendered", label: "Rendered" },
              { value: "diff", label: "Diff vs last push" },
            ]}
            value={view}
            onValueChange={setView}
          />
        )}
      </div>
      <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
        {showDiff
          ? file.diff
              .split("\n")
              .map((line, i) => <DiffLine key={i} line={line} />)
          : file.output || "(empty)"}
      </pre>
    </div>
  )
}

function PushBadge({ file }: { file: DeviceRenderFile }) {
  if (file.drift === null || !file.pushed)
    return <Badge variant="secondary">Never pushed</Badge>
  if (file.drift)
    return (
      <Badge variant="warning">
        Changed since last push · <TimeCell iso={file.pushed.at} />
      </Badge>
    )
  return (
    <Badge variant="success">
      Matches last push · <TimeCell iso={file.pushed.at} />
    </Badge>
  )
}
