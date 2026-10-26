import type { RequestHandler } from "./$types";
import { handleHealth } from "$lib/server/lib/instance/health";

export const GET: RequestHandler = ({ request }) => handleHealth(request);
