"""Danbyte example plugin — the reference implementation + test bed.

A standalone, importable package that demonstrates every plugin surface. It is
NOT loaded in production unless an operator adds ``danbyte_example_plugin`` to
the ``PLUGINS`` setting; the test environment loads it automatically so the
whole framework is exercised end to end (see ``danbyte/settings.py``).
"""
