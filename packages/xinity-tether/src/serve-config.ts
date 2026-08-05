import type { z } from "zod";
import type { tetherEnvSchema } from "./env-schema";

type TetherEnv = z.infer<typeof tetherEnvSchema>;
type ListenTarget = Pick<TetherEnv, "UNIX_SOCKET" | "PORT" | "HOST" | "IDLE_TIMEOUT">;

/**
 * Bun closes any connection that goes idle for longer than `idleTimeout`, SSE
 * streams included, and defaults to 10 seconds when the option is absent. The
 * tether holds daemon connections open for the life of the node, so the option
 * has to be set explicitly. Unix sockets have no idle timeout to configure.
 */
export function buildListenTarget(env: ListenTarget) {
  return env.UNIX_SOCKET
    ? { unix: env.UNIX_SOCKET, idleTimeout: undefined }
    : { port: env.PORT, hostname: env.HOST, idleTimeout: env.IDLE_TIMEOUT };
}
