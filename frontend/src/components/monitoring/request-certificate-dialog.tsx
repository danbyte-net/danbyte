import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Download, ShieldAlert } from "lucide-react"

import { api } from "@/lib/api"
import type { CertKeySpec, CertificateRequestCreated } from "@/lib/api"
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
import { FormText } from "@/components/forms/text"
import { FormSelect } from "@/components/forms/select"
import { CopyButton } from "@/components/kv-card"

const KEY_SPECS: { value: CertKeySpec; label: string }[] = [
  { value: "rsa-2048", label: "RSA 2048" },
  { value: "rsa-3072", label: "RSA 3072" },
  { value: "rsa-4096", label: "RSA 4096" },
  { value: "ec-p256", label: "ECDSA P-256" },
  { value: "ec-p384", label: "ECDSA P-384" },
  { value: "ed25519", label: "Ed25519" },
]

function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/x-pem-file" })
  )
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

const lines = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean)

/**
 * Generate a CSR + key pair. Two phases: the request form, then a one-time
 * reveal of the private key (Danbyte returns it exactly once — the store never
 * hands it back over the API afterwards without the change grant), with the CSR
 * ready to download and take to a CA.
 */
export function RequestCertificateDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [cn, setCn] = useState("")
  const [org, setOrg] = useState("")
  const [ou, setOu] = useState("")
  const [country, setCountry] = useState("")
  const [state, setState] = useState("")
  const [locality, setLocality] = useState("")
  const [sans, setSans] = useState("")
  const [keySpec, setKeySpec] = useState<CertKeySpec>("rsa-2048")
  const [created, setCreated] = useState<CertificateRequestCreated | null>(null)

  const reset = () => {
    setCn("")
    setOrg("")
    setOu("")
    setCountry("")
    setState("")
    setLocality("")
    setSans("")
    setKeySpec("rsa-2048")
    setCreated(null)
  }

  const gen = useMutation({
    mutationFn: () => {
      const all = lines(sans)
      const ipish = /^[0-9.:]+$/
      return api<CertificateRequestCreated>(
        "/api/monitoring/certificate-requests/",
        {
          method: "POST",
          body: JSON.stringify({
            common_name: cn.trim(),
            organization: org.trim(),
            organizational_unit: ou.trim(),
            country: country.trim(),
            state: state.trim(),
            locality: locality.trim(),
            san_dns: all.filter((v) => !ipish.test(v)),
            san_ip: all.filter((v) => ipish.test(v)),
            key_spec: keySpec,
          }),
        }
      )
    },
    onSuccess: (data) => {
      setCreated(data)
      qc.invalidateQueries({ queryKey: ["certificate-requests"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  const close = () => {
    reset()
    onOpenChange(false)
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
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Certificate request created</DialogTitle>
              <DialogDescription>
                Save the private key now — this is the only time it is shown.
                Download the CSR and give it to your certificate authority.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800 ring-1 ring-amber-600/20 ring-inset dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-400/20">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  The private key is stored in your secret store, but for safety
                  it is only displayed here once. Download or copy it now.
                </span>
              </div>
              <Field label="Private key">
                <div className="space-y-2">
                  <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]">
                    {created.private_key}
                  </pre>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        download(`${cn || "request"}.key`, created.private_key)
                      }
                    >
                      <Download className="h-3.5 w-3.5" /> Download key
                    </Button>
                    <CopyButton value={created.private_key} />
                  </div>
                </div>
              </Field>
              <Field label="CSR">
                <div className="space-y-2">
                  <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]">
                    {created.csr_pem}
                  </pre>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        download(`${cn || "request"}.csr`, created.csr_pem)
                      }
                    >
                      <Download className="h-3.5 w-3.5" /> Download CSR
                    </Button>
                    <CopyButton value={created.csr_pem} />
                  </div>
                </div>
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Request a certificate</DialogTitle>
              <DialogDescription>
                Danbyte generates the key pair and CSR. The private key is kept
                in your secret store and shown to you once.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <FormText
                label="Common name (CN)"
                value={cn}
                onChange={setCn}
                placeholder="svc.example.com"
              />
              <Field
                label="Subject alternative names"
                hint="One per line or comma-separated; DNS names and IPs both work."
              >
                <textarea
                  value={sans}
                  onChange={(e) => setSans(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder={"svc.example.com\nwww.example.com\n10.0.0.5"}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </Field>
              <FormSelect
                label="Key"
                value={keySpec}
                onChange={(v) => v && setKeySpec(v as CertKeySpec)}
                options={KEY_SPECS}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormText label="Organization" value={org} onChange={setOrg} />
                <FormText
                  label="Organizational unit"
                  value={ou}
                  onChange={setOu}
                />
                <FormText
                  label="Country (2-letter)"
                  value={country}
                  onChange={setCountry}
                  placeholder="US"
                />
                <FormText
                  label="State / province"
                  value={state}
                  onChange={setState}
                />
                <FormText
                  label="Locality"
                  value={locality}
                  onChange={setLocality}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!cn.trim() || gen.isPending}
                onClick={() => gen.mutate()}
              >
                {gen.isPending ? "Generating…" : "Generate CSR"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
