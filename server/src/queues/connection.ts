import IORedis from "ioredis";
import { config } from "dotenv";

config({ path: ".env.local" });

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  throw new Error("REDIS_URL env var is required");
}

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
});
