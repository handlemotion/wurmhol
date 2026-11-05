import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>().get("/health", (c) => c.json({ ok: true }));

export default app;
