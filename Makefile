SHELL          := /bin/bash
PROJECT_DIR    := $(CURDIR)
SYSTEMD_DIR    := $(HOME)/.config/systemd/user
# Dedicated account the production services run under (rootless user-level
# systemd, rooted at ~/danbyte). Its home lives under /opt so the app lands at
# /opt/danbyte/danbyte. Override: `make service-user SERVICE_HOME=/var/lib/danbyte`.
SERVICE_USER   ?= danbyte
SERVICE_HOME   ?= /opt/danbyte
# Where the app writes danbyte.log + gunicorn logs (settings.LOGGING reads
# DANBYTE_LOG_DIR from .env; systemd still mirrors process output to journald).
LOG_DIR        ?= /var/log/danbyte
# Dev-only units. `danbyte-infra` runs Postgres + Redis in docker compose for a
# workstation; a production install provisions them natively (scripts/install.sh
# creates the role/database with psql), so these must NEVER be linked there -
# doing so left an idle, empty Postgres container on hosts that already had one.
DEV_SERVICES   := danbyte-mockups danbyte-infra danbyte-backend
# Units both dev and production run.
SHARED_SERVICES := danbyte-workers danbyte-fastlane danbyte-docs
SERVICES       := $(DEV_SERVICES) $(SHARED_SERVICES)
# Timer-driven oneshots (monitoring beat). Each has a .service + a .timer; the
# timer is what gets enabled. Not part of `up`/`down` (they're not long-running).
TIMERS         := danbyte-dispatch danbyte-materialise danbyte-prune danbyte-utilization danbyte-alert-maintenance danbyte-discover danbyte-cleanup danbyte-drift-dispatch danbyte-auto-upgrade danbyte-drive-outposts danbyte-digest danbyte-hardware danbyte-certificate-expiry danbyte-acme-renew danbyte-document-linkcheck danbyte-task-reminders danbyte-external-sync danbyte-zabbix-sync danbyte-search-reindex danbyte-backups danbyte-scripts danbyte-rollups
PY             := $(PROJECT_DIR)/.venv/bin/python

.PHONY: help install-services uninstall-services reload admin-link install-tls-unit uninstall-tls-unit \
        up down restart status logs logs-file \
        mockups-up mockups-down mockups-restart mockups-logs \
        docs-up docs-down docs-restart docs-logs docs-build schema \
        infra-up infra-down infra-restart infra-logs \
        backend-up backend-down backend-restart backend-logs \
        workers-up workers-down workers-restart workers-logs \
        fastlane-up fastlane-down fastlane-restart fastlane-logs \
        migrate makemigrations superuser bootstrap seed-demo seed-fabric shell test check \
        collectstatic install-prod-services prod-up prod-down prod-restart prod-logs \
        proxy-cert proxy-install proxy-reload proxy-uninstall \
        linger service-user

help:
	@echo "Danbyte dev shortcuts"
	@echo ""
	@echo "  Setup"
	@echo "    make install-services    Symlink unit files into $(SYSTEMD_DIR)"
	@echo "    make uninstall-services  Remove the symlinks"
	@echo "    make reload              systemctl --user daemon-reload"
	@echo "    make admin-link          Put danbyte-admin on PATH as \`danbyte\`"
	@echo "    make install-tls-unit    Root path unit that applies a dropped site certificate"
	@echo "    make linger              Enable user-linger so services run when logged out"
	@echo "    make service-user        Create the '$(SERVICE_USER)' service user in $(SERVICE_HOME) (+linger, +your group)"
	@echo ""
	@echo "  Per service:  mockups-{up|down|restart|logs}  (same for infra, backend, workers)"
	@echo ""
	@echo "  All at once"
	@echo "    make up        Start mockups + infra + backend + workers"
	@echo "    make down      Stop them all"
	@echo "    make restart   Restart them all"
	@echo "    make status    Show systemctl status"
	@echo "    make logs      Tail journalctl for all"
	@echo ""
	@echo "  Django"
	@echo "    make migrate / makemigrations / superuser / shell / test / check"
	@echo ""
	@echo "  Reverse proxy (everything on https/443)"
	@echo "    make proxy-install     One-time: nginx + self-signed cert + config"
	@echo "    make proxy-reload      Re-apply after editing the template"
	@echo "    make proxy-uninstall   Remove the danbyte nginx site"

# ---- service installation ----------------------------------------------------

# scripts/install.sh does this for a packaged install; a source checkout has
# no installer, so the same one-liner lives here rather than being a step
# everyone rediscovers. /usr/local/bin needs root - the rest of the Makefile
# does not, so this is its own target and not folded into install-services.
admin-link:
	@sudo ln -sfn $(PROJECT_DIR)/scripts/danbyte-admin /usr/local/bin/danbyte
	@echo "  danbyte -> $(PROJECT_DIR)/scripts/danbyte-admin"

# A production host (the installer linked danbyte-web) never gets the dev
# units: the runserver, the compose infra, the mockups. Linking them is how
# an upgrade's "restart everything" ends with two processes on :8000.
DEV_ONLY_SERVICES := danbyte-mockups danbyte-infra danbyte-backend danbyte-frontend
install-services:
	@mkdir -p $(SYSTEMD_DIR)
	@for s in $(SERVICES); do \
		if [ -e $(SYSTEMD_DIR)/danbyte-web.service ] && echo " $(DEV_ONLY_SERVICES) " | grep -q " $$s " ; then \
			continue ; \
		fi ; \
		ln -sfn $(PROJECT_DIR)/services/$$s.service $(SYSTEMD_DIR)/$$s.service ; \
		echo "  linked $$s.service" ; \
	done
	@for s in $(TIMERS); do \
		ln -sfn $(PROJECT_DIR)/services/$$s.service $(SYSTEMD_DIR)/$$s.service ; \
		ln -sfn $(PROJECT_DIR)/services/$$s.timer $(SYSTEMD_DIR)/$$s.timer ; \
		echo "  linked $$s.service + $$s.timer" ; \
	done
	@systemctl --user daemon-reload
	@for s in $(TIMERS); do \
		systemctl --user enable --now $$s.timer ; \
	done
	@# A long-running service added after an install is linked above but
	@# nothing starts it - the upgrader before 0.16 restarts only the units it
	@# knew. The fast lane runs on every install, so start it here.
	@systemctl --user enable --now danbyte-fastlane 2>/dev/null || true
	@echo ""
	@echo "Installed. Try:"
	@echo "    make mockups-up        # http://localhost:8080"

uninstall-services:
	@for s in $(SERVICES); do \
		rm -f $(SYSTEMD_DIR)/$$s.service ; \
	done
	@for s in $(TIMERS); do \
		systemctl --user disable --now $$s.timer 2>/dev/null || true ; \
		rm -f $(SYSTEMD_DIR)/$$s.service $(SYSTEMD_DIR)/$$s.timer ; \
	done
	@systemctl --user daemon-reload
	@echo "Removed."

reload:
	@systemctl --user daemon-reload

linger:
	@sudo loginctl enable-linger $(USER)
	@echo "User-linger enabled. Services will keep running after logout."

# One-shot: provision the dedicated service account the prod units run under.
# Its home is $(SERVICE_HOME) so the app lives at $(SERVICE_HOME)/danbyte.
# Run WITHOUT sudo (it calls sudo per-command, like `linger`). Idempotent.
service-user:
	@id -u $(SERVICE_USER) >/dev/null 2>&1 || \
		sudo adduser --disabled-password --gecos "Danbyte service" --home $(SERVICE_HOME) $(SERVICE_USER)
	@sudo loginctl enable-linger $(SERVICE_USER)
	@sudo usermod -aG $(SERVICE_USER) $(USER)
	@sudo install -d -o $(SERVICE_USER) -g $(SERVICE_USER) -m 755 $(LOG_DIR)
	@echo "Service user '$(SERVICE_USER)' ready in $(SERVICE_HOME): linger on, '$(USER)' added to the group."
	@echo "Log dir $(LOG_DIR) created (owned by $(SERVICE_USER))."
	@echo "Next: sudo machinectl shell $(SERVICE_USER)@   then clone into ~/danbyte ($(SERVICE_HOME)/danbyte)."

# ---- per-service shortcuts ---------------------------------------------------

mockups-up:       ; systemctl --user start danbyte-mockups
mockups-down:     ; systemctl --user stop danbyte-mockups
mockups-restart:  ; systemctl --user restart danbyte-mockups
mockups-logs:     ; journalctl --user -fu danbyte-mockups

infra-up:         ; systemctl --user start danbyte-infra
infra-down:       ; systemctl --user stop danbyte-infra
infra-restart:    ; systemctl --user restart danbyte-infra
infra-logs:       ; journalctl --user -fu danbyte-infra

backend-up:       ; systemctl --user start danbyte-backend
backend-down:     ; systemctl --user stop danbyte-backend
backend-restart:  ; systemctl --user restart danbyte-backend
backend-logs:     ; journalctl --user -fu danbyte-backend

workers-up:       ; systemctl --user start danbyte-workers
workers-down:     ; systemctl --user stop danbyte-workers
workers-restart:  ; systemctl --user restart danbyte-workers
workers-logs:     ; journalctl --user -fu danbyte-workers
fastlane-up:      ; systemctl --user start danbyte-fastlane
fastlane-down:    ; systemctl --user stop danbyte-fastlane
fastlane-restart: ; systemctl --user restart danbyte-fastlane
fastlane-logs:    ; journalctl --user -fu danbyte-fastlane

docs-up:          ; systemctl --user start danbyte-docs
docs-down:        ; systemctl --user stop danbyte-docs
docs-restart:     ; systemctl --user restart danbyte-docs
docs-logs:        ; journalctl --user -fu danbyte-docs
docs-build:       ; .venv/bin/zensical build

# ---- OpenAPI schema ----------------------------------------------------------
# Generate the OpenAPI 3 schema to repo-root openapi.yaml - the committed source
# of truth the API reference site (api.danbyte.net) tracks, the same "repo is
# the source of truth" pattern as the docs. Regenerated + committed on each
# release (see .github/workflows/release.yml). Works airgapped; no live endpoint.
schema:           ; .venv/bin/python manage.py spectacular --file openapi.yaml --validate

# ---- tailwind ----------------------------------------------------------------
# Static Tailwind v3 build → design/tailwind.css, served from /static/.
# Replaces the Play CDN which JIT-compiled in the browser on every htmx
# swap and trashed INP. Run `make css` once after `npm install`; use
# `make css-watch` while editing templates.
css-install:      ; npm install
css:              ; npm run build:css
css-watch:        ; npm run watch:css

# ---- frontend (Vite + React + TanStack Start SSR) ---------------------------
# Lives in frontend/. In dev, `frontend-dev` runs the Vite dev server (:3000)
# which proxies /api to Django. In production, `frontend-build` emits the SSR
# bundle to frontend/dist and danbyte-frontend-prod serves it (vite preview);
# nginx routes /api, /ws, /static, /admin to Django and / to the frontend.
frontend-install: ; cd frontend && npm install
frontend-dev:     ; cd frontend && npm run dev
frontend-build:   ; cd frontend && npx vite build

# ---- nginx reverse proxy (single-port 443) ----------------------------------
# Puts SPA (/), API (/api), admin (/admin) and docs (/docs) behind one HTTPS
# origin. Needs sudo (system nginx + bind 443). Self-signed cert by default;
# for a browser-trusted LAN cert install `mkcert` and point CERT/KEY at it.
#
#   make proxy-install     # one-time: install nginx, cert, config, reload
#   make proxy-reload      # re-apply the config after editing the template
#   make proxy-uninstall   # remove the danbyte site + reload
#
# Override the hostname/IP the cert + server_name use:
#   make proxy-install PROXY_HOST=danbyte.lan
PROXY_HOST ?= $(shell hostname -I 2>/dev/null | awk '{print $$1}')
NGINX_TMPL := $(PROJECT_DIR)/deploy/nginx/danbyte.conf.template
NGINX_SITE := /etc/nginx/sites-available/danbyte.conf
STATIC_ROOT := $(PROJECT_DIR)/staticfiles
MEDIA_ROOT  := $(PROJECT_DIR)/media
CERT_DIR   := $(PROJECT_DIR)/deploy/nginx/certs
CERT       := /etc/ssl/danbyte/danbyte.crt
KEY        := /etc/ssl/danbyte/danbyte.key

proxy-cert:
	@mkdir -p $(CERT_DIR)
	@if [ ! -f $(CERT_DIR)/danbyte.crt ]; then \
	  echo "Generating self-signed cert for $(PROXY_HOST) ..." ; \
	  if echo "$(PROXY_HOST)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$$'; then \
	    san="IP:$(PROXY_HOST),DNS:localhost" ; \
	  else \
	    san="DNS:$(PROXY_HOST),DNS:localhost" ; \
	  fi ; \
	  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
	    -keyout $(CERT_DIR)/danbyte.key -out $(CERT_DIR)/danbyte.crt \
	    -subj "/CN=$(PROXY_HOST)" -addext "subjectAltName=$$san" ; \
	else echo "Cert already exists in $(CERT_DIR) (delete to regenerate)." ; fi

# Render $(NGINX_TMPL) → $(NGINX_SITE), choosing the HTTP/2 form from the
# INSTALLED nginx version (detected at recipe time, so nginx is already present):
# 1.25.1+ gets a bare `listen … ssl` + standalone `http2 on;`; older nginx gets
# `listen … ssl http2`, where the standalone directive is a hard error. One
# template, no deprecation warning on new nginx, no breakage on old. Shared by
# proxy-install and proxy-reload so the two can't drift.
define RENDER_NGINX
ver=$$(nginx -v 2>&1 | sed -n 's|.*/\([0-9][0-9.]*\).*|\1|p'); \
if [ -n "$$ver" ] && [ "$$(printf '1.25.1\n%s\n' "$$ver" | sort -V | head -n1)" = "1.25.1" ]; then \
  h2l=""; h2d="    http2 on;"; \
else h2l=" http2"; h2d=""; fi; \
sed -e "s|@@SERVER_NAME@@|$(PROXY_HOST)|g" \
    -e "s|@@CERT@@|$(CERT)|g" \
    -e "s|@@KEY@@|$(KEY)|g" \
    -e "s|@@STATIC_ROOT@@|$(STATIC_ROOT)|g" \
    -e "s|@@MEDIA_ROOT@@|$(MEDIA_ROOT)|g" \
    -e "s|@@MAINTENANCE_ROOT@@|$(PROJECT_DIR)/deploy|g" \
    -e "s|@@H2_LISTEN@@|$$h2l|g" \
    -e "s|@@H2_DIRECTIVE@@|$$h2d|g" \
    $(NGINX_TMPL) | sudo tee $(NGINX_SITE) >/dev/null
endef

proxy-install: proxy-cert
	@command -v nginx >/dev/null || { echo "Installing nginx ..."; sudo apt-get update -qq && sudo apt-get install -y nginx; }
	@echo "Installing cert to /etc/ssl/danbyte ..."
	@sudo mkdir -p /etc/ssl/danbyte
	@sudo chmod 755 /etc/ssl/danbyte   # the certificate is public; root's umask must not hide it
	@sudo install -m 644 $(CERT_DIR)/danbyte.crt $(CERT)
	@sudo install -m 600 $(CERT_DIR)/danbyte.key $(KEY)
	@echo "Writing nginx site for host '$(PROXY_HOST)' ..."
	@$(RENDER_NGINX)
	@sudo mkdir -p /etc/nginx/sites-enabled
	@sudo ln -sfn $(NGINX_SITE) /etc/nginx/sites-enabled/danbyte.conf
	@sudo rm -f /etc/nginx/sites-enabled/default
	@sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl reload nginx
	@echo ""
	@echo "Proxy live → https://$(PROXY_HOST)/   (docs at /docs/, api at /api/)"
	@echo "Self-signed cert: your browser will warn once; accept it for the LAN."
	@echo "Make sure the dev servers are up:  make docs-up backend-up  +  make frontend-dev"

# The root path unit that applies a certificate pair the app drops in
# deploy/nginx/certs/ (Settings → Updates → Site certificate). Needs sudo;
# install.sh runs it on a fresh install, an upgraded host runs it once.
install-tls-unit:
	@for u in path service; do \
		sed -e "s|@@APP@@|$(PROJECT_DIR)|g" deploy/systemd/danbyte-tls.$$u.template \
		  | sudo tee /etc/systemd/system/danbyte-tls.$$u >/dev/null ; \
	done
	@sudo systemctl daemon-reload
	@sudo systemctl enable --now danbyte-tls.path
	@# The drop folder has to be the app's: a proxy-install run as root left
	@# it root-only, and then nothing can be dropped.
	@sudo mkdir -p $(CERT_DIR)
	@sudo chown -R $$(stat -c %U:%G $(PROJECT_DIR)) $(CERT_DIR)
	@sudo chmod 750 $(CERT_DIR)
	@echo "  danbyte-tls.path watches $(CERT_DIR)/danbyte.apply"

uninstall-tls-unit:
	@sudo systemctl disable --now danbyte-tls.path 2>/dev/null || true
	@sudo rm -f /etc/systemd/system/danbyte-tls.path /etc/systemd/system/danbyte-tls.service
	@sudo systemctl daemon-reload

proxy-reload:
	@$(RENDER_NGINX)
	@sudo nginx -t && sudo systemctl reload nginx && echo "Reloaded."

proxy-uninstall:
	@sudo rm -f /etc/nginx/sites-enabled/danbyte.conf $(NGINX_SITE)
	@sudo nginx -t && sudo systemctl reload nginx
	@echo "Removed the danbyte nginx site."

# ---- bulk --------------------------------------------------------------------

up:
	@systemctl --user start $(SERVICES)

down:
	@systemctl --user stop $(SERVICES)

restart:
	@systemctl --user restart $(SERVICES)

status:
	@systemctl --user status --no-pager $(SERVICES) 2>&1 | head -80

logs:
	@journalctl --user -f $(addprefix -u ,$(SERVICES))

# Tail the on-disk application logs (production; $(LOG_DIR)). journald still has
# per-service process output via `make logs`.
logs-file:
	@tail -n 100 -f $(LOG_DIR)/*.log

# ---- Django ------------------------------------------------------------------

migrate:
	@$(PY) manage.py migrate

makemigrations:
	@$(PY) manage.py makemigrations

superuser:
	@$(PY) manage.py createsuperuser

# Idempotent first-run setup: default Organization + Tenant, built-in Status
# catalog, and (if DJANGO_SUPERUSER_* are set) an admin user. Safe to re-run.
bootstrap:
	@$(PY) manage.py bootstrap

# Opt-in demo data (run `make bootstrap` first). Idempotent.
seed-demo:
	@$(PY) manage.py seed_demo
	@$(PY) manage.py seed_demo_172

# Opt-in demo leaf/spine EVPN fabric for the routing pages. Idempotent.
seed-fabric:
	@$(PY) manage.py seed_fabric

shell:
	@$(PY) manage.py shell

test:
	@$(PY) manage.py test

coverage:
	@$(PY) -m coverage run --source='.' manage.py test
	@$(PY) -m coverage report

check:
	@$(PY) manage.py check

# Gather Django static (admin + DRF assets) into STATIC_ROOT so nginx serves
# them from disk in production (gunicorn doesn't serve static with DEBUG off).
collectstatic:
	@$(PY) manage.py collectstatic --noinput

# ---- production processes ----------------------------------------------------
# Production replaces the dev runserver/Vite-dev units with gunicorn (HTTP),
# daphne (websockets) and the built SSR frontend. Install + enable them with:
#   make install-prod-services
#   systemctl --user stop danbyte-backend danbyte-frontend   # the dev units
#   systemctl --user enable --now danbyte-web danbyte-ws danbyte-frontend-prod
# Everything a production host runs - web/ws/frontend plus the shared units.
# scripts/install.sh links ONLY these; it must not pull in DEV_SERVICES.
PROD_SERVICES := danbyte-web danbyte-ws danbyte-frontend-prod $(SHARED_SERVICES)

install-prod-services:
	@mkdir -p $(SYSTEMD_DIR)
	@for s in $(PROD_SERVICES); do \
		ln -sfn $(PROJECT_DIR)/services/$$s.service $(SYSTEMD_DIR)/$$s.service ; \
		echo "  linked $$s.service" ; \
	done
	@for s in $(TIMERS); do \
		ln -sfn $(PROJECT_DIR)/services/$$s.service $(SYSTEMD_DIR)/$$s.service ; \
		ln -sfn $(PROJECT_DIR)/services/$$s.timer $(SYSTEMD_DIR)/$$s.timer ; \
	done
	@systemctl --user daemon-reload
	@for s in $(TIMERS); do \
		systemctl --user enable --now $$s.timer >/dev/null 2>&1 || true ; \
	done
	@echo "Linked. Build the frontend + collect static, then enable:"
	@echo "    make frontend-build collectstatic"
	@echo "    systemctl --user enable --now $(PROD_SERVICES)"

prod-up:    ; systemctl --user start $(PROD_SERVICES)
prod-down:  ; systemctl --user stop $(PROD_SERVICES)
prod-restart: ; systemctl --user restart $(PROD_SERVICES)
prod-logs:  ; journalctl --user -f -u danbyte-web -u danbyte-ws -u danbyte-frontend-prod
