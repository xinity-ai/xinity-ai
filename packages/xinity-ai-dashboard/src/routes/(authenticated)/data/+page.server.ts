import { call } from '@orpc/server';
import type { PageServerLoad } from './$types';
import { applicationRouter } from '$lib/server/orpc/procedures/application.procedure';
import { getDB } from '$lib/server/db';
import { apiCallT, sql } from 'common-db';
import { auth } from '$lib/server/auth-server';

export const load: PageServerLoad = async ({ locals }) => {
  const session = await auth.api.getSession({ headers: locals.request.headers });
  if (!session?.session?.activeOrganizationId) {
    return { applications: [], uncategorizedCount: 0 };
  }

  const [applications, uncategorizedCountRows] = await Promise.all([
    call(applicationRouter.list, {}, { context: locals }),
    getDB()
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(apiCallT)
      .where(sql`
        ${apiCallT.organizationId} = ${session.session.activeOrganizationId}
      AND
        ${apiCallT.applicationId} IS NULL
      `),
  ]);

  return {
    applications,
    uncategorizedCount: uncategorizedCountRows[0]?.count ?? 0,
  };
};
