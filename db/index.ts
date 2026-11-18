import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getChatGPTUser } from "../app/chatgpt-auth";
import { lookupIdentityWorkspace, workspaceDatabase } from "./workspace-storage";
import * as schema from "./schema";

export function getSystemD1(): D1Database {
  if (!env.DB) throw new Error("D1 DB binding is required");
  return env.DB;
}

export const getCurrentWorkspaceId = cache(async (): Promise<string | null> => {
  const user = await getChatGPTUser();
  return user ? lookupIdentityWorkspace(getSystemD1(), user, env.RULI_OWNER_EMAIL) : null;
});

export const getD1 = cache(async (): Promise<D1Database> => {
  const id = await getCurrentWorkspaceId();
  if (!id) redirect("/access-denied");
  return workspaceDatabase(getSystemD1(), id);
});

export async function getDb() {
  return drizzle(await getD1(), { schema });
}
