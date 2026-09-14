import { RedisClient } from "bun";
import { config } from "./config";

export const redis = new RedisClient(config.cache.url);
