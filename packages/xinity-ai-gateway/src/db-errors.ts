import { driverErrorCode } from "common-db";

/** Postgres refused the rows themselves (SQLSTATE class 22 or 23), so the same write without them can succeed. */
export function isRowRejection(err: unknown): boolean {
  return /^2[23]/.test(driverErrorCode(err) ?? "");
}
