import { mock } from "bun:test";
import { MOCK_GATEWAY_CONFIG } from "../src/llm-forward/mock-env";

/**
 * Bun binds the first registration for a specifier, so a per-file mock only wins when its file
 * happens to load first. Registering here makes every suite see the same config whatever order
 * the files are discovered in, including the ones that mock nothing and read it through an import.
 *
 * Mutable on purpose: a suite that needs a different value assigns to it in a beforeEach.
 */
export const config = { ...MOCK_GATEWAY_CONFIG };

mock.module("../src/config", () => ({ config }));
