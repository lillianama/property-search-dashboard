import { checkDatabaseHealth } from "../../../lib/db";

export const dynamic = "force-dynamic";

// Separate from /api/health: that route is a pure process liveness check
// for the Compose healthcheck and must always return 200 while the Next.js
// server is up. This route reports Postgres connectivity without leaking
// connection strings or driver error details.
export async function GET() {
  const health = await checkDatabaseHealth();
  return Response.json(health, { status: health.ok ? 200 : 503 });
}
