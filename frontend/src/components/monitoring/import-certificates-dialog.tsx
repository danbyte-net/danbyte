import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
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
import { Field } from "@/components/forms/field"

interface BundleResult {
  created: number
  existing: number
  total: number
  errors: string[]
}

/**
 * Import a PEM **bundle** — a whole chain (leaf + intermediates + root) or a
 * batch of concatenated certificates — as separate rows, so the chain graph
 * links up. Unlike the single-cert upload (which keeps only the leaf), every
 * block lands. Still public-only: a private-key block anywhere is refused. Shows
 * a per-import summary so a partial import (one bad block) is honest.
 */
export function ImportCertificatesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [pem, setPem] = useState("")
  const [result, setResult] = useState<BundleResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setPem("")
    setResult(null)
    if (fileRef.current) fileRef.current.value = ""
  }

  const run = useMutation({
    mutationFn: () =>
      api<BundleResult>("/api/monitoring/certificates/import-bundle/", {
        method: "POST",
        body: JSON.stringify({ pem }),
      }),
    onSuccess: (data) => {
      setResult(data)
      qc.invalidateQueries({ queryKey: ["certificates"] })
      const summary = `${data.created} added, ${data.existing} already on file`
      if (data.errors.length) {
        toast.warning(`Imported with ${data.errors.length} skipped`, {
          description: summary,
        })
      } else {
        toast.success("Bundle imported", { description: summary })
      }
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
          <DialogTitle>Import certificate bundle</DialogTitle>
          <DialogDescription>
            Paste a full chain (leaf + intermediates + root) or several
            certificates at once, or load a <code>.pem</code> bundle. Every
            certificate is stored as its own row and linked into its chain —
            only public certificates, never a private key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field
            label="Certificates (PEM)"
            hint="One or more -----BEGIN CERTIFICATE----- blocks"
          >
            <div className="space-y-2">
              <textarea
                value={pem}
                onChange={(e) => setPem(e.target.value)}
                rows={10}
                spellCheck={false}
                placeholder={
                  "-----BEGIN CERTIFICATE-----\n… leaf …\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n… issuer …\n-----END CERTIFICATE-----"
                }
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pem,.crt,.cer,.bundle,.chain,application/x-pem-file"
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

          {result && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <p>
                <span className="num font-medium">{result.created}</span> added,{" "}
                <span className="num font-medium">{result.existing}</span>{" "}
                already on file, of <span className="num">{result.total}</span>{" "}
                block
                {result.total === 1 ? "" : "s"}.
              </p>
              {result.errors.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {result ? "Close" : "Cancel"}
          </Button>
          <Button
            type="button"
            disabled={!pem.trim() || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
