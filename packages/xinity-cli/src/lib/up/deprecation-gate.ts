import { bold, cyan, dim } from "picocolors";
import { isRemovedBy, type DeprecationReport } from "common-env";
import { confirm, isCancel, log } from "../core/clack.ts";
import type { Component } from "../core/component-meta.ts";
import type { Host } from "../core/host.ts";
import { flattenBundle } from "../config/env-prompt.ts";
import { fetchHealthDetail, readDeprecations, serviceBaseUrl } from "../doctor/doctor-probes.ts";
import type { ComponentAction } from "./up-plan.ts";

export type GateTarget = { host: Host; action: ComponentAction; where?: string };

type Inspection =
  | { kind: "reported"; reports: DeprecationReport[] }
  | { kind: "unchecked"; reason: string };

function isVersionChange(action: ComponentAction): boolean {
  return action.kind === "update" && action.serviceRunning && action.installedVersion !== action.toVersion;
}

async function inspect({ host, action }: GateTarget): Promise<Inspection> {
  const values = flattenBundle(action.env);
  const baseUrl = serviceBaseUrl(action.component, values);
  if (!baseUrl) {
    return { kind: "unchecked", reason: "it listens on a unix socket" };
  }
  if (!values.METRICS_AUTH) {
    return { kind: "unchecked", reason: "it has no METRICS_AUTH to read its details with" };
  }
  const detail = await fetchHealthDetail(host, baseUrl, values.METRICS_AUTH);
  if (detail.kind === "unreachable") {
    return { kind: "unchecked", reason: detail.check.detail ?? detail.check.message };
  }
  const reports = readDeprecations(detail.body);
  return reports
    ? { kind: "reported", reports: reports.filter((report) => isRemovedBy(report.removedIn, action.toVersion)) }
    : { kind: "unchecked", reason: "it predates deprecation reports" };
}

function label(component: Component, where: string | undefined): string {
  return where ? `${cyan(component)} on ${where}` : cyan(component);
}

export async function deprecationGate(targets: GateTarget[], opts: { dryRun: boolean }): Promise<boolean> {
  const updates = targets.filter((t) => t.action.component !== "daemon" && isVersionChange(t.action));
  if (updates.length === 0) {
    return true;
  }

  const inspections = await Promise.all(updates.map(async (target) => ({ target, inspection: await inspect(target) })));
  // Shared database state is reported by every service with a connection, so one entry per id.
  const removed = new Map<string, DeprecationReport>();
  const unchecked: string[] = [];
  for (const { target, inspection } of inspections) {
    if (inspection.kind === "unchecked") {
      unchecked.push(`${label(target.action.component, target.where)}: ${inspection.reason}`);
      continue;
    }
    for (const report of inspection.reports) {
      removed.set(report.id, report);
    }
  }
  if (removed.size === 0 && unchecked.length === 0) {
    return true;
  }

  log.step(bold("Deprecations"));
  for (const report of removed.values()) {
    log.warn(`${cyan(report.id)} is removed in ${report.removedIn}. ${report.message}`);
  }
  for (const line of unchecked) {
    log.info(dim(`Not checked, ${line}`));
  }
  if (removed.size === 0 || opts.dryRun) {
    return true;
  }

  const proceed = await confirm({
    message: "This update removes what is listed above while it is still in use. Update anyway?",
    initialValue: false,
  });
  return !isCancel(proceed) && proceed;
}
