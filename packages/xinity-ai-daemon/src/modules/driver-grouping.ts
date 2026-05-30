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
  return Array.from(
    Map.groupBy(installations, (i) => i.driver),
    ([driver, group]) => ({ driver, installations: group }),
  );
}
