import { getContext } from "svelte";

export interface ClientEnv {
  GATEWAY_URL: string;
}

export function getClientEnv(): ClientEnv {
  return getContext<ClientEnv>("clientEnv");
}
