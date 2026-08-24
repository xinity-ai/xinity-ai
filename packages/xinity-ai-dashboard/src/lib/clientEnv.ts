import { getContext } from "svelte";

export type ClientEnv = {
  GATEWAY_URL: string;
}

export function getClientEnv(): ClientEnv {
  return getContext<ClientEnv>("clientEnv");
}
