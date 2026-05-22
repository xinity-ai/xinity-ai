import { os } from "@orpc/server";
import z from "zod";
import { modelRouter } from "./routers/model.router";

const healthCheck = os
  .route({
    method: "GET",
    tags: ["Util"],
    description: "Endpoint to allow checks into the health of the service",
  })
  .output(z.object({ ready: z.boolean() }))
  .handler(() => ({ ready: true }));

export const router = {
  healthCheck,
  model: modelRouter,
};
export type AppRouter = typeof router;
