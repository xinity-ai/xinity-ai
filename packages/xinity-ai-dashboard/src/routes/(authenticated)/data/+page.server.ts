import { call } from '@orpc/server';
import type { PageServerLoad } from './$types';
import { applicationRouter } from '$lib/server/orpc/procedures/application.procedure';
import { getDB } from '$lib/server/db';
import { apiCallT, sql, and, eq, isNull } from 'common-db';
import { auth } from '$lib/server/auth-server';

export const load: PageServerLoad = async ({ locals }) => {
  const session = await auth.api.getSession(locals.request);
  if (!session?.session?.activeOrganizationId) {
    return { applications: [], uncategorizedCount: 0 };
  }

  const [applications, uncategorizedCountRows] = await Promise.all([
    call(applicationRouter.list, {}, { context: locals }),
    getDB()
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(apiCallT)
      .where(and(
        eq(apiCallT.organizationId, session.session.activeOrganizationId),
        isNull(apiCallT.applicationId),
      )),
  ]);

  return {
    applications,
    uncategorizedCount: uncategorizedCountRows[0]?.count ?? 0,
  };
};
