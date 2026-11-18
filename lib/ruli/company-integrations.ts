const secretNames = ["XAI_API_KEY", "OPENAI_API_KEY", "GROK_BOT_WEBHOOK_URL", "GROK_BOT_WEBHOOK_KEY", "GROK_BOT_WEBHOOK_HEADER", "RULI_BOT_API_TOKEN"] as const;
type SecretName = typeof secretNames[number];
export type CompanyIntegrations = Partial<Record<SecretName | "RULI_BASE_URL", string>>;
type IntegrationEnv = CompanyIntegrations & { RULI_COMPANY_INTEGRATIONS?: string };

function settings(values: unknown, baseUrl?: string): CompanyIntegrations {
  const result: CompanyIntegrations = { RULI_BASE_URL: baseUrl };
  if (!values || typeof values !== "object" || Array.isArray(values)) return result;
  const entries = values as Record<string, unknown>;
  for (const name of secretNames) {
    const value = entries[name];
    if (typeof value === "string" && value.trim()) result[name] = value.trim();
  }
  return result;
}

function companyEntries(source: IntegrationEnv): [string, unknown][] {
  if (!source.RULI_COMPANY_INTEGRATIONS) return [];
  try {
    const parsed: unknown = JSON.parse(source.RULI_COMPANY_INTEGRATIONS);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed).filter(([id]) => /^[a-f0-9]{32}$/.test(id));
    }
  } catch { /* A malformed secret must never select another company's credentials. */ }
  return [];
}

export function getCompanyIntegrations(source: IntegrationEnv, workspaceId: string | null): CompanyIntegrations {
  if (workspaceId === "legacy") return settings(source, source.RULI_BASE_URL);
  const entry = companyEntries(source).find(([id]) => id === workspaceId);
  return settings(entry?.[1], source.RULI_BASE_URL);
}

export function configuredBotIntegrations(source: IntegrationEnv): Map<string, CompanyIntegrations> {
  const entries = new Map<string, CompanyIntegrations>([["legacy", settings(source, source.RULI_BASE_URL)]]);
  for (const [id, values] of companyEntries(source)) {
    entries.set(id, settings(values, source.RULI_BASE_URL));
  }
  return entries;
}
