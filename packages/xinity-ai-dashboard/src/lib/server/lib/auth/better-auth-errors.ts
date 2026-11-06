import { APIError } from "better-auth";

export type BetterAuthErrorBody = {
  code: string | undefined;
  message: string | undefined;
}

export function betterAuthErrorBody(err: unknown): BetterAuthErrorBody | null {
  if (!(err instanceof APIError)) return null;
  return {
    code: typeof err.body?.code === "string" ? err.body.code : undefined,
    message: typeof err.body?.message === "string" ? err.body.message : undefined,
  };
}

export function betterAuthErrorMessage(err: unknown): string | null {
  return betterAuthErrorBody(err)?.message ?? (err instanceof Error ? err.message : null);
}
