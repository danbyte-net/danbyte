import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ImageUp, Trash2 } from "lucide-react"

import { api, type ImageAttachment } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/section"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

type ImageList = { count: number; results: ImageAttachment[] }

/**
 * NetBox-style image attachments for any object with an `images` nested
 * endpoint (devices, racks, sites, locations). A gallery of uploaded photos /
 * diagrams with captions. Uploaders (change permission on `objectType`) get an
 * upload button and per-image remove; everyone else sees the gallery
 * read-only. The whole section hides when there are no images and the viewer
 * can't add any, to keep the detail page uncluttered.
 *
 * `apiBase` is the object's collection path *without* trailing slash, e.g.
 * `/api/devices/<id>` — the component appends `/images/`.
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

  const images = q.data?.results ?? []
  if (images.length === 0 && !canChange) return null

  return (
    <Section
      title="Images"
      count={images.length || undefined}
      actions={
        canChange && (
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
        )
      }
    >
      {images.length === 0 ? (
        <div className="flex aspect-[4/1] w-full items-center justify-center rounded-lg border border-dashed border-border bg-muted">
          <span className="text-[11px] text-muted-foreground">
            No images yet
          </span>
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
                  src={img.image}
                  alt={img.name || "Image"}
                  className="h-full w-full object-cover"
                />
              </a>
              {img.name && (
                <figcaption className="truncate px-2 py-1.5 text-[11px] text-muted-foreground">
                  {img.name}
                </figcaption>
              )}
              {canChange && (
                <button
                  type="button"
                  aria-label="Remove image"
                  disabled={busyId === img.id}
                  onClick={() => remove.mutate(img.id)}
                  className="absolute top-1.5 right-1.5 hidden rounded-md border border-border bg-background/90 p-1 text-destructive shadow-sm hover:bg-background group-hover:block disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </figure>
          ))}
        </div>
      )}
    </Section>
  )
}
