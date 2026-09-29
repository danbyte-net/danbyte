"""``@detail_only`` is the one way a serializer getter skips work on a list.

A getter that answers 0, ``{}`` or ``[]`` on a list action without saying so
looks like real data to anything that reads the serializer generically - the
list-column catalog would offer it as a column that always reads 0. The
decorator carries a flag that catalog reads; this module keeps every such
getter behind it.
"""
from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

from django.conf import settings
from django.test import SimpleTestCase
from rest_framework import serializers

from .serializers import detail_only

SERIALIZER_MODULES = [
    "api/serializers.py",
    "routing/serializers.py",
    "monitoring/serializers.py",
    "zabbix/serializers.py",
    "backups/serializers.py",
    "planning/serializers.py",
    "scripting/serializers.py",
    "danbyte_example_plugin/serializers.py",
]


def _compares_action_to_list(fn: ast.FunctionDef) -> bool:
    """True when the body compares something named ``action`` to "list"."""
    for node in ast.walk(fn):
        if not isinstance(node, ast.Compare):
            continue
        parts = [node.left, *node.comparators]
        has_list = any(
            isinstance(p, ast.Constant) and p.value == "list" for p in parts
        )
        mentions_action = any(
            (isinstance(p, ast.Attribute) and p.attr == "action")
            or (
                isinstance(p, ast.Call)
                and any(
                    isinstance(a, ast.Constant) and a.value == "action"
                    for a in p.args
                )
            )
            for p in parts
        )
        if has_list and mentions_action:
            return True
    return False


def _decorated_detail_only(fn: ast.FunctionDef) -> bool:
    for d in fn.decorator_list:
        target = d.func if isinstance(d, ast.Call) else d
        name = getattr(target, "id", None) or getattr(target, "attr", None)
        if name == "detail_only":
            return True
    return False


class DetailOnlyConventionTests(SimpleTestCase):
    def test_no_serializer_branches_on_the_list_action_by_hand(self):
        root = Path(settings.BASE_DIR)
        offenders = []
        for rel in SERIALIZER_MODULES:
            path = root / rel
            if not path.exists():
                continue
            tree = ast.parse(path.read_text(), filename=rel)
            for cls in ast.walk(tree):
                if not isinstance(cls, ast.ClassDef):
                    continue
                for fn in cls.body:
                    if not isinstance(fn, ast.FunctionDef):
                        continue
                    if _compares_action_to_list(fn) and not _decorated_detail_only(fn):
                        offenders.append(f"{rel}:{fn.lineno} {cls.name}.{fn.name}")
        self.assertEqual(
            offenders, [],
            "branch on the list action with @detail_only(default) instead",
        )


class DetailOnlyBehaviourTests(SimpleTestCase):
    def _field(self, action):
        class S(serializers.Serializer):
            counts = serializers.SerializerMethodField()

            @detail_only({})
            def get_counts(self, obj) -> dict:
                return {"a": obj}

        view = SimpleNamespace(action=action) if action else None
        return S(context={"view": view} if view else {})

    def test_list_gets_a_fresh_default_and_detail_runs_the_getter(self):
        on_list = self._field("list")
        first = on_list.get_counts(1)
        first["x"] = 1
        self.assertEqual(on_list.get_counts(1), {})
        self.assertEqual(self._field("retrieve").get_counts(2), {"a": 2})
        self.assertEqual(self._field(None).get_counts(3), {"a": 3})

    def test_the_wrapper_is_flagged_and_keeps_its_name(self):
        from .serializers import DeviceSerializer

        fn = DeviceSerializer.get_hardware_count
        self.assertTrue(getattr(fn, "detail_only", False))
        self.assertEqual(fn.__name__, "get_hardware_count")
