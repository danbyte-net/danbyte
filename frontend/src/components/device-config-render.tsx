import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, RefreshCw } from "lucide-react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  ConfigBundle,
  DeviceBundleRenderResult,
  DeviceRenderFile,
  DeviceRenderResult,
  ExportTemplate,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/section"
import { FormCombobox } from "@/components/forms"
import { Loading } from "@/components/loading"
import { TimeCell } from "@/components/cells/time-ago"
import { FileViewer } from "@/components/file-viewer"
import { linesOf } from "@/components/file-viewer/diff"
import { cn } from "@/lib/utils"

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
      /** What renders the files: a bundle, or a directory template. */
      source: "bundle" | "directory"
      bundleId: string
      files: DeviceRenderFile[]
    }

async function renderChoice(deviceId: string, pick: Choice): Promise<Rendered> {
  if (pick.kind === "bundle") {
    const r = await api<DeviceBundleRenderResult>(
      `/api/devices/${deviceId}/render/?bundle=${pick.id}`
    )
    return {
      kind: "bundle",
      name: r.bundle,
      source: "bundle",
      bundleId: pick.id,
      files: Object.values(r.files),
    }
  }
  const r = await api<DeviceRenderResult>(
    `/api/devices/${deviceId}/render/?template=${pick.id}`
  )
  // A directory template answers like a bundle: one entry per file.
  if ("files" in r)
    return {
      kind: "bundle",
      name: r.template,
      source: "directory",
      bundleId: pick.id,
      files: Object.values(r.files),
    }
  return { kind: "template", file: r }
}

// Renders a device-typed export template - or a whole bundle - against this
// device → intended config. The same endpoint Ansible/AWX pulls via
// /api/devices/<id>/render/. What is bound to the device renders on open.
export function DeviceConfigRender({
  deviceId,
  roleId,
  bound,
}: {
  deviceId: string
  /** The device's role: a bundle bound to it renders on open. */
  roleId?: string | null
  /** The device's config-template binding (own override + resolved). */
  bound?: {
    own: { id: string; name: string } | null
    resolved: { id: string; name: string } | null
  } | null
}) {
  const [picked, setPicked] = useState<string | null>(null)

  const templates = useQuery({
    queryKey: ["export-templates", "device"],
    queryFn: () =>
      apiAll<ExportTemplate>("/api/export-templates/?object_type=device"),
    staleTime: 5 * 60_000,
  })
  const bundles = useQuery({
    queryKey: ["config-bundles"],
    queryFn: () => apiAll<ConfigBundle>("/api/config-bundles/"),
    staleTime: 5 * 60_000,
  })
  const options = (templates.data?.results ?? []).map((t) => ({
    value: encode({ kind: "template", id: t.id }),
    label: t.name,
  }))
  // Directory templates write several files, so they download as a tarball.
  const directoryIds = new Set(
    (templates.data?.results ?? [])
      .filter((t) => t.is_directory)
      .map((t) => t.id)
  )
  const bundleOptions = (bundles.data?.results ?? []).map((b) => ({
    value: encode({ kind: "bundle", id: b.id }),
    label: b.name,
    group: "Bundles",
  }))

  // What is bound: the one bundle on the device's role wins (it is the whole
  // file set), else the resolved config template (device → role → platform).
  const roleBundles = roleId
    ? (bundles.data?.results ?? []).filter((b) =>
        b.roles.some((r) => r.id === roleId)
      )
    : []
  const roleBundle = roleBundles.length === 1 ? roleBundles[0] : null
  const boundChoice: Choice | null = roleBundle
    ? { kind: "bundle", id: roleBundle.id }
    : bound?.resolved
      ? { kind: "template", id: bound.resolved.id }
      : null
  // Wait for the bundle list before falling back to the template, so a
  // bundle-bound device does not render its template first.
  const boundReady = !roleId || !bundles.isLoading
  const value =
    picked ?? (boundReady && boundChoice ? encode(boundChoice) : null)
  const pick = decode(value)
  const isBound = !!boundChoice && value === encode(boundChoice)

  const render = useQuery({
    queryKey: ["device-render", deviceId, value],
    queryFn: () => renderChoice(deviceId, pick!),
    enabled: !!pick,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const result = render.data

  const boundNote = isBound
    ? roleBundle
      ? `Bound via role ${roleBundles[0].roles.find((r) => r.id === roleId)?.name ?? ""}`
      : `Bound via ${bound?.own ? "device" : "role/platform"}`
    : null

  const nothingToPick = options.length === 0 && bundleOptions.length === 0

  return (
    <Section title="Render config">
      {nothingToPick && !templates.isLoading && !bundles.isLoading ? (
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">
            No device export templates yet - create one under{" "}
            <span className="font-medium">Customize → Export templates</span>{" "}
            with object type <span className="font-mono">device</span>.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-lg border border-border px-3 py-2">
            <div className="w-64">
              <FormCombobox
                label="Template"
                value={value}
                onChange={setPicked}
                options={[...options, ...bundleOptions]}
                placeholder="Pick a template"
                searchPlaceholder="Search templates…"
                emptyText="No templates."
              />
            </div>
            {boundNote && (
              <span className="pb-2 text-xs whitespace-nowrap text-muted-foreground">
                {boundNote}
              </span>
            )}
            <span className="ml-auto flex items-center gap-2 pb-0.5">
              {result?.kind === "bundle" && (
                <BundleSummary files={result.files} />
              )}
              <Button
                variant="outline"
                onClick={() => render.refetch()}
                disabled={!pick || render.isFetching}
              >
                <RefreshCw className="size-4" />
                {render.isFetching ? "Rendering…" : "Re-render"}
              </Button>
              {pick &&
                (pick.kind === "bundle" || directoryIds.has(pick.id)) && (
                  <Button variant="outline" asChild>
                    {/* A file download, not SPA navigation: a plain anchor with
                      `download` hands the tarball straight to the browser. */}
                    <a
                      href={`/api/devices/${deviceId}/render/?${pick.kind}=${pick.id}&archive=tar`}
                      download
                    >
                      <Download className="size-4" />
                      Download .tar
                    </a>
                  </Button>
                )}
            </span>
          </div>
          {!pick ? null : render.isLoading ? (
            <div className="rounded-lg border border-border">
              <Loading className="min-h-40" />
            </div>
          ) : render.isError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 font-mono text-[12px] whitespace-pre-wrap">
              {render.error.message}
            </div>
          ) : result?.kind === "template" ? (
            <RenderedFile file={result.file} height="fill" hotkey />
          ) : result?.kind === "bundle" ? (
            <BundleFiles
              key={`${result.source}:${result.bundleId}`}
              files={result.files}
              height="fill"
              hotkey
              empty={
                result.source === "directory"
                  ? "No files for this device."
                  : "This bundle has no templates."
              }
            />
          ) : null}
        </div>
      )}
    </Section>
  )
}

/** "1 of 5 files changed since last push", or that all match. */
function BundleSummary({ files }: { files: DeviceRenderFile[] }) {
  if (files.length === 0) return null
  const changed = files.filter((f) => f.drift === true).length
  const pushed = files.filter((f) => f.drift !== null && f.pushed).length
  const total = files.length
  if (changed > 0)
    return (
      <Badge variant="warning">
        {changed} of {total} file{total === 1 ? "" : "s"} changed since last
        push
      </Badge>
    )
  if (pushed === 0) return <Badge variant="secondary">Never pushed</Badge>
  if (pushed === total)
    return <Badge variant="success">All files match last push</Badge>
  return (
    <Badge variant="secondary">
      {total - pushed} of {total} files never pushed
    </Badge>
  )
}

/** A bundle's (or directory template's) files: a list on the left with each
 * file's line count and push state, the picked file in the viewer. */
export function BundleFiles({
  files,
  empty,
  height = "fit",
  hotkey = false,
}: {
  files: DeviceRenderFile[]
  empty: string
  height?: "fill" | "fit"
  hotkey?: boolean
}) {
  const [path, setPath] = useState<string>(files.length ? files[0].path : "")
  if (files.length === 0)
    return (
      <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        {empty}
      </p>
    )
  const active = files.find((f) => f.path === path) ?? files[0]
  const list = (
    <section className="rounded-lg border border-border p-2">
      <h3 className="mx-2 mt-1 mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        Files
      </h3>
      <ul className="flex flex-col gap-0.5">
        {files.map((f) => {
          const on = f.path === active.path
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setPath(f.path)}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  on ? "bg-muted text-foreground" : "hover:bg-muted/60"
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                  {f.path}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {linesOf(f.output).length}
                </span>
                <PushBadge file={f} short />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
  return (
    <RenderedFile
      key={active.path}
      file={active}
      aside={list}
      height={height}
      hotkey={hotkey}
    />
  )
}

/** One rendered file in the viewer, with its hash and push state in the
 * header and - when it differs from the last push - the diff. */
function RenderedFile({
  file,
  aside,
  height = "fit",
  hotkey = false,
}: {
  file: DeviceRenderFile
  aside?: React.ReactNode
  height?: "fill" | "fit"
  hotkey?: boolean
}) {
  const hasDiff = file.drift === true && file.diff.length > 0
  return (
    <FileViewer
      text={file.output}
      path={file.path}
      meta={
        <>
          <span className="font-mono text-[11px] text-muted-foreground">
            {file.sha256.slice(0, 12)}
          </span>
          <PushBadge file={file} />
        </>
      }
      diff={hasDiff ? file.diff : null}
      aside={aside}
      height={height}
      storageKey={height === "fill" ? "config" : undefined}
      hotkey={hotkey}
    />
  )
}

function PushBadge({
  file,
  short = false,
}: {
  file: DeviceRenderFile
  /** Just the state, for the file list. */
  short?: boolean
}) {
  if (file.drift === null || !file.pushed)
    return <Badge variant="secondary">Never pushed</Badge>
  if (file.drift)
    return (
      <Badge variant="warning">
        {short ? (
          "Changed"
        ) : (
          <>
            Changed since last push · <TimeCell iso={file.pushed.at} />
          </>
        )}
      </Badge>
    )
  return (
    <Badge variant="success">
      {short ? (
        "Matches"
      ) : (
        <>
          Matches last push · <TimeCell iso={file.pushed.at} />
        </>
      )}
    </Badge>
  )
}
