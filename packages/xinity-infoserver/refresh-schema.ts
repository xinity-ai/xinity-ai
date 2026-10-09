import { createLegacyModelJsonSchema, createModelJsonSchema } from "common-env/model-catalog";

const write = (name: string, schema: unknown) =>
  Bun.write(`${import.meta.dir}/${name}`, `${JSON.stringify(schema, null, 2)}\n`);

await write("models.v2.schema.json", createModelJsonSchema());
await write("models.schema.json", createLegacyModelJsonSchema());
