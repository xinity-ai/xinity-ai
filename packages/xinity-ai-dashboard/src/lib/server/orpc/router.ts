import { os } from "@orpc/server";
import { apiCallRouter } from "./procedures/api-call.procedure";
import { apiKeyRouter } from "./procedures/api-key.procedure";
import { applicationRouter } from "./procedures/application.procedure";
import { authRouter } from "./procedures/account.procedure";
import { deploymentRouter } from "./procedures/deployment.procedure";
import { devRouter } from "./procedures/dev.procedure";
import { organizationRouter } from "./procedures/organization.procedure";
import { ssoRouter } from "./procedures/sso.procedure";
import { userRouter } from "./procedures/user.procedure";
import { onboardingRouter } from "./procedures/onboarding.procedure";
import { modelRouter } from "./procedures/model.procedure";
import { instanceAdminRouter } from "./procedures/instance-admin.procedure";
import { clusterRouter } from "./procedures/cluster.procedure";
import z from "zod";

const health = os.route({
    method: "GET",
    path: "/health",
  })
  .output(z.object({status: z.string()}))
  .handler(()=> ({status: "ok"}));

/**
 * Exported router object mounted by the ORPC server.
 */
export const router = {
  apiKey: apiKeyRouter,
  application: applicationRouter,
  apiCall: apiCallRouter,
  account: authRouter,
  organization: organizationRouter,
  user: userRouter,
  deployment: deploymentRouter,
  dev: devRouter,
  sso: ssoRouter,
  onboarding: onboardingRouter,
  model: modelRouter,
  instanceAdmin: instanceAdminRouter,
  cluster: clusterRouter,
  health,
};
