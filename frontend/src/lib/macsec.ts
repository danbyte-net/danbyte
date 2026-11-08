import type { MacsecCipher } from "@/lib/api"

/** Interface.macsec_cipher's choices, in the model's order. */
export const MACSEC_CIPHER_OPTIONS: { value: MacsecCipher; label: string }[] = [
  { value: "gcm-aes-128", label: "GCM-AES-128" },
  { value: "gcm-aes-256", label: "GCM-AES-256" },
  { value: "gcm-aes-xpn-128", label: "GCM-AES-XPN-128" },
  { value: "gcm-aes-xpn-256", label: "GCM-AES-XPN-256" },
]
