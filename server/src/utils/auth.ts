import { sign, verify } from "hono/jwt";
import { config } from "dotenv";

config({ path: ".env.local" });

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET env var is required");
}

const TOKEN_EXPIRY_SECONDS = 60 * 60 * 24 * 7;

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

export type JwtPayload = {
  userId: string;
  exp: number;
};

export async function signToken(userId: string): Promise<string> {
  const payload: JwtPayload = {
    userId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS,
  };
  return sign(payload, JWT_SECRET as string, "HS256");
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  return (await verify(token, JWT_SECRET as string, "HS256")) as JwtPayload;
}
