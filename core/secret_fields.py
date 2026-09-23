"""The canonical "is this model field a secret?" classifier.

Single source of truth shared by the audit trail, the generic import/export
handlers, and public share snapshots - so a credential field scrubbed from
the change log can never sneak out through a spreadsheet export or a public
share link instead.

EncryptedJSONField columns decrypt transparently on read (a naive getattr()
yields plaintext), so they're always secret. Detection is by class name
rather than an import to keep this module dependency-free (monitoring defines
the field; core must not import monitoring).
"""
from __future__ import annotations

_SECRET_FIELD_NAMES = {
    "secret", "secrets", "secret_params", "token", "password",
    "api_key", "private_key",
}

# Per-model extras where a generically-named field carries credentials
# (NotificationChannel.config holds PagerDuty routing keys / webhook URLs).
_SECRET_MODEL_FIELDS = {
    "monitoring.notificationchannel": {"config"},
    # Free-text extra request headers routinely carry Authorization / X-Api-Key
    # tokens - treat as secret for export / audit / any snapshot.
    "integrations.webhook": {"additional_headers"},
}


# Methods that hand out (or overwrite) a stored secret however the row was
# reached. A model can hold a credential without holding a secret FIELD -
# DeviceCredential keeps a path and asks the secret store on call - so any
# snapshot, export or template that walks a row must refuse these by name.
SECRET_ACCESSORS = frozenset({
    "resolve_psk", "store_psk", "clear_psk",
    "resolve_secret", "store_managed_secret", "delete_managed_secret",
})


#: The accessors that make a row a *credential* - a login whose every field
#: is sensitive (DeviceCredential). The PSK trio above is different: it hangs
#: a key off an ordinary inventory row (an SSID, an IPsec profile, a routing
#: keychain) whose other fields are exactly what a report is for, and the
#: key itself is only reachable through that accessor, which a sandbox
#: refuses by name.
CREDENTIAL_ACCESSORS = frozenset({
    "resolve_secret", "store_managed_secret", "delete_managed_secret",
})


def model_holds_secret(model) -> bool:
    """True when rows of this model must not be a template's subject: a
    secret field on the row, or a credential kept in the secret store.

    Inheriting the PSK accessors from ``SecretBackedPSK`` is not enough. That
    classified WirelessLAN, IPSecProfile and RoutingKeychain as credentials
    in 0.16.9 and broke every SSID sheet and VPN report on upgrade (#219);
    none of them holds the key on the row, and the sandbox refuses the
    accessor that would read it.
    """
    if model is None:
        return False
    if any(hasattr(model, name) for name in CREDENTIAL_ACCESSORS):
        return True
    return any(is_secret_field(model, f) for f in model._meta.concrete_fields)


def is_secret_field(model_or_instance, field) -> bool:
    """True when ``field`` on this model must never leave the server in
    cleartext - not in audit snapshots, exports, or share links."""
    if type(field).__name__ == "EncryptedJSONField":
        return True
    if field.name in _SECRET_FIELD_NAMES:
        return True
    label = model_or_instance._meta.label_lower
    return field.name in _SECRET_MODEL_FIELDS.get(label, set())
