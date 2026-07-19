import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ImageUp, Trash2 } from "lucide-react"

import { api, ApiError, type DeviceType } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { useMe } from "@/lib/use-me"

type Face = "front" | "rear"

/**
 * Front/rear rack-face image management for a device type. Each face shows the
 * current image (or an empty drop target) with Upload / Replace + Remove
 * controls. Uploads hit the multipart `images` action; the rack elevation
 * paints whichever face the user is viewing.
 */
export function DeviceTypeImages({ deviceType }: { deviceType: DeviceType }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FaceCard deviceType={deviceType} face="front" />
      <FaceCard deviceType={deviceType} face="rear" />
    </div>
  )
}

function FaceCard({
  deviceType,
  face,
}: {
  deviceType: DeviceType
  face: Face
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canChange = canDo("devicetype", "change")
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const image = face === "rear" ? deviceType.rear_image : deviceType.front_image
  const label = face === "rear" ? "Rear" : "Front"

  const invalidate = (next: DeviceType) => {
    qc.setQueryData(["device-type", deviceType.id], next)
    qc.invalidateQueries({ queryKey: ["device-type", deviceType.id] })
    // Elevations read the image off the device's nested device_type.
    qc.invalidateQueries({ queryKey: ["rack-devices"] })
  }

  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData()
      fd.append(`${face}_image`, file)
      return api<DeviceType>(`/api/device-types/${deviceType.id}/images/`, {
        method: "POST",
        body: fd,
      })
    },
    onSuccess: invalidate,
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : "Upload failed"),
  })

  const clear = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append(`clear_${face}`, "1")
      return api<DeviceType>(`/api/device-types/${deviceType.id}/images/`, {
        method: "POST",
        body: fd,
      })
    },
    onSuccess: invalidate,
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : "Remove failed"),
  })

  const busy = upload.isPending || clear.isPending

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {label} image
        </span>
        {image && canChange && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => {
              setError(null)
              clear.mutate()
            }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </Button>
        )}
      </div>

      <div className="flex aspect-[6/1] w-full items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-muted">
        {image ? (
          <img
            src={image}
            alt={`${label} of ${deviceType.name}`}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-[11px] text-muted-foreground">
            No {label.toLowerCase()} image
          </span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = "" // allow re-selecting the same file
          if (file) {
            setError(null)
            upload.mutate(file)
          }
        }}
      />
      {canChange && (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-full"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <ImageUp className="h-3.5 w-3.5" />
          {busy ? "Uploading…" : image ? "Replace" : "Upload"}
        </Button>
      )}

      {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
