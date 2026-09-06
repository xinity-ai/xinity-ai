import { afterAll } from "bun:test";
import { stopGateway } from "./gateway/gateway-test-helpers";
import { stopInfoServer } from "./infoserver/infoserver-test-helpers";

/**
 * The gateway and info server are shared across test files, so no single file's
 * `afterAll` owns them: whichever runs last would decide whether they survive
 * the run. A preload hook is scoped to the whole run, so this always happens.
 */
afterAll(async () => {
  await stopGateway();
  await stopInfoServer();
});
