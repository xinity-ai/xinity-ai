import { getOllamaClient } from "../../modules/model-installation/ollama";
import { privateProcedure } from "../orpc.root";

const listActiveModels = privateProcedure
  .route({
    method: "GET",
    tags: ["Module"],
    description: "lists locally available models",
  })
  .handler(async () => {
    return getOllamaClient().list();
  });


export const modelRouter = {
  listActiveModels,
};
