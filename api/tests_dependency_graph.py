"""The dependency graph walks (#450), pure: no database. Chains, diamonds
with and without a redundancy group, reduced redundancy that does not
propagate, a cycle that cannot hang a walk, and the timing at 5k devices /
8k edges."""
from __future__ import annotations

import random
import time

from django.test import SimpleTestCase

from api.dependencies import (
    OUTAGE,
    REDUCED,
    ancestors,
    build_graph,
    descendants,
    find_path,
    outage_levels,
    walk,
)


def g(*edges):
    """``("core", "dist")`` or ``("core", "dist", "group")``: dist depends on core."""
    return build_graph((e[0], e[1], e[2] if len(e) > 2 else "") for e in edges)


class WalkTests(SimpleTestCase):
    def test_a_chain_goes_down_with_depth_and_via(self):
        w = walk(g(("core", "dist"), ("dist", "acc")), ["core"])
        self.assertEqual(w.levels, {"dist": OUTAGE, "acc": OUTAGE})
        self.assertEqual(w.depth, {"dist": 1, "acc": 2})
        self.assertEqual(w.via["acc"], ["dist"])

    def test_two_ungrouped_uplinks_each_take_it_down(self):
        graph = g(("a", "x"), ("b", "x"))
        self.assertEqual(outage_levels(graph, ["a"]), {"x": OUTAGE})

    def test_a_group_needs_every_member_down(self):
        graph = g(("a", "x", "up"), ("b", "x", "up"), ("x", "y"))
        self.assertEqual(outage_levels(graph, ["a"]), {"x": REDUCED})
        self.assertEqual(outage_levels(graph, ["a", "b"]), {"x": OUTAGE, "y": OUTAGE})

    def test_reduced_does_not_propagate(self):
        graph = g(("a", "x", "up"), ("b", "x", "up"), ("x", "y"), ("y", "z"))
        self.assertEqual(outage_levels(graph, ["b"]), {"x": REDUCED})

    def test_a_diamond_meets_downstream(self):
        graph = g(("core", "l"), ("core", "r"), ("l", "acc", "pair"), ("r", "acc", "pair"))
        w = walk(graph, ["core"])
        self.assertEqual(w.levels, {"l": OUTAGE, "r": OUTAGE, "acc": OUTAGE})
        self.assertEqual(w.depth["acc"], 2)
        self.assertEqual(w.via["acc"], ["l", "r"])
        self.assertEqual(outage_levels(graph, ["l"]), {"acc": REDUCED})

    def test_one_failed_member_inside_a_group_down_through_another_path(self):
        # x is backed by a and b; b depends on a, so a takes both.
        graph = g(("a", "b"), ("a", "x", "up"), ("b", "x", "up"))
        self.assertEqual(outage_levels(graph, ["a"]), {"b": OUTAGE, "x": OUTAGE})

    def test_a_cycle_does_not_hang_the_walks(self):
        graph = g(("a", "b"), ("b", "c"), ("c", "a"))
        self.assertEqual(outage_levels(graph, ["a"]), {"b": OUTAGE, "c": OUTAGE})
        self.assertEqual(set(ancestors(graph, ["a"])), {"b", "c"})
        self.assertEqual(set(descendants(graph, ["a"])), {"b", "c"})

    def test_ancestors_and_descendants_with_depth(self):
        graph = g(("core", "dist"), ("dist", "acc"), ("dist", "acc2"))
        self.assertEqual(ancestors(graph, ["acc"]), {"dist": 1, "core": 2})
        self.assertEqual(ancestors(graph, ["acc"], max_depth=1), {"dist": 1})
        self.assertEqual(descendants(graph, ["core"]),
                         {"dist": 1, "acc": 2, "acc2": 2})

    def test_find_path(self):
        down = {"a": {"b"}, "b": {"c"}}
        self.assertEqual(find_path(down, "a", "c"), ["a", "b", "c"])
        self.assertIsNone(find_path(down, "c", "a"))

    def test_an_empty_graph_is_false(self):
        self.assertFalse(build_graph([]))
        self.assertEqual(outage_levels(build_graph([]), ["a"]), {})


class VolumeTests(SimpleTestCase):
    def test_5k_devices_8k_edges_under_200ms(self):
        rng = random.Random(450)
        n = 5000
        edges = set()
        # A tree from device 0 down, plus 3k extra uplinks that only point
        # to a lower number, so the graph stays acyclic.
        for i in range(1, n):
            edges.add((str(rng.randrange(0, i)), str(i), ""))
        while len(edges) < 8000:
            i = rng.randrange(1, n)
            edges.add((str(rng.randrange(0, i)), str(i), f"g{i % 7}"))
        graph = build_graph(edges)
        start = time.perf_counter()
        levels = outage_levels(graph, ["0"])
        ancestors(graph, [str(n - 1)])
        descendants(graph, ["0"])
        elapsed = time.perf_counter() - start
        self.assertGreater(len(levels), 100)
        self.assertLess(elapsed, 0.2, f"{elapsed:.3f}s")
