/**
 * Composite multi-step workflows exposed as special `act` actions.
 *
 * Each workflow orchestrates an API call and prompts
 * the user interactively for the required inputs.
 * Workflow names match their API route so they "cover" the route in the CLI
 * (e.g. `onboarding.cli` workflow calls POST /api/onboarding/cli).
 */
import * as p from "./clack.ts";
import pc from "picocolors";
import { updateConfig } from "./config.ts";
import { promptOrExit } from "./output.ts";

const REQUEST_TIMEOUT_MS = 15_000;

async function post(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function connectionError(base: string): never {
  p.log.error(`Could not connect to ${pc.cyan(base)}. Is the dashboard running?`);
  process.exit(1);
}

/**
 * Full CLI onboarding:
 *   POST /api/onboarding/cli → create user + org + dashboard API key
 *   Save dashboard API key to config
 */
export async function runOnboardingCliWorkflow(dashboardUrl: string) {
  const base = dashboardUrl.replace(/\/$/, "");

  p.intro(`${pc.cyan("xinity onboarding")} ${pc.dim("(first-time setup)")}`);

  const name = await promptOrExit(p.text({ message: "Name" }));

  const email = await promptOrExit(p.text({
    message: "Email",
    validate: (v) => (v?.includes("@") ? undefined : "Enter a valid email"),
  }));

  const password = await promptOrExit(p.password({
    message: "Password",
    validate: (v) => (!v || v.length >= 8 ? undefined : "Must be at least 8 characters"),
  }));

  const orgName = await promptOrExit(p.text({
    message: "Organization name",
    placeholder: "My Organization",
  }));

  const spin = p.spinner();
  spin.start("Running onboarding");

  const res = await post(`${base}/api/onboarding/cli`, {
    name, email, password, orgName,
  }).catch(() => {
    spin.error("Failed");
    connectionError(base);
  });

  if (!res.ok) {
    spin.error("Onboarding failed");
    const body = await res.text();
    p.log.error(body || `Server returned ${res.status}`);
    process.exit(1);
  }

  const result = (await res.json()) as {
    dashboardApiKey: string;
    userId: string;
    orgId: string;
    orgSlug: string;
  };
  spin.stop("Onboarding complete");

  updateConfig({
    apiKey: result.dashboardApiKey,
    dashboardUrl: base,
  });

  p.log.success("Configuration saved");
  p.note(
    [
      `${pc.dim("Dashboard API key:")}  ${result.dashboardApiKey}`,
      `${pc.dim("Organization:")}       ${result.orgSlug}`,
      `${pc.dim("Dashboard:")}          ${base}`,
    ].join("\n"),
    "Summary",
  );

  p.outro("Dashboard is ready. Run " + pc.cyan("xinity act --list-routes") + " to explore.");
}

/** Registry of composite workflows keyed by their action name. */
export const workflows: Record<string, (dashboardUrl: string) => Promise<void>> = {
  "onboarding.cli": runOnboardingCliWorkflow,
};

export const workflowNames = Object.keys(workflows);
