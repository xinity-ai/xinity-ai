import { defineParams } from "@sveltejs/kit/params";
import { z } from "zod";

export const params = defineParams({
  uuid: z.uuid(),
});
