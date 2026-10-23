const DATA_OR_CONSTRAINT_SQLSTATE = /^2[23][0-9A-Z]{3}$/;

/** Postgres refused the rows themselves (SQLSTATE class 22 or 23), so the same write without them can succeed. */
export function isRowRejection(err: unknown): boolean {
  for (let current = err; typeof current === "object" && current !== null; current = (current as { cause?: unknown }).cause) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string" && DATA_OR_CONSTRAINT_SQLSTATE.test(code)) {
      return true;
    }
  }
  return false;
}
