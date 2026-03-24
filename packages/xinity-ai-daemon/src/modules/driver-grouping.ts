/**
 * Groups installations by driver so each driver can be handled by its own sync flow.
 * This keeps driver-specific logic isolated and makes future drivers easy to add.
 *
 * Extracted to its own module so unit tests can import it without pulling in
 * side-effectful dependencies (DB, env, logger).
 */
export function groupInstallationsByDriver<T extends { driver: string }>(
  installations: T[]
): Array<{ driver: string; installations: T[] }> {
  const grouped = new Map<string, T[]>();
  for (const installation of installations) {
    const bucket = grouped.get(installation.driver) ?? [];
    bucket.push(installation);
    grouped.set(installation.driver, bucket);
  }
  return Array.from(grouped, ([driver, group]) => ({
    driver,
    installations: group,
  }));
}
