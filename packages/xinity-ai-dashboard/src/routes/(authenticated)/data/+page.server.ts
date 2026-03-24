import { call } from '@orpc/server';
import type { PageServerLoad } from './$types';
import { applicationRouter } from '$lib/server/orpc/procedures/application.procedure';
import { getDB } from '$lib/server/db';
import { apiCallT, sql, isNull } from 'common-db';
import { auth } from '$lib/server/auth-server';

export const load: PageServerLoad = async ({ locals, request }) => {
  const session = await auth.api.getSession(locals.request);
  if (!session?.session?.activeOrganizationId) {
    return { applications: [], uncategorizedCount: 0 };
  }

  const applications = await call(applicationRouter.list, {}, { context: locals });

  let uncategorizedCount = 0;
  if (session.session.activeOrganizationId) {
    const [result] = await getDB()
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(apiCallT)
      .where(
        sql`${apiCallT.organizationId} = ${session.session.activeOrganizationId} AND ${isNull(apiCallT.applicationId)}`
      );
    uncategorizedCount = result?.count ?? 0;
  }

  return {
    applications: applications || [],
    uncategorizedCount,
  };
};
