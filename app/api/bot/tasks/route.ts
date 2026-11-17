import { handleIncomingBotRequest } from "../_handler";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleIncomingBotRequest(request);
}
