"""The Lifecycle page (#436): every device and virtual machine against the end
dates that matter to it - one row per object per source, soonest first.

``GET /api/lifecycle/`` (``api.lifecycle_list``, paged in SQL since #535)
reads four sources:

* ``hardware`` - a device's type: its release date to its end of support;
* ``os`` - a device's or a VM's own platform, by its effective date: what was
  entered, else its end-of-life mapping while that feature is on
  (``compliance.eol.effective_dates``);
* ``coverage`` - a device's support coverage: its contract with the latest
  end, else its warranty (``api.support_coverage``);
* ``software`` - each application installed on a device or VM, by the same
  rule as the OS: dates entered on the install, else its (application,
  cycle) end-of-life mapping while that feature is on.

Every source is cut to what the caller may view. Devices and VMs come
through ``rbac.restrict_queryset`` (site scope included); a source whose
object type the caller cannot view is left out, not refused. A contract
number shows only on a contract the caller may view, else the row reads
``Contract`` - the device's coverage end itself is a device fact. The rows
are a database view joined to their sources, a page at a time.

Days left, the window and the status are worked out in SQL
(``api.lifecycle_list``), in the rules the rest of Danbyte reads (``compliance.eol.date_status``,
``support_coverage.status_for``), so the page agrees with the badges.
"""

from __future__ import annotations

SOURCES = ("hardware", "os", "coverage", "software")

#: The windows every source is bucketed into - fixed, not the settings, so
#: the page compares sources on one scale. ``none`` has no date.
WINDOWS = ("past", "d90", "d180", "y1", "later", "none")


def window_of(days_left: int | None, past: bool, undated: str = "none") -> str:
    """The bucket of an end ``days_left`` away. ``undated`` is the bucket of
    a row with no date but a known state: a cycle its source marks end of
    life is ``past``, an open-ended contract or a maintained cycle ``later``.
    The list works the same rule out in SQL (``api.lifecycle_list``)."""
    if days_left is None:
        return undated
    if past:
        return "past"
    if days_left <= 90:
        return "d90"
    if days_left <= 180:
        return "d180"
    if days_left <= 365:
        return "y1"
    return "later"
