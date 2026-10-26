import { modelRouter } from "./routers/model.router";

export const router = {
  model: modelRouter,
};
export type AppRouter = typeof router;
