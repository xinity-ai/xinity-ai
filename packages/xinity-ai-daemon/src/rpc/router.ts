import { os } from "@orpc/server";
import z from "zod";
import { groupMemberHealthSchema, interconnectPortSchema, tetherConnectionSchema } from "common-env";
import { modelRouter } from "./routers/model.router";
import { tetherConnection } from "../modules/tether-client";
import { lastInterconnectCheck } from "../modules/statekeeper";
import { groupMembersHealth } from "../modules/model-installation/vllm";

// `ready` ignores the tether on purpose: a broken tether must not make a serving node look down.
const healthCheck = os
  .route({
    method: "GET",
    tags: ["Util"],
    description: "Endpoint to allow checks into the health of the service",
  })
  .output(z.object({ ready: z.boolean(), tether: tetherConnectionSchema, interconnect: z.array(interconnectPortSchema), groupMembers: z.array(groupMemberHealthSchema) }))
  .handler(() => ({ ready: true, tether: tetherConnection(), interconnect: lastInterconnectCheck(), groupMembers: groupMembersHealth() }));

export const router = {
  healthCheck,
  model: modelRouter,
};
export type AppRouter = typeof router;
