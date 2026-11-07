---
icon: lucide/git-branch
---

# Deploy pipelines

A **deploy pipeline** runs several [automation targets](iac-runner.md) one
after the other for the same devices (or intended VMs). A typical one plans
with a [Danbyte script](scripts.md), applies the plan with a webhook runner
and then pushes the config with another:

1. **Plan VNets** - a script that reads the cables and writes `vnet-plan.json`.
2. **Apply VNets** - a webhook runner that downloads the plan and creates
   what is missing, then reports back.
3. **Push config** - the runner that pushes the config bundle.

Each step starts only when the one before has a final status. A failed step
stops the rest, unless it is set to go on.

Pipelines live under **Integrations → Pipelines** (`/pipelines`). Managing
them needs the `deploypipeline` grants; seeing and acting on runs needs
`deploypipelinerun` (`view` to see them, `change` to cancel or re-run).

## The pipeline

| Field | Means |
|---|---|
| Name | Unique in the tenant. |
| Applies to | `device` or `virtualmachine`. Every step's target must take that type. |
| Description | Free text. |
| Run on change | Start the pipeline when a matching object is saved, as the change's author - the same hook as a target's **Auto-deploy on change**. |
| Enabled | A disabled pipeline cannot be started, and a run in flight stops at its next step. |
| Default for roles | Device roles for which the Deploy dialog preselects this pipeline. |
| Steps | One or more automation targets, in order (at most 20). |

Each step has:

| Field | Default | Means |
|---|---|---|
| Target | - | An automation target of the same tenant. |
| Stop the pipeline if this step fails | on | Off: the next step still starts. The run still ends `failed`. |
| Wait for a reported result | off | Webhook targets only. The step waits for the runner's [signed result](iac-runner.md#reporting-the-outcome-from-a-webhook-runner) instead of counting as done once launched. |
| Timeout, minutes | 30 | How long a waiting step waits for its result before it fails. |

When a step counts as done:

- a **script** step when its script run ends (`succeeded` on exit 0);
- a **webhook** or **AWX** step once it is launched, or, with **Wait for a
  reported result**, when the runner posts its result;
- any step that fails to launch fails at once.

Targets are kept from deletion while a pipeline step uses them. Edit the
pipeline first.

The editor has the steps as cards: drag one by its handle to reorder. Beside
them, **Flow** shows the order and **As code** the same pipeline as YAML, to
copy or download.

## Deploying

The device's **Deploy** (Config tab), the devices list bulk bar and an
intended VM's **Provision** open the same dialog. **Run with** lists the
enabled pipelines for that object type and **Single target** for a deploy
without a pipeline. The pipeline whose roles include the device's role is
preselected, and its steps are listed. **Dry run** sends `"dry_run": true` to
every step.

Over the API:

```http
POST /api/devices/<id>/deploy/                {"pipeline_id": "<id>", "dry_run": false}
POST /api/virtual-machines/<id>/provision/    {"pipeline_id": "<id>"}
POST /api/deploy-pipelines/<id>/deploy/       {"device_ids": ["<id>", "…"], "dry_run": true}
```

`target_id` still works on the first two for a single target. A pipeline
answer carries `"kind": "pipeline"` and the run; a target answer
`"kind": "target"` and the deploy run. The device ids are checked against
your own scope, as for a target deploy; provisioning needs the `provision`
grant on each VM and is written to the VM's change log.

## What each step receives

A step is dispatched like a single target deploy - the same payload, the
`run_id` of its own deploy run, then the target's extra vars - plus:

```json
{
  "pipeline_run_id": "<run id>",
  "pipeline": "Router",
  "step": 2,
  "dry_run": false,
  "steps": [
    {"step": 1, "target": "Plan VNets", "status": "succeeded",
     "script_run_id": "<id>",
     "outputs": [{"name": "vnet-plan.json",
                  "url": "/api/scripts/runs/<id>/outputs/<id>/download/"}]}
  ]
}
```

`step` is 1-based. `steps` lists the earlier steps with their status and,
for a script step, the script run and the files it wrote. The output URLs
are the script run download route; a runner fetches them with an API token
that may see that script's runs. These keys are added after the target's
extra vars, so a target cannot override `dry_run`.

A script step gets the same keys in its parameters, next to `device_ids`,
`event` and `object_type`.

## Runs

Each run snapshots the steps when it starts, so editing the pipeline never
changes a run in flight. A run is `queued`, `running`, `succeeded`, `failed`
or `cancelled`. A step shows `pending` until it starts, then `running`,
`succeeded` or `failed`; a step after a stopping failure shows `skipped`, and
after a cancel `cancelled`. Each started step is a
[deploy run](iac-runner.md#deploy-runs-retries-and-remediate) with
`pipeline_run` and `pipeline_step` set; it is retried by re-running the
pipeline, not on its own.

The **Pipelines** page lists the pipelines as cards and every run below,
filterable by status and device. A failed run shows the failing step and
the first line of its error.

### The run page

`/pipelines/runs/<id>` shows the steps as a row of nodes with their kind,
status and time. Click one to see its log below: the script run's log for a
script step, or the lines a webhook runner posted through the
[result callback](iac-runner.md#reporting-the-outcome-from-a-webhook-runner).
A script step's files download from there. **What the next step receives**
shows the payload the next step gets (for a finished run, the last step's).

- **Cancel run** stops a queued or running run: no further step starts, a
  running script run is cancelled, and a step waiting for its result is
  marked failed.
- **Re-run** starts the pipeline again for the same objects and dry-run
  setting, as you, linked to the run it repeats.

### Checks on every step

Before each step the run checks again that the tenant is active, the
pipeline still exists and is enabled, the person who started it is still
active and may still see the objects, and that the step's target belongs to
the tenant. Any of these failing ends the run with the reason. A script step
also re-checks that this person may start the script, as for a single
deploy.

### Timeouts

A waiting step stores its deadline. The `danbyte-scripts` timer runs
`manage.py sweep_deploy_pipelines` every minute, which fails each step past
its deadline ("No result was reported within N minutes.") and moves its run
on. A result posted later answers `409`.

## As code

The same pipeline over the API, so it can live in git:

```yaml
name: Router
object_types: [device]
auto_on_change: false
steps:
  - target: Plan VNets
  - target: Apply VNets
    wait_for_result: true
  - target: Push config
    wait_for_result: true
```

- `GET /api/deploy-pipelines/<id>/export/` returns it as JSON: `name`,
  `description`, `object_types`, `auto_on_change`, `enabled`, `roles` (by
  name) and `steps` (`target` by name, `stop_on_failure`, `wait_for_result`,
  `timeout_minutes`).
- `POST /api/deploy-pipelines/import/` takes that JSON and creates the
  pipeline, or updates the one of the same name (which needs `change` on
  it). Targets and roles are looked up by name in the active tenant only.

The API speaks JSON; the YAML is written and read by the browser. **Import
YAML** on the Pipelines page takes this YAML subset (or JSON) from a paste
or a file.

`/api/deploy-pipelines/` is ordinary CRUD with the steps nested and
writable: send the whole `steps` list to reorder, add or remove steps.
`/api/deploy-pipeline-runs/` lists runs (`?status=`, `?pipeline=`,
`?device=`, `?object_type=`); the detail adds each step's log and outputs
and `next_payload`; `POST …/<id>/cancel/` and `POST …/<id>/rerun/` act on
one.
