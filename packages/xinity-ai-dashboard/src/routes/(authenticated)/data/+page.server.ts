import { call } from '@orpc/server';
import type { PageServerLoad } from './$types';
import { applicationRouter } from '$lib/server/orpc/procedures/application.procedure';
import { getDB } from '$lib/server/db';
import { apiCallT, sql, and, eq, isNull } from 'common-db';
import { auth } from '$lib/server/auth-server';

export const load: PageServerLoad = async ({ locals, request }) => {
  const session = await auth.api.getSession(locals.request);
  if (!session?.session?.activeOrganizationId) {
    return { applications: [], uncategorizedCount: 0 };
  }

  const [applications, [result]] = await Promise.all([
    call(applicationRouter.list, {}, { context: locals }),
    getDB()
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(apiCallT)
      .where(and(
        eq(apiCallT.organizationId, session.session.activeOrganizationId),
        isNull(apiCallT.applicationId),
      )),
  ]);
  const uncategorizedCount = result?.count ?? 0;

  return {
    applications: applications || [],
    uncategorizedCount,
  };
};
