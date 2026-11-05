"""The Docker install serves the docs at /docs/ (#472).

The `web` image carries the static Zensical site, built in its own Dockerfile
stage, and the Docker nginx serves it - the in-app Docs links go to /docs/.
"""
import re
from pathlib import Path

from django.conf import settings
from django.test import SimpleTestCase

ROOT = Path(settings.BASE_DIR)


def stage(dockerfile: str, name: str) -> str:
    """The body of the ``FROM ... AS name`` stage."""
    m = re.search(rf"^FROM\s+\S+\s+AS\s+{name}\s*$(.*?)(?=^FROM\s|\Z)", dockerfile, re.M | re.S)
    assert m, f"no `{name}` stage in the Dockerfile"
    return m.group(1)


class DockerDocsTests(SimpleTestCase):
    def test_dockerfile_builds_docs_into_web(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        docs = stage(dockerfile, "docs")
        self.assertIn("COPY zensical.toml", docs)
        self.assertRegex(docs, r"(?m)^RUN\s+zensical\s+build")
        web = stage(dockerfile, "web")
        self.assertRegex(web, r"(?m)^COPY\s+--from=docs\s+/src/site/\s+/usr/share/nginx/docs/")

    def test_docker_nginx_serves_docs(self):
        conf = (ROOT / "deploy" / "docker" / "nginx.conf").read_text()
        block = re.search(r"location /docs/ \{(.*?)\}", conf, re.S)
        self.assertIsNotNone(block, "no `location /docs/` in deploy/docker/nginx.conf")
        body = block.group(1)
        self.assertIn("alias /usr/share/nginx/docs/;", body)
        self.assertIn("index index.html;", body)
        # Trailing-slash redirects must keep /docs and the published port (#123).
        self.assertIn("absolute_redirect off;", body)
        self.assertIn("location = /docs { absolute_redirect off; return 301 /docs/; }", conf)
