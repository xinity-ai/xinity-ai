import { call } from '@orpc/server';
import type { PageServerLoad } from './$types';
import { applicationRouter } from '$lib/server/orpc/procedures/application.procedure';
import { getDB } from '$lib/server/db';
import { apiCallT, inferenceCallT, sql } from 'common-db';
import { auth } from '$lib/server/auth-server';

export const load: PageServerLoad = async ({ locals }) => {
  const session = await auth.api.getSession({ headers: locals.request.headers });
  if (!session?.session?.activeOrganizationId) {
    return { applications: [], uncategorizedCount: 0 };
  }

  const [applications, uncategorizedCount] = await Promise.all([
    call(applicationRouter.list, {}, { context: locals }),
    countUncategorized(session.session.activeOrganizationId),
  ]);

  return { applications, uncategorizedCount };
};

async function countUncategorized(orgId: string): Promise<number> {
  const db = getDB();
  const count = sql<number>`COUNT(*)::int`;
  const [[legacy], [inference]] = await Promise.all([
    db.select({ count }).from(apiCallT).where(sql`
      ${apiCallT.organizationId} = ${orgId} AND ${apiCallT.applicationId} IS NULL
    `),
    db.select({ count }).from(inferenceCallT).where(sql`
      ${inferenceCallT.organizationId} = ${orgId} AND ${inferenceCallT.applicationId} IS NULL
    `),
  ]);
  return (legacy?.count ?? 0) + (inference?.count ?? 0);
}
