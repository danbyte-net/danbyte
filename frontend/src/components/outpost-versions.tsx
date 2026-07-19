import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { GitBranch, Star, Trash2, Upload } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { OutpostAvailable, OutpostRelease, Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { apiErrorToast } from "@/lib/api-toast"

function humanSize(n: number): string {
  if (!n) return "—"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Pull a ref out of a browser URL like `…/repo/tree/v1.2.0` or
 * `…/repo/releases/tag/v1.2.0` (also /blob/ and /commit/), returning the base
 * clone URL + the ref. Plain repo URLs pass through unchanged. */
function parseGitRef(url: string): { cleanUrl: string; ref: string | null } {
  const m = url
    .trim()
    .match(
      /^(https?:\/\/\S+?)\/(?:tree|blob|commit|releases\/tag)\/([^/?#\s]+)/i
    )
  if (m) return { cleanUrl: m[1], ref: decodeURIComponent(m[2]) }
  return { cleanUrl: url, ref: null }
}

/** The package store: upload / register Outpost builds Danbyte serves. */
export function OutpostVersions() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["outpost-releases"],
    queryFn: () =>
      api<Paginated<OutpostRelease>>("/api/monitoring/outpost-releases/"),
  })
  const releases = q.data?.results ?? []
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["outpost-releases"] })

  const [file, setFile] = useState<File | null>(null)
  const [fileVersion, setFileVersion] = useState("")
  const [gitVersion, setGitVersion] = useState("")
  const [gitUrl, setGitUrl] = useState("")
  const [gitRef, setGitRef] = useState("")
  const [gitToken, setGitToken] = useState("")

  const uploadFile = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append("version", fileVersion.trim())
      fd.append("source", "file")
      fd.append("artifact", file!)
      fd.append("is_default", releases.length === 0 ? "true" : "false")
      return api<OutpostRelease>("/api/monitoring/outpost-releases/", {
        method: "POST",
        body: fd,
      })
    },
    onSuccess: () => {
      setFile(null)
      setFileVersion("")
      invalidate()
      toast.success("Build uploaded")
    },
    onError: (e: unknown) => apiErrorToast(e, "Upload failed"),
  })

  const addGit = useMutation({
    mutationFn: () =>
      api<OutpostRelease>("/api/monitoring/outpost-releases/", {
        method: "POST",
        body: JSON.stringify({
          version: gitVersion.trim(),
          source: "git",
          git_url: gitUrl.trim(),
          git_ref: gitRef.trim() || "main",
          is_default: releases.length === 0,
        }),
      }),
    onSuccess: () => {
      setGitVersion("")
      setGitUrl("")
      setGitRef("")
      invalidate()
      toast.success("Git version added")
    },
    onError: (e: unknown) => apiErrorToast(e, "Add failed"),
  })

  const fetchBinary = useMutation({
    mutationFn: () =>
      api<OutpostRelease>("/api/monitoring/outpost-releases/fetch_binary/", {
        method: "POST",
        body: JSON.stringify({
          git_url: gitUrl.trim(),
          ref: gitRef.trim(),
          version: gitVersion.trim() || undefined,
          token: gitToken.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      setGitVersion("")
      setGitUrl("")
      setGitRef("")
      setGitToken("")
      invalidate()
      toast.success("Binary fetched from the release")
    },
    onError: (e: unknown) => apiErrorToast(e, "Fetch failed"),
  })

  const setDefault = useMutation({
    mutationFn: (r: OutpostRelease) =>
      api(`/api/monitoring/outpost-releases/${r.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ is_default: true }),
      }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (r: OutpostRelease) =>
      api(`/api/monitoring/outpost-releases/${r.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate()
      toast.success("Version removed")
    },
  })

  // Versions available in the repo configured in Monitoring settings.
  const available = useQuery({
    queryKey: ["outpost-available"],
    queryFn: () =>
      api<OutpostAvailable>("/api/monitoring/outpost-releases/available/"),
  })
  const [pickedTag, setPickedTag] = useState("")
  const importFromRepo = useMutation({
    mutationFn: (tag: string) =>
      api<OutpostRelease>("/api/monitoring/outpost-releases/fetch_binary/", {
        method: "POST",
        body: JSON.stringify({ ref: tag }), // url + token come from settings
      }),
    onSuccess: () => {
      setPickedTag("")
      invalidate()
      void available.refetch()
      toast.success("Version imported")
    },
    onError: (e: unknown) => apiErrorToast(e, "Import failed"),
  })

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Outpost versions</h2>
        <p className="text-[13px] text-muted-foreground">
          Builds this Danbyte instance serves — so airgapped hosts install
          without reaching GitHub/PyPI. Enrolling an Outpost pins one.
        </p>
      </div>

      {/* Pick a version from the repo configured in Monitoring settings. */}
      {available.data?.repo_url && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 p-3">
          <span className="text-[13px] font-medium">From your repo</span>
          <select
            value={pickedTag}
            onChange={(e) => setPickedTag(e.target.value)}
            className="h-8 min-w-48 rounded-md border border-border bg-background px-2 text-[13px]"
          >
            <option value="">Select a version…</option>
            {available.data.versions.map((v) => (
              <option key={v.tag} value={v.tag} disabled={v.imported}>
                {v.tag}
                {v.imported ? " — imported" : ""}
                {!v.has_binary ? " — no binary" : ""}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={!pickedTag || importFromRepo.isPending}
            onClick={() => importFromRepo.mutate(pickedTag)}
          >
            Import binary
          </Button>
          {available.data.error && (
            <span className="text-[11px] text-destructive">
              couldn’t list versions: {available.data.error}
            </span>
          )}
        </div>
      )}

      {releases.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-left text-[13px]">
            <tbody className="divide-y divide-border">
              {releases.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-mono font-medium">
                    {r.version}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary" className="text-[10px]">
                      {r.source === "git" ? "git" : "file"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.source === "git"
                      ? `${r.git_url}@${r.git_ref}`
                      : humanSize(r.size_bytes)}
                  </td>
                  <td className="px-3 py-2">
                    {r.is_default ? (
                      <span
                        className="inline-flex items-center gap-1 text-[12px] text-primary"
                        title="Golden image — auto-updating Outposts move to this version"
                      >
                        <Star className="h-3.5 w-3.5 fill-current" /> golden
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="text-[12px] text-muted-foreground hover:text-foreground"
                        onClick={() => setDefault.mutate(r)}
                        title="Make this the golden image (auto-update target)"
                      >
                        make golden
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => remove.mutate(r)}
                      title="Remove version"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Upload a build file */}
        <form
          className="space-y-2 rounded-lg border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (file && fileVersion.trim()) uploadFile.mutate()
          }}
        >
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <Upload className="h-3.5 w-3.5" /> Upload a build
          </div>
          <Input
            value={fileVersion}
            onChange={(e) => setFileVersion(e.target.value)}
            placeholder="Version, e.g. 1.4.0"
            className="h-8 text-sm"
          />
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full text-[12px] file:mr-2 file:rounded file:border file:border-border file:bg-muted file:px-2 file:py-1 file:text-[12px]"
          />
          <Button
            type="submit"
            size="sm"
            className="h-8 text-xs"
            disabled={!file || !fileVersion.trim() || uploadFile.isPending}
          >
            Upload
          </Button>
        </form>

        {/* Add a git version */}
        <form
          className="space-y-2 rounded-lg border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (gitVersion.trim() && gitUrl.trim()) addGit.mutate()
          }}
        >
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <GitBranch className="h-3.5 w-3.5" /> From a git repo
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={gitVersion}
              onChange={(e) => setGitVersion(e.target.value)}
              placeholder="Version"
              className="h-8 text-sm"
            />
            <Input
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              placeholder="ref (tag/branch)"
              className="h-8 text-sm"
            />
          </div>
          <Input
            value={gitUrl}
            onChange={(e) => {
              const { cleanUrl, ref } = parseGitRef(e.target.value)
              setGitUrl(cleanUrl)
              if (ref) {
                setGitRef(ref)
                setGitVersion((v) => (v.trim() ? v : ref))
              }
            }}
            placeholder="https://github.com/…/danbyte-outpost/tree/v1.2.0"
            className="h-8 font-mono text-xs"
          />
          <Input
            value={gitToken}
            onChange={(e) => setGitToken(e.target.value)}
            placeholder="GitHub token — only for a private repo (optional)"
            type="password"
            className="h-8 font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              disabled={
                !gitUrl.trim() || !gitRef.trim() || fetchBinary.isPending
              }
              onClick={() => fetchBinary.mutate()}
              title="Download the CI-built binary from this release"
            >
              Fetch built binary
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={
                !gitVersion.trim() || !gitUrl.trim() || addGit.isPending
              }
              title="Source install on the host (pip install git+url@ref)"
            >
              Source install
            </Button>
          </div>
        </form>
      </div>
    </section>
  )
}
