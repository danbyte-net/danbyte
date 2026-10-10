"""Container builds and CI never pull from Docker Hub.

Docker Hub throttles anonymous pulls, which failed release builds on shared
runners. Base images come from ECR Public's copy of the official images, and
BuildKit itself from mirror.gcr.io. An unqualified image name (``postgres:17``)
means Docker Hub, so every image reference must name its registry.
"""
import re
from pathlib import Path

import yaml
from django.conf import settings
from django.test import SimpleTestCase

ROOT = Path(settings.BASE_DIR)
HUB_HOSTS = {"docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"}


def dockerfiles():
    return sorted({*ROOT.glob("Dockerfile*"), *ROOT.glob("Containerfile*"),
                   *ROOT.glob("deploy/**/Dockerfile*")})


def compose_files():
    return sorted(ROOT.glob("docker-compose*.yml")) + sorted(ROOT.glob("compose*.y*ml"))


def workflow_files():
    return sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))


def hub_problem(ref: str) -> str | None:
    """Why ``ref`` pulls from Docker Hub, or None when it names another
    registry. The first path component is a registry only when it has a dot,
    a port or is ``localhost`` - Docker's own rule."""
    if "$" in ref:
        return "unresolved variable"
    first, sep, _ = ref.partition("/")
    if not sep or not ("." in first or ":" in first or first == "localhost"):
        return "unqualified, so Docker Hub"
    if first.lower() in HUB_HOSTS:
        return "Docker Hub"
    return None


def _expand(ref: str, defaults: dict) -> str:
    """``${VAR:-default}``, ``${VAR}`` and ``$VAR`` from ``defaults`` (or the
    inline default); anything unknown is left in place."""
    def sub(m):
        name, default = m.group(1) or m.group(3), m.group(2)
        return defaults.get(name, default if default is not None else m.group(0))

    return re.sub(r"\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)", sub, ref)


def dockerfile_images(path: Path):
    """``(line, image)`` for every FROM and ``COPY --from`` that pulls."""
    args: dict = {}
    stages: set = set()
    seen_from = False
    for n, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if m := re.match(r"(?i)ARG\s+(\w+)=(\S+)", line):
            if not seen_from:
                args.setdefault(m.group(1), m.group(2).strip("\"'"))
        elif m := re.match(r"(?i)FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?", line):
            seen_from = True
            image = _expand(m.group(1), args)
            if image.lower() not in stages and image != "scratch":
                yield n, image
            if m.group(2):
                stages.add(m.group(2).lower())
        elif m := re.search(r"(?i)--from=(\S+)", line):
            ref = _expand(m.group(1), args)
            if ref.lower() not in stages and not ref.isdigit():
                yield n, ref


def compose_images(path: Path):
    doc = yaml.safe_load(path.read_text()) or {}
    for name, service in (doc.get("services") or {}).items():
        if "image" in service and "build" not in service:  # a built image is a local tag
            yield name, _expand(service["image"], {})


def workflow_images(path: Path):
    """Service and job containers, ``docker://`` actions and ``image=``
    options (BuildKit's driver image)."""
    def walk(node, key=None):
        if isinstance(node, dict):
            for k, v in node.items():
                if k != "matrix":  # matrix values are names, not references
                    yield from walk(v, k)
        elif isinstance(node, list):
            for v in node:
                yield from walk(v, key)
        elif isinstance(node, str):
            if key in ("image", "container"):
                yield node
            elif key == "uses" and node.startswith("docker://"):
                yield node.removeprefix("docker://")
            else:
                yield from re.findall(r"(?<![\w-])image=([^\s,\"']+)", node)

    doc = yaml.load(path.read_text(), Loader=yaml.BaseLoader) or {}
    yield from walk(doc.get("jobs") or {})


class ContainerImageSourceTests(SimpleTestCase):
    def test_files_are_found(self):
        self.assertTrue(dockerfiles())
        self.assertTrue(compose_files())
        self.assertTrue(workflow_files())

    def test_no_file_names_docker_hub(self):
        for path in [*dockerfiles(), *compose_files(), *workflow_files()]:
            with self.subTest(file=path.name):
                self.assertNotRegex(path.read_text(), r"(?i)\bdocker\.io\b")

    def test_dockerfile_has_no_syntax_directive(self):
        """``# syntax=`` makes BuildKit fetch its Dockerfile frontend from
        Docker Hub; the built-in parser is used instead."""
        for path in dockerfiles():
            with self.subTest(file=path.name):
                self.assertNotRegex(path.read_text(), r"(?im)^\s*#\s*syntax\s*=")

    def test_dockerfile_base_images_name_their_registry(self):
        for path in dockerfiles():
            images = list(dockerfile_images(path))
            self.assertTrue(images, path.name)
            for line, image in images:
                with self.subTest(file=path.name, line=line, image=image):
                    self.assertIsNone(hub_problem(image))

    def test_compose_images_name_their_registry(self):
        for path in compose_files():
            for service, image in compose_images(path):
                with self.subTest(file=path.name, service=service, image=image):
                    self.assertIsNone(hub_problem(image))

    def test_workflow_images_name_their_registry(self):
        found = 0
        for path in workflow_files():
            for image in workflow_images(path):
                found += 1
                with self.subTest(file=path.name, image=image):
                    self.assertIsNone(hub_problem(image))
        self.assertTrue(found)


class HubProblemTests(SimpleTestCase):
    def test_docker_hub_references_are_caught(self):
        for ref in ("postgres:17", "library/postgres:17", "moby/buildkit:latest",
                    "docker.io/library/postgres:17", "index.docker.io/x/y", "${REG}/node:22"):
            with self.subTest(ref=ref):
                self.assertIsNotNone(hub_problem(ref))

    def test_other_registries_pass(self):
        for ref in ("public.ecr.aws/docker/library/postgres:17", "ghcr.io/o/danbyte-app:1",
                    "mirror.gcr.io/moby/buildkit:buildx-stable-1", "localhost/x:1",
                    "registry.local:5000/library/redis:7"):
            with self.subTest(ref=ref):
                self.assertIsNone(hub_problem(ref))

    def test_variables_resolve_to_their_defaults(self):
        self.assertEqual(
            _expand("${R:-public.ecr.aws/docker/library}/redis:7", {}),
            "public.ecr.aws/docker/library/redis:7",
        )
        self.assertEqual(_expand("${R}/node:22", {"R": "ghcr.io/m"}), "ghcr.io/m/node:22")
        self.assertEqual(_expand("$R/node:22", {"R": "ghcr.io/m"}), "ghcr.io/m/node:22")


class DwgConverterImageTests(SimpleTestCase):
    """The runtime image carries LibreDWG's dwg2dxf, built from a pinned,
    checksummed GNU release, and points DANBYTE_CAD_CONVERTER at it."""

    def stages(self) -> dict:
        out, name = {}, None
        for line in (ROOT / "Dockerfile").read_text().splitlines():
            if m := re.match(r"(?i)FROM\s+\S+\s+AS\s+(\S+)", line.strip()):
                name = m.group(1).lower()
            if name:
                out.setdefault(name, []).append(line)
        return {k: "\n".join(v) for k, v in out.items()}

    def test_build_is_pinned_and_verified(self):
        tools = self.stages()["cad-tools"]
        self.assertRegex(tools, r"ARG LIBREDWG_VERSION=\d+\.\d+")
        self.assertRegex(tools, r"ARG LIBREDWG_SHA256=[0-9a-f]{64}\b")
        self.assertIn("sha256sum -c", tools)
        self.assertIn("--disable-bindings", tools)
        # Built and shipped: dwg2dxf alone, linked statically.
        self.assertIn("--disable-shared", tools)
        self.assertIn("make -C programs dwg2dxf", tools)

    def test_runtime_gets_the_binary_and_the_setting(self):
        from api.cad_render import CONVERTERS

        runtime = self.stages()["runtime"]
        self.assertIn("COPY --from=cad-tools /out/dwg2dxf /usr/local/bin/dwg2dxf", runtime)
        self.assertIn("ENV DANBYTE_CAD_CONVERTER=/usr/local/bin/dwg2dxf", runtime)
        self.assertEqual(CONVERTERS["dwg2dxf"], "libredwg")
