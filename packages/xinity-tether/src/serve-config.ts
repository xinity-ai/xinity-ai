import type { TetherConfig } from "./config-schema";

/**
 * Bun closes any connection that goes idle for longer than `idleTimeout`, SSE
 * streams included, and defaults to 10 seconds when the option is absent. The
 * tether holds daemon connections open for the life of the node, so the option
 * has to be set explicitly. Unix sockets have no idle timeout to configure.
 */
export function buildListenTarget(server: TetherConfig["server"]) {
  return server.unixSocket
    ? { unix: server.unixSocket, idleTimeout: undefined }
    : { port: server.port, hostname: server.host, idleTimeout: server.idleTimeout };
}
