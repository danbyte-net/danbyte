"""Every serializer ``validate()`` must call ``super().validate()`` (#106).

The base class is where cross-cutting validation lives, and DRF's
``validate`` chain only works if every override passes attrs through. 27
serializers didn't - so anything added to the base was silently skipped for
exactly those models. (That is how the #104 slug fix managed to work in
tests and do nothing for Locations.)

This inspects source rather than behavior: a behavioral probe can't tell a
skipped base call from a base call with nothing to do.
"""
from __future__ import annotations

import importlib
import inspect

from django.test import SimpleTestCase
from rest_framework import serializers as drf_serializers

MODULES = [
    "api.serializers",
    "core.serializers",
    "auth_api.serializers",
    "monitoring.serializers",
    "customization.serializers",
    "integrations.serializers",
    "audit.api",
    "compliance.serializers",
]


class ValidateCallsSuperTests(SimpleTestCase):
    def test_every_validate_override_calls_super(self):
        offenders = []
        for dotted in MODULES:
            try:
                module = importlib.import_module(dotted)
            except ModuleNotFoundError:
                continue
            for name, cls in vars(module).items():
                if not (
                    inspect.isclass(cls)
                    and issubclass(cls, drf_serializers.BaseSerializer)
                    and cls.__module__ == dotted
                ):
                    continue
                fn = cls.__dict__.get("validate")
                if fn is None:
                    continue
                src = inspect.getsource(fn)
                if "super().validate(" not in src:
                    offenders.append(f"{dotted}.{name}")
        self.assertEqual(
            offenders,
            [],
            "validate() overrides that skip super().validate() - base-class "
            "validation is silently dropped for these: " + ", ".join(offenders),
        )
