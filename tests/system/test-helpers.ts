import { createServer } from "node:net";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/** Allocates a free local TCP port by binding a server to 0 and immediately closing it. */
export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export async function readProcessOutput(proc: Bun.Subprocess): Promise<{ stdout: string; stderr: string }> {
  const stdout = proc.stdout instanceof ReadableStream ? await new Response(proc.stdout).text() : "";
  const stderr = proc.stderr instanceof ReadableStream ? await new Response(proc.stderr).text() : "";
  return { stdout, stderr };
}

/**
 * Re-reads until the rows a background writer is expected to produce show up.
 * A fixed sleep races the writer's flush interval, which a loaded CI runner loses.
 */
export async function waitForRows<T>(
  read: () => Promise<T[]>,
  options?: { atLeast?: number; timeoutMs?: number; intervalMs?: number },
): Promise<T[]> {
  const atLeast = options?.atLeast ?? 1;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const intervalMs = options?.intervalMs ?? 50;
  const startedAt = Date.now();

  let rows = await read();
  while (rows.length < atLeast && Date.now() - startedAt < timeoutMs) {
    await Bun.sleep(intervalMs);
    rows = await read();
  }
  return rows;
}

export async function waitForHttp(url: string, options?: { timeoutMs?: number; intervalMs?: number }) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const intervalMs = options?.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return res;
      }
      lastError = new Error(`Unexpected status: ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(intervalMs)
  }

  throw new Error(`Timed out waiting for ${url}. Last error: ${String(lastError)}`);
}
