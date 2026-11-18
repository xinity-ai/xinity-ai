# Stack Files

A [stack](README.md#deploy-over-multiple-machines-with-a-stack-recommended) is a single JSON file. `xinity stack init` and `xinity stack edit` write it through menus, and you or a coding agent can also write it directly. This page is the reference for writing it by hand.

## Location

```
~/.config/xinity/stacks/<name>.json
```

`$XDG_CONFIG_HOME/xinity/stacks/` when `XDG_CONFIG_HOME` is set. The file name without `.json` is the stack name, and the `name` field must match it.

The file holds secrets in plain text. Keep it readable by your user only (`chmod 600`), which is how the CLI writes it.

## Schema

[`stack.schema.json`](stack.schema.json) describes every field of the file and every configuration key each layer accepts, with descriptions, allowed values, defaults and which keys are required. Reference it from the file so editors and tools validate it:

```json
{
  "$schema": "https://raw.githubusercontent.com/xinity-ai/xinity-ai/main/deployment/cli/stack.schema.json"
}
```

The CLI keeps `$schema` when it saves the file. The schema is generated from the CLI's own stack definition and the components' configuration declarations by `bun run sync:config-docs`.

## Layers

Configuration is layered, and a later layer wins over an earlier one:

| Field | Holds | Applies to |
|---|---|---|
| (install defaults) | values the CLI sets for every install, such as the daemon's `STATE_DIR` | every host |
| `env` | shared non-secret keys | every component that declares the key |
| `secrets` | shared secret keys | every component that declares the key |
| `componentEnv.<component>` | the component's other keys, its secrets included | every host running the component |
| `fleets[].envOverrides` | daemon keys | the daemon on the fleet's hosts |
| `hosts[].envOverrides` | keys of any component on the host | that host only |

The shared keys (`DB_CONNECTION_URL`, `TETHER_SECRET`, `METRICS_AUTH` and the others the schema lists under `env` and `secrets`) belong in `env` or `secrets` only. Put every value at the highest layer that fits. Per-host overrides are for the exception, not the rule.

## Derived Values

Two shared URLs are filled in from the stack itself when they are left out:

- `TETHER_URL`, when exactly one host runs the tether
- `INFOSERVER_URL`, when a host runs the infoserver

The URL is `http://<host part of the address>:<PORT>`, with the component's `PORT` from `componentEnv` or its default. Set the URL yourself when the tether runs behind a load balancer, when several hosts run it, or when it is not part of the stack.

## Versions

`pinnedVersion` holds every component at one release, for example `v0.26.6`. `local:<path>` builds every component from the checkout at that absolute path instead. `stack up` refuses a stack without a pinned version.

`version` and `dbMigratedVersion` are set by the CLI. Leave them out of a new file.

## Required Values

The schema marks each key that a component needs: `Required.` for a component key, `Required by <components>.` for a shared key, and `Required when <key> is set.` for a key of an optional feature. `METRICS_AUTH` is required in every stack.

`stack up` asks for every required value that is missing before it plans anything, so an incomplete file still deploys, but the run then waits for someone to answer.

Two things currently apply to every stack, including one whose hosts only run the daemon:

- `stack up` asks for `DB_CONNECTION_URL` even though the daemon never receives it.
- When `DB_CONNECTION_URL` is set, `stack up` runs database migrations against it before it touches any host, and stops if they fail.

## Validation Rules

Besides the schema, `stack show` and `stack up` check:

- `name` is lowercase letters, digits, hyphens and underscores, starting with a letter or digit
- `pinnedVersion` is set
- no host address appears twice, and every host has at least one component
- fleet names are unique, a host belongs to at most one fleet, and every fleet host is a stack host
- every fleet with hosts has at least one host running the daemon

When `stack up` plans, it also refuses any component but the daemon on a macOS host.

## Checking a File

1. `xinity stack show <name>` loads and validates the file and prints it, with the shared secrets masked. A problem is reported with the field it concerns.
2. `xinity stack up <name> --dry-run` connects to every host, asks for missing required values, plans and stops before changing any host. Values it asks for are saved to the file.
3. `xinity stack up <name>` plans again, shows the review and applies after a confirmation. Leave this step to a person.

## Example

A control host running the gateway, dashboard, tether and infoserver, and two GPU hosts in one daemon fleet. `TETHER_URL` and `INFOSERVER_URL` are derived from the control host. Replace every `CHANGE_ME`, and generate `XINITY_SECRET_KEY` and `BETTER_AUTH_SECRET` with `openssl rand -base64 32`. `MODEL_INFO_DIR` is a directory of model files on the control host.

```json
{
  "$schema": "https://raw.githubusercontent.com/xinity-ai/xinity-ai/main/deployment/cli/stack.schema.json",
  "name": "production",
  "pinnedVersion": "v0.26.6",
  "env": {
    "S3_ENDPOINT": "https://s3.example.com",
    "S3_BUCKET": "xinity"
  },
  "secrets": {
    "DB_CONNECTION_URL": "postgresql://xinity:CHANGE_ME@db.example.com:5432/xinity",
    "TETHER_SECRET": "CHANGE_ME",
    "METRICS_AUTH": "metrics:CHANGE_ME",
    "XINITY_SECRET_KEY": "CHANGE_ME",
    "S3_ACCESS_KEY_ID": "CHANGE_ME",
    "S3_SECRET_ACCESS_KEY": "CHANGE_ME"
  },
  "componentEnv": {
    "dashboard": {
      "ORIGIN": "https://xinity.example.com",
      "GATEWAY_URL": "https://api.example.com",
      "INSTANCE_ADMIN_EMAILS": "admin@example.com",
      "BETTER_AUTH_SECRET": "CHANGE_ME"
    },
    "infoserver": {
      "MODEL_INFO_DIR": "/var/lib/xinity-infoserver/models"
    }
  },
  "hosts": [
    {
      "alias": "control",
      "address": "root@control.example.com",
      "components": ["gateway", "dashboard", "tether", "infoserver"]
    },
    {
      "address": "root@gpu-1.example.com",
      "components": ["daemon"]
    },
    {
      "address": "root@gpu-2.example.com",
      "components": ["daemon"]
    }
  ],
  "fleets": [
    {
      "name": "gpus",
      "hosts": ["root@gpu-1.example.com", "root@gpu-2.example.com"],
      "envOverrides": {
        "VLLM_DOCKER_IMAGE": "vllm/vllm-openai"
      }
    }
  ]
}
```
