"""Device-shaped policy matching for rules that pick devices.

An external monitor's provisioning policy picks **devices** ("every switch at
this site", "everything on this platform tagged core"), not addresses. Such a
rule carries the same scope and target fields as
:class:`~monitoring.models.MonitoringPolicy` - ``scope``, ``region``,
``target_site``, ``platform``, ``device_type``, ``device_role``, ``device`` -
and the same filters - ``match_tags``, ``match_name``, ``match_hardware`` - so
the scope table in :mod:`monitoring.policy_scopes` and its ``filters_pass``
answer for it unchanged.

Address-shaped scopes (``vrf``, ``prefix``) never match here: a device has no
single VRF or prefix, and guessing one would widen a rule that can only add
monitoring.
"""
from __future__ import annotations

from monitoring.policy_scopes import BY_VALUE, filters_pass

#: The scopes a device-picking rule may use, loosest first.
DEVICE_SCOPES = (
    "global", "region", "site", "platform", "device_type", "device_role", "device",
)


def device_matches(rule, device, *, device_tags=None, device_hardware=None) -> bool:
    """Whether a device-shaped rule picks this device.

    The scope must match, then every filter must pass (they narrow, never
    widen). ``device_tags`` (a set of slugs) and ``device_hardware`` (a set
    of lower-cased names) may be passed in when the caller has them, to keep
    a pass over many rules to one read per device.
    """
    if device is None or rule.scope not in DEVICE_SCOPES:
        return False
    scope = BY_VALUE.get(rule.scope)
    if scope is None or scope.match is None:
        return False
    # No address: region and site read the device's site, the rest compare
    # device fields directly.
    if not scope.match(rule, None, device):
        return False
    return filters_pass(
        rule, None, device, device_tags=device_tags, device_hardware=device_hardware
    )
