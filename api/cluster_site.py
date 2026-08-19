"""Blank-fill a cluster's site onto its VMs, when the cluster opts in.

A cluster's site describes *the cluster*. Its VMs are a separate question: a
central cluster routinely runs workloads that belong to branch offices, so
inheriting the site by default would be wrong (see issue #34). Operators whose
compute and workloads really are in the same place tick
``Cluster.apply_site_to_vms`` instead, and the site is filled in here.

Blank-fill, never overwrite — the same rule the hypervisor syncs follow: a site
an operator set on a VM is left alone, and clearing the cluster's site never
clears the VMs'.
"""
from __future__ import annotations


def apply_cluster_site(cluster, *, only_vm=None) -> int:
    """Give the cluster's site to VMs on it that have none.

    Returns how many VMs were changed. Does nothing unless the cluster opts in
    and actually has a site. Pass ``only_vm`` to limit it to one VM (the
    create/update path); omit it to backfill the whole cluster.
    """
    if cluster is None or not cluster.apply_site_to_vms or cluster.site_id is None:
        return 0
    if only_vm is not None:
        if only_vm.site_id is not None:
            return 0
        only_vm.site_id = cluster.site_id
        only_vm.save(update_fields=["site"])
        return 1
    # Bulk backfill — one UPDATE, and it can't touch a VM that has a site.
    return cluster.virtual_machines.filter(site__isnull=True).update(
        site_id=cluster.site_id
    )
