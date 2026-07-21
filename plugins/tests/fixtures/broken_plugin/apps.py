# A plugin whose apps module fails to import — the loader must record it as
# `error` and skip it, never aborting boot. (The failure lives here, not in
# __init__, so the test runner's package discovery doesn't trip over it.)
raise ImportError("boom: this fixture plugin is intentionally broken")
