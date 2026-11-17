declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    RULI_OWNER_EMAIL?: string;
  }
}
