import { mock } from "bun:test";
import { createDynamicConfig } from "common-env";
import { gatewayConfig } from "../src/config-schema";
import { TEST_ENV } from "../src/llm-forward/mock-env";

/**
 * Bun binds the first registration for a specifier, so a per-file mock only wins when its file
 * happens to load first. Registering here makes every suite see the same config whatever order
 * the files are discovered in, including the ones that mock nothing and read it through an import.
 *
 * Resolved from the declaration, so a field added there cannot go missing here and surface as an
 * undefined deep inside an unrelated test. Mutable on purpose: a suite that needs a different
 * value assigns to it in a beforeEach.
 */
export const configStore = createDynamicConfig({ declaration: gatewayConfig, rawEnv: TEST_ENV });

export const config = configStore.value;

mock.module("../src/config", () => ({ config, configStore }));
