# xinity-infoserver

Model info service helpers. This package owns the schema for the model metadata
and provides a JSON Schema export utility plus a tiny Bun server for serving
the YAML file over HTTP.

## Model config file

The expected format is YAML and matches the `ModelSchema`. In local dev, the
file served is:

- `docker/xinity-infoserver/models.example.yaml`

The dev stack serves it at:

- `http://localhost:8090/models/v1.yaml`

## Usage

Import the schema in code:

```ts
import { ModelSchema } from "xinity-infoserver/model";
```

Export JSON Schema to stdout:

```bash
bun run schema:json
```

To save it to a file:

```bash
bun run schema:json > model-schema.json
```

Run the HTTP server locally:

```bash
MODEL_INFO_FILE=../../docker/xinity-infoserver/models.example.yaml bun run start
```

The server reads `MODEL_INFO_FILE` and serves it at `/models/v1.yaml`.
