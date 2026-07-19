# Lightweight package: surfaces RQ queue/worker state to the SPA.
# No Django models — Redis (via django_rq) is the only store — so this is
# intentionally NOT in INSTALLED_APPS; only its api_urls is included.
