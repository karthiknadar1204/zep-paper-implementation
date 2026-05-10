import OpenAI from "openai";
import { config } from "dotenv";

config({ path: ".env.local" });

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
