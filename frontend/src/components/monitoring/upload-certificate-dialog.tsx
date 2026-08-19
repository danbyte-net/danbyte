import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { toast } from "sonner"

import { apiStatus } from "@/lib/api"
import type { Certificate } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormText } from "@/components/forms/text"
import { FormTextarea } from "@/components/forms/textarea"
import { Field } from "@/components/forms/field"

/**
 * Author a certificate from a pasted or uploaded **public** PEM. The private
 * key is never accepted - the backend refuses a PRIVATE KEY block with a clean
 * 400, surfaced here via `apiErrorToast`. On success it reports whether a new
 * row was authored (201) or the fingerprint matched an already-seen certificate
 * (200), then invalidates the certificate lists so the row appears at once.
 *
 * Reused by the certificates list ("Upload certificate") and the per-object
 * CertificatesPanel ("Upload"), which passes `onUploaded` to assign the result.
 */
export function UploadCertificateDialog({
  open,
  onOpenChange,
  onUploaded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the created/matched certificate after a successful upload. */
  onUploaded?: (cert: Certificate) => void
}) {
  const qc = useQueryClient()
  const [pem, setPem] = useState("")
  const [name, setName] = useState("")
  const [notes, setNotes] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setPem("")
    setName("")
    setNotes("")
    if (fileRef.current) fileRef.current.value = ""
  }

  const upload = useMutation({
    mutationFn: () =>
      apiStatus<Certificate>("/api/monitoring/certificates/", {
        method: "POST",
        body: JSON.stringify({ pem, name, notes }),
      }),
    onSuccess: ({ data, status }) => {
      // 201 = a new row was authored; 200 = the PEM matched a fingerprint we
      // already had (e.g. already observed on the wire) and is now also marked
      // uploaded. The two are genuinely different outcomes for the operator.
      if (status === 200) {
        toast.success("Matched an already-seen certificate", {
          description: "It was already on record - now marked as uploaded too.",
        })
      } else {
        toast.success("Certificate added")
      }
      qc.invalidateQueries({ queryKey: ["certificates"] })
      qc.invalidateQueries({ queryKey: ["certificate", data.id] })
      onUploaded?.(data)
      reset()
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  const onFile = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setPem(String(reader.result ?? ""))
    reader.onerror = () => toast.error("Couldn't read that file")
    reader.readAsText(file)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Upload certificate</DialogTitle>
          <DialogDescription>
            Paste a public certificate PEM, or load a <code>.pem</code>/
            <code>.crt</code> file. Only the public certificate is stored -
            never a private key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field
            label="Certificate (PEM)"
            hint="Begins with -----BEGIN CERTIFICATE-----"
          >
            <div className="space-y-2">
              <textarea
                value={pem}
                onChange={(e) => setPem(e.target.value)}
                rows={8}
                spellCheck={false}
                placeholder={
                  "-----BEGIN CERTIFICATE-----\nMIIC…\n-----END CERTIFICATE-----"
                }
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pem,.crt,.cer,application/x-pem-file"
                  className="hidden"
                  onChange={(e) => onFile(e.target.files?.[0])}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" /> Load from file…
                </Button>
              </div>
            </div>
          </Field>

          <FormText
            label="Name"
            value={name}
            onChange={setName}
            placeholder="Optional label, e.g. wildcard *.example.com"
          />
          <FormTextarea
            label="Notes"
            value={notes}
            onChange={setNotes}
            rows={2}
            placeholder="Optional notes"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!pem.trim() || upload.isPending}
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? "Uploading…" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
