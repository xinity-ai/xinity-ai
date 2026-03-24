import { os } from "@orpc/server";
import z from "zod";

const healthCheck = os
  .route({
    method: "GET",
    tags: ["Util"],
    description: "Endpoint to allow checks into the health of the service",
  })
  .output(z.object({ ready: z.boolean() }))
  .handler(() => {
    return {
      ready: true,
    };
  });

export const serverRouter = os.router({
  healthCheck,
});
export type ServerRouter = typeof serverRouter;
