import { useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ImageIcon,
  ImageUp,
  LayoutGrid,
  List,
  Pencil,
  Trash2,
} from "lucide-react"

import { api, formatBytes, type ImageAttachment } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Section } from "@/components/ui/section"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TimeCell } from "@/components/cells/time-ago"
import { useUrlEnum } from "@/lib/use-url-state"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

type ImageList = { count: number; results: ImageAttachment[] }

const LAYOUTS = ["grid", "list"] as const
type Layout = (typeof LAYOUTS)[number]

/** "1920 × 1080", or a dash for a file whose size couldn't be read. */
function dimensions(img: ImageAttachment): string {
  return img.width && img.height ? `${img.width} × ${img.height}` : "-"
}

/**
 * Image attachments for any object with an `images` nested
 * endpoint (devices, racks, sites, locations). A gallery of uploaded photos /
 * diagrams with captions. Uploaders (change permission on `objectType`) get an
 * upload button and per-image remove; everyone else sees the gallery
 * read-only. The whole section hides when there are no images and the viewer
 * can't add any, to keep the detail page uncluttered.
 *
 * `apiBase` is the object's collection path *without* trailing slash, e.g.
 * `/api/devices/<id>` - the component appends `/images/`.
 */
export function ObjectImages({
  apiBase,
  objectType,
}: {
  apiBase: string
  objectType: string
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canChange = canDo(objectType, "change")
  const inputRef = useRef<HTMLInputElement>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // The LIST is the default (#60): it costs no image downloads at all, so a
  // device with fifty photos opens instantly - the thumbnails only load when
  // the grid tab is chosen. The choice rides on the URL.
  const [layout, setLayout] = useUrlEnum<Layout>("images", "list", LAYOUTS)
  const [search, setSearch] = useState("")
  // Name sort: off (upload order) → A-Z → Z-A.
  const [sort, setSort] = useState<"none" | "asc" | "desc">("none")
  const [renaming, setRenaming] = useState<ImageAttachment | null>(null)
  const queryKey = ["object-images", apiBase]

  const q = useQuery({
    queryKey,
    queryFn: () => api<ImageList>(`${apiBase}/images/`),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey })

  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData()
      fd.append("image", file)
      return api<ImageAttachment>(`${apiBase}/images/`, {
        method: "POST",
        body: fd,
      })
    },
    onSuccess: invalidate,
    onError: (e) => apiErrorToast(e, "Upload failed"),
  })

  const remove = useMutation({
    mutationFn: (imageId: string) => {
      setBusyId(imageId)
      return api(`${apiBase}/images/${imageId}/`, { method: "DELETE" })
    },
    onSuccess: invalidate,
    onError: (e) => apiErrorToast(e, "Remove failed"),
    onSettled: () => setBusyId(null),
  })

  const rename = useMutation({
    mutationFn: (args: { id: string; name: string }) =>
      api<ImageAttachment>(`${apiBase}/images/${args.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ name: args.name }),
      }),
    onSuccess: () => {
      invalidate()
      setRenaming(null)
    },
    onError: (e) => apiErrorToast(e, "Rename failed"),
  })

  const all = q.data?.results ?? []
  // Search matches the caption and the stored file name; sort is by the
  // shown name (caption, else file name). Both are list conveniences - the
  // grid keeps the hand-set sort_order.
  const images = useMemo(() => {
    const shown = (i: ImageAttachment) => i.name || i.filename
    // Search (like sort) belongs to the list - the grid always shows
    // everything, so switching layouts can't leave an invisible filter on.
    const needle = layout === "list" ? search.trim().toLowerCase() : ""
    let out = needle
      ? all.filter(
          (i) =>
            i.name.toLowerCase().includes(needle) ||
            i.filename.toLowerCase().includes(needle)
        )
      : all
    if (sort !== "none" && layout === "list")
      out = [...out].sort(
        (a, b) =>
          shown(a).localeCompare(shown(b), undefined, { numeric: true }) *
          (sort === "asc" ? 1 : -1)
      )
    return out
  }, [all, search, sort, layout])
  if (all.length === 0 && !canChange) return null

  return (
    <Section
      title="Images"
      count={images.length || undefined}
      actions={
        <>
          {layout === "list" && all.length > 1 && (
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="h-7 w-36 text-xs"
            />
          )}
          {all.length > 0 && (
            <SegmentedTabs<Layout>
              value={layout}
              onValueChange={setLayout}
              items={[
                {
                  value: "grid",
                  label: <LayoutGrid className="h-3.5 w-3.5" />,
                },
                { value: "list", label: <List className="h-3.5 w-3.5" /> },
              ]}
            />
          )}
          {canChange && (
            <>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = "" // allow re-selecting the same file
                  if (file) upload.mutate(file)
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={upload.isPending}
                onClick={() => inputRef.current?.click()}
              >
                <ImageUp className="h-3.5 w-3.5" />
                {upload.isPending ? "Uploading…" : "Add image"}
              </Button>
            </>
          )}
        </>
      }
    >
      {images.length === 0 ? (
        <div className="flex aspect-[4/1] w-full items-center justify-center rounded-lg border border-dashed border-border bg-muted">
          <span className="text-[11px] text-muted-foreground">
            {all.length ? "No matches" : "No images yet"}
          </span>
        </div>
      ) : layout === "list" ? (
        // The file list: what each image IS, rather than a wall of pictures.
        // Deliberately NO <img> here - the list must not download a single
        // image, so a device with fifty photos opens instantly; the pictures
        // load when the grid tab is chosen, and a row's link opens its
        // original.
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[13px]">
            <thead className="border-b border-border bg-muted/40 text-[11px] text-muted-foreground">
              <tr>
                <th className="w-9 px-2 py-1.5"></th>
                <th className="px-2 py-1.5 text-left font-medium">
                  <button
                    type="button"
                    className="flex items-center gap-1 hover:text-foreground"
                    onClick={() =>
                      setSort((s2) =>
                        s2 === "none" ? "asc" : s2 === "asc" ? "desc" : "none"
                      )
                    }
                  >
                    Name
                    {sort === "asc" ? (
                      <ArrowUp className="h-3 w-3" />
                    ) : sort === "desc" ? (
                      <ArrowDown className="h-3 w-3" />
                    ) : (
                      <ArrowUpDown className="h-3 w-3 opacity-50" />
                    )}
                  </button>
                </th>
                <th className="px-2 py-1.5 text-left font-medium">Type</th>
                <th className="px-2 py-1.5 text-left font-medium">Size</th>
                <th className="px-2 py-1.5 text-left font-medium">
                  Dimensions
                </th>
                <th className="px-2 py-1.5 text-left font-medium">Updated</th>
                {canChange && <th className="w-14 px-2 py-1.5"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {images.map((img) => (
                <tr key={img.id} className="hover:bg-muted/30">
                  <td className="px-2 py-1.5">
                    <ImageIcon className="h-4 w-4 text-muted-foreground" />
                  </td>
                  <td className="max-w-0 px-2 py-1.5">
                    <a
                      href={img.image}
                      target="_blank"
                      rel="noreferrer"
                      className="link block truncate"
                      title={img.filename}
                    >
                      {img.name || img.filename || "Image"}
                    </a>
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground uppercase">
                    {img.extension || "-"}
                  </td>
                  <td className="num px-2 py-1.5 text-muted-foreground">
                    {img.size ? formatBytes(img.size) : "-"}
                  </td>
                  <td className="num px-2 py-1.5 text-muted-foreground">
                    {dimensions(img)}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    <TimeCell iso={img.updated_at} />
                  </td>
                  {canChange && (
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label="Rename image"
                          onClick={() => setRenaming(img)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Remove image"
                          disabled={busyId === img.id}
                          onClick={() => remove.mutate(img.id)}
                          className="text-destructive hover:opacity-80 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((img) => (
            <figure
              key={img.id}
              className="group relative overflow-hidden rounded-lg border border-border bg-card"
            >
              <a
                href={img.image}
                target="_blank"
                rel="noreferrer"
                className="block aspect-[4/3] w-full overflow-hidden bg-muted"
              >
                <img
                  // The generated thumb keeps a big gallery from downloading
                  // originals (#60); pre-thumbnail uploads fall back.
                  src={img.thumbnail ?? img.image}
                  alt={img.name || "Image"}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </a>
              {img.name && (
                <figcaption className="truncate px-2 py-1.5 text-[11px] text-muted-foreground">
                  {img.name}
                </figcaption>
              )}
              {canChange && (
                <div className="absolute top-1.5 right-1.5 hidden gap-1 group-hover:flex">
                  <button
                    type="button"
                    aria-label="Rename image"
                    onClick={() => setRenaming(img)}
                    className="rounded-md border border-border bg-background/90 p-1 text-muted-foreground shadow-sm hover:bg-background hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove image"
                    disabled={busyId === img.id}
                    onClick={() => remove.mutate(img.id)}
                    className="rounded-md border border-border bg-background/90 p-1 text-destructive shadow-sm hover:bg-background disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </figure>
          ))}
        </div>
      )}
      {renaming && (
        <RenameImageDialog
          image={renaming}
          pending={rename.isPending}
          onSave={(name) => rename.mutate({ id: renaming.id, name })}
          onClose={() => setRenaming(null)}
        />
      )}
    </Section>
  )
}

function RenameImageDialog({
  image,
  pending,
  onSave,
  onClose,
}: {
  image: ImageAttachment
  pending: boolean
  onSave: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(image.name || image.filename)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Rename image</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            onSave(name.trim())
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onFocus={(e) => e.target.select()}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
