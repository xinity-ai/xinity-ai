import { createServer } from "net";

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
