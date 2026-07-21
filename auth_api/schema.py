"""drf-spectacular schema extensions for auth_api.

Teaches the OpenAPI generator about Danbyte's custom token auth so it shows up
as an "Authorize" option in the interactive docs. Imported from
``AuthApiConfig.ready()`` so it registers before any schema is generated.
"""
from __future__ import annotations

from drf_spectacular.extensions import OpenApiAuthenticationExtension


class ApiTokenAuthScheme(OpenApiAuthenticationExtension):
    """Documents ``ApiTokenAuthentication`` (``Authorization: Token <key>``)."""

    target_class = "auth_api.token_auth.ApiTokenAuthentication"
    name = "apiToken"

    def get_security_definition(self, auto_schema):
        return {
            "type": "apiKey",
            "in": "header",
            "name": "Authorization",
            "description": (
                "Scoped API token. Send as `Authorization: Token <key>`. "
                "Create tokens under Settings → Preferences → API tokens."
            ),
        }
