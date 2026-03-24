import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { applicationRouter } from '$lib/server/orpc/procedures/application.procedure';
import { call } from '@orpc/server';
import { auth } from '$lib/server/auth-server';

export const load: PageServerLoad = async ({ params, locals }) => {
  const session = await auth.api.getSession(locals.request);
  if (!session?.session?.activeOrganizationId) {
    return { application: null };
  }

  const { applicationId } = params;
  const application = await call(applicationRouter.get, { id: applicationId }, { context: locals });

  return {
    application
  };
};
