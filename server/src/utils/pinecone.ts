import { Pinecone } from "@pinecone-database/pinecone";
import { config } from "dotenv";

config({ path: ".env.local" });

export const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

export const pineconeIndex = pinecone.index({ name: "zep" });
