declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    RULI_OWNER_EMAIL?: string;
    XAI_API_KEY?: string;
    OPENAI_API_KEY?: string;
    GROK_BOT_WEBHOOK_URL?: string;
    GROK_BOT_WEBHOOK_KEY?: string;
    GROK_BOT_WEBHOOK_HEADER?: string;
    RULI_BOT_API_TOKEN?: string;
    RULI_COMPANY_INTEGRATIONS?: string;
    RULI_BASE_URL?: string;
  }
}
