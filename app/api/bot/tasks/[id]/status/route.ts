import { handleIncomingBotRequest } from "../../../_handler";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleIncomingBotRequest(request);
}
