---
title: Routing templates
description: Two complete device-config templates over the routing block - NX-OS style and FRR - rendered from the demo fabric.
---

# Routing templates

Danbyte renders what is modelled; the template is yours. These two are
complete, tested templates over the [`routing` block](routing.md#rendering-a-config)
- paste one into **Settings › Export templates** as a `device` template,
bind it to a platform or role, and **Render config** on a device page prints
the box's config. Both are rendered against the demo fabric in the test
suite, so they track the block as it grows.

## The demo fabric

```bash
.venv/bin/python manage.py seed_fabric        # re-runnable; --wipe starts over
```

Seeds, in the *Acme Networks* tenant at `dc-fra-01`: two spines and four
leaves with `Loopback0` in `10.255.0.0/24`; point-to-point `/31` uplinks
in IS-IS level 2 (process `UNDERLAY`, MD5 on the `FABRIC` keychain, which
has no key set - the store fails closed until you give it one); iBGP EVPN
from every leaf to both spines through the `SPINES` peer group, the spines
as route reflectors, every session paired with its far end; a VTEP per
leaf carrying VNIs 10100/10110/10120 (VLANs 100/110/120) and the L3VNI 5000
of VRF `TENANT-A`; an anycast gateway per VLAN (an SVI in the VRF on every
leaf, the shared address on an FHRP group of the anycast kind); the
`EVPN-EXPORT` policy matching the `LOOPBACKS` prefix list; and a default
static route in `TENANT-A`. Demo inventory, never bootstrap.

## NX-OS style

The IOS/NX-OS family keeps one `router bgp` with the VRFs nested, VLAN-to-VNI
under `vlan`, the VTEP as `interface nve1`. Address masks come from the
[address filters](export-templates.md#address-filters): an address's own
mask length when set (a `/31` uplink inside a `/24` link block), else its
prefix's.

```jinja
{# template: nxos #}
hostname {{ device.name }}
!
{% for vrf in routing.vrfs %}
vrf context {{ vrf.name }}
{% if vrf.rd %}
  rd {{ vrf.rd }}
{% endif %}
{% if vrf.l3vni %}
  vni {{ vrf.l3vni }}
{% endif %}
{% if vrf.import_targets or vrf.export_targets %}
  address-family ipv4 unicast
{% for rt in vrf.import_targets %}
    route-target import {{ rt }}
    route-target import {{ rt }} evpn
{% endfor %}
{% for rt in vrf.export_targets %}
    route-target export {{ rt }}
    route-target export {{ rt }} evpn
{% endfor %}
{% endif %}
!
{% endfor %}
{% for k in routing.keychains %}
key chain {{ k.name }}
  key 1
    key-string {{ "<set on the box>" if not k.key_set else "<from Danbyte>" }}
!
{% endfor %}
{% for name, pl in routing.prefix_lists.items() %}
{% for r in pl.rules %}
ip prefix-list {{ name }} seq {{ r.sequence }} {{ r.action }} {{ r.prefix }}{% if r.ge %} ge {{ r.ge }}{% endif %}{% if r.le %} le {{ r.le }}{% endif %}

{% endfor %}
{% endfor %}
{% for name, pol in routing.policies.items() %}
{% for r in pol.rules %}
route-map {{ name }} {{ r.action }} {{ r.sequence }}
{% for pl in r.match.prefix_lists %}
  match ip address prefix-list {{ pl }}
{% endfor %}
{% if r.set.local_pref %}
  set local-preference {{ r.set.local_pref }}
{% endif %}
{% endfor %}
!
{% endfor %}
{% if routing.vtep %}
{% for v in routing.vtep.vnis if v.vlan %}
vlan {{ v.vlan }}
  name {{ v.vlan_name }}
  vn-segment {{ v.vni }}
{% endfor %}
!
{% for v in routing.vtep.vnis %}
evpn
  vni {{ v.vni }} {{ "l3" if v.kind == "l3" else "l2" }}
    rd {{ v.rd or "auto" }}
{% for rt in v.import_targets %}
    route-target import {{ rt }}
{% endfor %}
{% for rt in v.export_targets %}
    route-target export {{ rt }}
{% endfor %}
{% endfor %}
!
fabric forwarding anycast-gateway-mac {{ routing.vtep.anycast_gateway_mac }}
!
interface nve1
  no shutdown
  host-reachability protocol bgp
  source-interface {{ routing.vtep.source_interface }}
{% for v in routing.vtep.vnis %}
  member vni {{ v.vni }}{% if v.kind == "l3" %} associate-vrf{% endif %}

{% if v.kind == "l2" and v.ingress_replication %}
    ingress-replication protocol bgp
{% elif v.kind == "l2" and v.mcast_group %}
    mcast-group {{ v.mcast_group }}
{% endif %}
{% if v.kind == "l2" and routing.vtep.arp_suppression %}
    suppress-arp
{% endif %}
{% endfor %}
!
{% endif %}
{% for i in interfaces %}
interface {{ i.name }}
{% if i.description %}
  description {{ i.description }}
{% endif %}
{% if i.vrf %}
  vrf member {{ i.vrf.name }}
{% endif %}
{% for ip in ip_addresses if ip.assigned_interface_id == i.id %}
  ip address {{ ip | host }}/{{ ip | prefixlen }}
{% endfor %}
{% set r = routing.by_interface.get(i.name) %}
{% if r and r.gateway %}
  ip address {{ r.gateway }}
  fabric forwarding mode anycast-gateway
{% endif %}
{% if r and r.isis %}
  ip router isis {{ r.isis.process }}
{% if r.isis.network_type == "point-to-point" %}
  isis network point-to-point
{% endif %}
{% if r.isis.passive %}
  isis passive-interface level-1-2
{% endif %}
{% endif %}
{% if r and r.ospf %}
  ip router ospf {{ r.ospf.process_id }} area {{ r.ospf.area }}
{% endif %}
!
{% endfor %}
{% for inst in routing.isis %}
router isis {{ inst.process }}
  net {{ inst.net }}
  is-type level-{{ inst.level }}
  metric-style {{ inst.metric_style }}
{% if inst.keychain %}
  authentication-check
  authentication key-chain {{ inst.keychain }} level-{{ inst.level }}
{% endif %}
{% if inst.bfd %}
  bfd
{% endif %}
!
{% endfor %}
{% for inst in routing.ospf %}
router ospf {{ inst.process_id }}
{% if inst.vrf %}
  vrf {{ inst.vrf }}
{% endif %}
{% if inst.router_id %}
  router-id {{ inst.router_id }}
{% endif %}
!
{% endfor %}
{% for inst in routing.bgp if not inst.vrf %}
router bgp {{ inst.asn }}
  router-id {{ inst.router_id }}
{% if inst.cluster_id %}
  cluster-id {{ inst.cluster_id }}
{% endif %}
{% for af in inst.address_families %}
  address-family {{ af.afi_safi | replace("-", " ") }}
{% for n in af.networks %}
    network {{ n }}
{% endfor %}
{% if af.maximum_paths %}
    maximum-paths {{ af.maximum_paths }}
{% endif %}
{% endfor %}
{% for g in inst.peer_groups %}
  template peer {{ g.name }}
{% if g.remote_asn_mode == "internal" %}
    remote-as {{ g.local_asn }}
{% elif g.remote_asn %}
    remote-as {{ g.remote_asn }}
{% endif %}
{% if g.update_source %}
    update-source {{ g.update_source }}
{% endif %}
{% if g.bfd %}
    bfd
{% endif %}
{% for af in g.address_families %}
    address-family {{ af | replace("-", " ") }}
{% if g.send_community in ("both", "extended") %}
      send-community extended
{% endif %}
{% if g.route_reflector_client %}
      route-reflector-client
{% endif %}
{% endfor %}
{% endfor %}
{% for s in inst.sessions %}
  neighbor {{ s.remote_address or s.interface }}
{% if s.peer_group %}
    inherit peer {{ s.peer_group }}
{% else %}
    remote-as {{ s.remote_asn }}
{% if s.update_source %}
    update-source {{ s.update_source }}
{% endif %}
{% endif %}
{% if s.description %}
    description {{ s.description }}
{% endif %}
{% if s.keychain %}
    password 0 <{{ s.keychain }}>
{% endif %}
{% for af in s.address_families if not s.peer_group %}
    address-family {{ af | replace("-", " ") }}
{% if s.route_reflector_client %}
      route-reflector-client
{% endif %}
{% if s.send_community in ("both", "extended") %}
      send-community extended
{% endif %}
{% if s.default_originate %}
      default-originate
{% endif %}
{% if s.maximum_prefix %}
      maximum-prefix {{ s.maximum_prefix }}
{% endif %}
{% if s.allowas_in %}
      allowas-in {{ s.allowas_in }}
{% endif %}
{% if s.as_override %}
      as-override
{% endif %}
{% if s.soft_reconfiguration %}
      soft-reconfiguration inbound
{% endif %}
{% endfor %}
{% endfor %}
{% for vinst in routing.bgp if vinst.vrf %}
  vrf {{ vinst.vrf }}
{% for af in vinst.address_families %}
    address-family {{ af.afi_safi | replace("-", " ") }}
{% for rd in af.redistribute %}
      redistribute {{ rd.source }}{% if rd.policy %} route-map {{ rd.policy }}{% endif %}

{% endfor %}
{% if af.afi_safi == "ipv4-unicast" %}
      advertise l2vpn evpn
{% endif %}
{% endfor %}
{% endfor %}
!
{% endfor %}
{% for r in routing.static_routes %}
{% if r.vrf %}
vrf context {{ r.vrf }}
  ip route {{ r.prefix }} {{ r.next_hop or r.next_hop_interface }}{% if r.distance %} {{ r.distance }}{% endif %}

{% else %}
ip route {{ r.prefix }} {{ r.next_hop or r.next_hop_interface }}{% if r.distance %} {{ r.distance }}{% endif %}

{% endif %}
{% endfor %}
```

The keychain and BGP password lines print a placeholder: Danbyte never
puts a secret in a rendered config. A runner that pushes the config swaps
it for `POST /api/routing/keychains/<id>/reveal-psk/`, an audited read.

## FRR

FRR (and the Cumulus/SONiC boxes built on it) takes one `frr.conf`:
interfaces, `router isis`, one `router bgp` per VRF, VXLAN under
`address-family l2vpn evpn`. The output of this template for a seeded leaf
is what `vtysh -f` reads.

```jinja
{# template: frr #}
frr defaults datacenter
hostname {{ device.name }}
!
{% for vrf in routing.vrfs %}
vrf {{ vrf.name }}
{% if vrf.l3vni %}
 vni {{ vrf.l3vni }}
{% endif %}
exit-vrf
!
{% endfor %}
{% for i in interfaces %}
interface {{ i.name }}{% if i.vrf %} vrf {{ i.vrf.name }}{% endif %}

{% if i.description %}
 description {{ i.description }}
{% endif %}
{% for ip in ip_addresses if ip.assigned_interface_id == i.id %}
 ip address {{ ip | cidr }}
{% endfor %}
{% set r = routing.by_interface.get(i.name) %}
{% if r and r.gateway %}
 ip address {{ r.gateway }}
{% if r.nd and r.nd.ra %}
 no ipv6 nd suppress-ra
 ipv6 nd prefix {{ r.nd.prefix }}
{% if r.nd.ra_interval %}
 ipv6 nd ra-interval {{ r.nd.ra_interval }}
{% endif %}
{% endif %}
{% endif %}
{% if r and r.isis %}
{% for fam in r.isis.families %}
 {{ "ip" if fam == "ipv4" else "ipv6" }} router isis {{ r.isis.process }}
{% endfor %}
{% if r.isis.network_type == "point-to-point" %}
 isis network point-to-point
{% endif %}
{% if r.isis.passive %}
 isis passive
{% endif %}
{% if r.isis.bfd %}
 isis bfd
{% endif %}
{% endif %}
{% if r and r.ospf %}
 ip ospf area {{ r.ospf.area }}
{% if r.ospf.network_type %}
 ip ospf network {{ r.ospf.network_type }}
{% endif %}
{% endif %}
{% if r and r.es %}
{% if r.es.esi %}
 evpn mh es-id {{ r.es.esi }}
{% else %}
 evpn mh es-id {{ r.es.es_id }}
 evpn mh es-sys-mac {{ r.es.sys_mac }}
{% endif %}
{% if r.es.df_preference %}
 evpn mh es-df-pref {{ r.es.df_preference }}
{% endif %}
{% endif %}
{% if r and r.evpn_mh_uplink %}
 evpn mh uplink
{% endif %}
exit
!
{% endfor %}
{% if routing.ldp %}
mpls ldp
{% if routing.ldp.router_id %}
 router-id {{ routing.ldp.router_id }}
{% endif %}
 address-family ipv4
{% if routing.ldp.transport_address %}
  discovery transport-address {{ routing.ldp.transport_address }}
{% endif %}
{% if routing.ldp.label_allocation == "host-routes" %}
  label local allocate host-routes
{% endif %}
{% for name in routing.ldp.interfaces %}
  interface {{ name }}
{% endfor %}
 exit-address-family
exit
!
{% endif %}
{% for inst in routing.isis %}
router isis {{ inst.process }}
 net {{ inst.net }}
 is-type {{ inst.level_frr }}
 metric-style {{ inst.metric_style }}
{% if inst.lsp_gen_interval %}
 lsp-gen-interval {{ inst.lsp_gen_interval }}
{% endif %}
{% if inst.spf_interval %}
 spf-interval {{ inst.spf_interval }}
{% endif %}
{% if inst.spf_delay_ietf %}
{% set d = inst.spf_delay_ietf %}
 spf-delay-ietf init-delay {{ d.init_delay }} short-delay {{ d.short_delay }} long-delay {{ d.long_delay }} holddown {{ d.holddown }} time-to-learn {{ d.time_to_learn }}
{% endif %}
{% if inst.lsp_mtu %}
 lsp-mtu {{ inst.lsp_mtu }}
{% endif %}
{% if inst.log_adjacency_changes %}
 log-adjacency-changes
{% endif %}
{% for fam, mode in inst.default_originate.items() %}
 default-information originate {{ fam }} {{ inst.level_frr }}{% if mode == "always" %} always{% endif %}

{% endfor %}
{% for rd in inst.redistribute %}
 redistribute {{ rd.family }} {{ rd.source }} {{ rd.level_frr }}{% if rd.policy %} route-map {{ rd.policy }}{% endif %}

{% endfor %}
{% if inst.keychain %}
 area-password md5 <{{ inst.keychain }}>
{% endif %}
exit
!
{% endfor %}
{% for inst in routing.ospf %}
router ospf{% if inst.vrf %} vrf {{ inst.vrf }}{% endif %}

{% if inst.router_id %}
 ospf router-id {{ inst.router_id }}
{% endif %}
exit
!
{% endfor %}
{% for inst in routing.bgp %}
router bgp {{ inst.asn }}{% if inst.vrf %} vrf {{ inst.vrf }}{% endif %}

{% if inst.router_id %}
 bgp router-id {{ inst.router_id }}
{% endif %}
{% if inst.cluster_id %}
 bgp cluster-id {{ inst.cluster_id }}
{% endif %}
{% if inst.distance %}
 distance bgp {{ inst.distance.ebgp }} {{ inst.distance.ibgp }} {{ inst.distance.local }}
{% endif %}
{% if inst.bestpath_multipath_relax %}
 bgp bestpath as-path multipath-relax
{% endif %}
{% for g in inst.peer_groups %}
 neighbor {{ g.name }} peer-group
{% if g.remote_asn_mode in ("internal", "external") %}
 neighbor {{ g.name }} remote-as {{ g.remote_asn_mode }}
{% elif g.remote_asn %}
 neighbor {{ g.name }} remote-as {{ g.remote_asn }}
{% endif %}
{% if g.update_source %}
 neighbor {{ g.name }} update-source {{ g.update_source }}
{% endif %}
{% if g.bfd %}
 neighbor {{ g.name }} bfd
{% endif %}
{% if g.capability_extended_nexthop %}
 neighbor {{ g.name }} capability extended-nexthop
{% endif %}
{% if g.ttl_security_hops %}
 neighbor {{ g.name }} ttl-security hops {{ g.ttl_security_hops }}
{% endif %}
{% if g.keychain %}
 neighbor {{ g.name }} password <{{ g.keychain }}>
{% endif %}
{% endfor %}
{% for s in inst.sessions %}
{% set who = s.remote_address or s.interface %}
{% if s.interface %}
 neighbor {{ who }} interface{% if s.peer_group %} peer-group {{ s.peer_group }}{% else %} remote-as {{ s.remote_asn_mode if s.remote_asn_mode in ("internal", "external") else s.remote_asn }}{% endif %}

{% elif s.peer_group %}
 neighbor {{ who }} peer-group {{ s.peer_group }}
{% else %}
 neighbor {{ who }} remote-as {{ s.remote_asn_effective }}
{% if s.update_source %}
 neighbor {{ who }} update-source {{ s.update_source }}
{% endif %}
{% if s.bfd %}
 neighbor {{ who }} bfd
{% endif %}
{% if s.capability_extended_nexthop %}
 neighbor {{ who }} capability extended-nexthop
{% endif %}
{% if s.ttl_security_hops %}
 neighbor {{ who }} ttl-security hops {{ s.ttl_security_hops }}
{% endif %}
{% if s.keychain %}
 neighbor {{ who }} password <{{ s.keychain }}>
{% endif %}
{% endif %}
{% if s.description %}
 neighbor {{ who }} description {{ s.description }}
{% endif %}
{% endfor %}
{% for af in inst.address_families %}
 address-family {{ af.afi_safi | replace("-", " ") }}
{% if inst.vpn and inst.vrf and af.afi_safi == "ipv4-unicast" %}
{% set vrf = routing.vrfs | selectattr("name", "equalto", inst.vrf) | first %}
  rd vpn export {{ vrf.rd }}
{% for rt in vrf.import_targets %}
  rt vpn import {{ rt }}
{% endfor %}
{% for rt in vrf.export_targets %}
  rt vpn export {{ rt }}
{% endfor %}
{% if inst.vpn.label_export %}
  label vpn export {{ inst.vpn.label_export }}
{% endif %}
{% if inst.vpn.nexthop_export %}
  nexthop vpn export {{ inst.vpn.nexthop_export }}
{% endif %}
{% if inst.vpn.import %}
  import vpn
{% endif %}
{% if inst.vpn.export %}
  export vpn
{% endif %}
{% endif %}
{% for n in af.networks %}
  network {{ n }}
{% endfor %}
{% if af.maximum_paths %}
  maximum-paths {{ af.maximum_paths }}
{% endif %}
{% for rd in af.redistribute %}
  redistribute {{ rd.source }}{% if rd.policy %} route-map {{ rd.policy }}{% endif %}

{% endfor %}
{% for g in inst.peer_groups if af.afi_safi in g.address_families %}
  neighbor {{ g.name }} activate
{% if g.route_reflector_client %}
  neighbor {{ g.name }} route-reflector-client
{% endif %}
{% if g.default_originate %}
  neighbor {{ g.name }} default-originate{% if g.default_originate_policy %} route-map {{ g.default_originate_policy }}{% endif %}

{% endif %}
{% if g.send_community in ("both", "extended") and af.afi_safi != "l2vpn-evpn" %}
  neighbor {{ g.name }} send-community extended
{% endif %}
{% endfor %}
{% for s in inst.sessions if af.afi_safi in s.address_families %}
{% set who = s.remote_address or s.interface %}
  neighbor {{ who }} activate
{% if s.route_reflector_client and not s.route_reflector_client_from_group %}
  neighbor {{ who }} route-reflector-client
{% endif %}
{% if s.default_originate and not s.peer_group %}
  neighbor {{ who }} default-originate{% if s.default_originate_policy %} route-map {{ s.default_originate_policy }}{% endif %}

{% endif %}
{% if s.send_community in ("both", "extended") and not s.peer_group and af.afi_safi != "l2vpn-evpn" %}
  neighbor {{ who }} send-community extended
{% endif %}
{% if af.export_policy %}
  neighbor {{ who }} route-map {{ af.export_policy }} out
{% endif %}
{% if af.import_policy %}
  neighbor {{ who }} route-map {{ af.import_policy }} in
{% endif %}
{% if s.default_originate %}
  neighbor {{ who }} default-originate
{% endif %}
{% if s.maximum_prefix %}
  neighbor {{ who }} maximum-prefix {{ s.maximum_prefix }}
{% endif %}
{% if s.allowas_in %}
  neighbor {{ who }} allowas-in {{ s.allowas_in }}
{% endif %}
{% if s.as_override %}
  neighbor {{ who }} as-override
{% endif %}
{% if s.remove_private_as %}
  neighbor {{ who }} remove-private-AS
{% endif %}
{% if s.soft_reconfiguration %}
  neighbor {{ who }} soft-reconfiguration inbound
{% endif %}
{% endfor %}
{% if af.afi_safi == "l2vpn-evpn" and routing.vtep and not inst.vrf %}
  advertise-all-vni
{% for v in routing.vtep.vnis if v.kind == "l2" %}
  vni {{ v.vni }}
{% if v.rd %}
   rd {{ v.rd }}
{% endif %}
{% for rt in v.import_targets %}
   route-target import {{ rt }}
{% endfor %}
{% for rt in v.export_targets %}
   route-target export {{ rt }}
{% endfor %}
  exit-vni
{% endfor %}
{% endif %}
{% for a in af.advertise %}
  advertise {{ a }}
{% endfor %}
 exit-address-family
{% endfor %}
exit
!
{% endfor %}
{% for name, pl in routing.prefix_lists.items() %}
{% for r in pl.rules %}
ip prefix-list {{ name }} seq {{ r.sequence }} {{ r.action }} {{ r.prefix }}{% if r.ge %} ge {{ r.ge }}{% endif %}{% if r.le %} le {{ r.le }}{% endif %}

{% endfor %}
{% endfor %}
{% for name, pol in routing.policies.items() %}
{% for r in pol.rules %}
route-map {{ name }} {{ r.action }} {{ r.sequence }}
{% for pl in r.match.prefix_lists %}
 match ip address prefix-list {{ pl }}
{% endfor %}
{% if r.set.local_pref %}
 set local-preference {{ r.set.local_pref }}
{% endif %}
exit
{% endfor %}
!
{% endfor %}
{% for r in routing.static_routes %}
ip route {{ r.prefix }} {{ r.next_hop or r.next_hop_interface }}{% if r.vrf %} vrf {{ r.vrf }}{% endif %}{% if r.distance %} {{ r.distance }}{% endif %}

{% endfor %}
```

EVPN always carries extended communities in FRR, so `send-community`
prints only for the other address families. FRR's L3VNI lives on the VRF (`vrf TENANT-A` / `vni 5000`) and the routed
side on `router bgp 65100 vrf TENANT-A`, which is why the seeded fabric
gives every leaf a BGP instance in the VRF as well as the global one - the
template prints both from the same `routing.bgp` loop.

## One shape, everywhere

A few rules keep templates short:

- **Names, not objects, on the rows.** Wherever a session, an instance or an
  interface row carries a `keychain` or a `bfd_profile`, it is the name (or
  `null`). The details live once, at the top: `routing.keychains` and
  `routing.bfd_profiles` as lists, and `routing.keychain_by_name` and
  `routing.bfd_profile_by_name` as lookups - `routing.bfd_profile_by_name[r.bfd_profile].min_tx`.
- **The EVPN family says what it advertises.** `af.advertise` is the list of
  `advertise <afi> unicast` lines an `l2vpn evpn` family wants (from the
  family's *Advertise IPv4/IPv6 unicast* switches), so a template loops it
  instead of guessing from the VRF.
- **The anycast gateway comes with its neighbour discovery.** `r.gateway` is
  the address with its mask; `r.nd` carries `ra`, `ra_interval` and the
  subnet `prefix` from the gateway's FHRP group, for the `ipv6 nd` lines.

## Reading the two side by side

| Concern | NX-OS style | FRR |
|---|---|---|
| VRFs | `vrf context`, L3VNI as `vni` | `vrf` / `vni` / `exit-vrf` |
| VLAN ↔ VNI | `vlan N` / `vn-segment` | the bridge's `vxlan` netdevs (outside `frr.conf`) |
| VTEP | `interface nve1`, `member vni` | `advertise-all-vni` under `l2vpn evpn` |
| Peer groups | `template peer` / `inherit peer` | `neighbor X peer-group` |
| Per-VRF BGP | `vrf` inside one `router bgp` | one `router bgp … vrf` per VRF |
| Secrets | `password 0 <keychain>` placeholder | `password <keychain>` placeholder |

A template is a starting point, not a standard: every fabric spells these
differently, and the `extra` dicts on instances, sessions and interfaces
are yours for the knobs Danbyte does not name.
