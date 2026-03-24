/**
 * Internal-only dev procedures.
 */
import { sql } from "common-db";
import { os } from "@orpc/server";
import z from "zod";
import { rootOs, withAuth } from "../root";
import { getDB } from "$lib/server/db";



const tags = [".internal"];

/** Returns top query statistics from `pg_stat_statements`. */
const queryQueryStatistics = rootOs
  .use(withAuth)
  .route({
    method: "GET", path: "/queryStatistics", tags, summary: "Get query statistics",
    description: "Endpoint to examine what queries ran, how often, what their mean and total times were, and from which to derive what indices we need next",
  })
  .errors({ NOT_ACCEPTABLE: { message: "Only available in development mode" } })
  .handler(async ({ errors }) => {
    if (process.env.NODE_ENV === "production") {
      throw errors.NOT_ACCEPTABLE();
    }
    const query = sql`SELECT
        queryid,
        calls,
        total_exec_time,
        mean_exec_time,
        rows,
        query
      FROM pg_stat_statements
      ORDER BY total_exec_time DESC
      LIMIT 20;
    `;
    const rows = await getDB().execute<Record<"queryid" | "calls", string>>(query);
    return {
      rows: Array.from(rows),
    }
  });

export const devRouter = rootOs.prefix("/dev").router({
  queryQueryStatistics,
})
