import { Link } from "@tanstack/react-router"

import type { BGPPeerKnobs, BGPSessionEffective } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import type { KvRow } from "@/components/kv-card"

// Small shared pieces for the BGP pages: the remote-AS wording, and the
// neighbour knobs as KvCard rows (a peer group's defaults, a session's own
// values, a session's effective values).

export function remoteAsnText(r: {
  remote_asn: number | null
  remote_asn_mode: string
}): string {
  if (r.remote_asn_mode === "external") return "external"
  if (r.remote_asn_mode === "internal") return "internal"
  return r.remote_asn != null ? String(r.remote_asn) : ""
}

const onOff = (v: boolean | null | undefined, unset: string) =>
  v == null ? (
    <span className="text-muted-foreground">{unset}</span>
  ) : v ? (
    "On"
  ) : (
    "Off"
  )
const numOr = (v: number | null | undefined, unset: string) =>
  v == null ? (
    <span className="text-muted-foreground">{unset}</span>
  ) : (
    <span className="num">{v}</span>
  )
const nameOr = (
  v: { id: string; name: string } | null | undefined,
  unset: string,
  to: string
) =>
  v ? (
    <Link to={to} params={{ id: v.id } as never} className="link font-mono">
      {v.name}
    </Link>
  ) : (
    <span className="text-muted-foreground">{unset}</span>
  )

/** The knob rows. `unset` is what a null reads as - "Default" on a group,
 * "Inherit" on a session's own values. */
export function knobRows(
  k: BGPPeerKnobs | BGPSessionEffective,
  unset: string
): KvRow[] {
  return [
    {
      label: "Address families",
      value: k.address_families.length ? (
        <span className="flex flex-wrap gap-1">
          {k.address_families.map((af) => (
            <Badge key={af} variant="secondary" className="font-mono">
              {af}
            </Badge>
          ))}
        </span>
      ) : (
        <span className="text-muted-foreground">{unset}</span>
      ),
    },
    {
      label: "Import policy",
      value: nameOr(k.import_policy, unset, "/routing-policies/$id"),
    },
    {
      label: "Export policy",
      value: nameOr(k.export_policy, unset, "/routing-policies/$id"),
    },
    { label: "BFD", value: onOff(k.bfd, unset) },
    {
      label: "BFD profile",
      value: nameOr(k.bfd_profile, unset, "/bfd-profiles/$id"),
    },
    { label: "eBGP multihop", value: numOr(k.ebgp_multihop, unset) },
    { label: "Default originate", value: onOff(k.default_originate, unset) },
    { label: "Maximum prefix", value: numOr(k.maximum_prefix, unset) },
    { label: "Allowas-in", value: numOr(k.allowas_in, unset) },
    { label: "AS override", value: onOff(k.as_override, unset) },
    { label: "Remove private AS", value: onOff(k.remove_private_as, unset) },
    {
      label: "Soft reconfiguration",
      value: onOff(k.soft_reconfiguration, unset),
    },
    { label: "Next-hop self", value: onOff(k.next_hop_self, unset) },
    {
      label: "Route reflector client",
      value: onOff(k.route_reflector_client, unset),
    },
    {
      label: "Send community",
      value: k.send_community ? (
        k.send_community
      ) : (
        <span className="text-muted-foreground">{unset}</span>
      ),
    },
    { label: "Keepalive", value: numOr(k.keepalive, unset) },
    { label: "Hold time", value: numOr(k.hold_time, unset) },
    {
      label: "Keychain",
      value: nameOr(k.keychain, unset, "/routing-keychains/$id"),
    },
  ]
}
