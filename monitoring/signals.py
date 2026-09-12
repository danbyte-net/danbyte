"""Signals other apps hang off monitoring's workflow moments.

Sent from the model or the view that owns the moment, never from a generic
``post_save``: a maintenance window is only fully described once its silence
and device set are written, and an acknowledgement is one decision even when
it touches three columns.
"""
from django.dispatch import Signal

#: ``event=`` a MaintenanceEvent whose window, status or devices just settled.
#: Sent at the end of ``MaintenanceEvent.sync_silence`` - whatever the caller.
maintenance_window_changed = Signal()

#: ``alert=`` an Alert, ``acknowledged=`` bool - set or cleared.
alert_acknowledged = Signal()

#: ``states=`` the CheckStates an operator confirmed as not flapping,
#: ``user=`` who said so.
flapping_cleared = Signal()
