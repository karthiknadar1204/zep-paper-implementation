import { Hono } from "hono";
import { signup, login } from "../controllers/auth.controller";

export const authRouter = new Hono();

authRouter.post("/signup", signup);
authRouter.post("/login", login);
