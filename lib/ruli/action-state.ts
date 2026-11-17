/** Serializable form response. Failed submissions keep every entered value. */
export type ActionState = {
  sentClientId?: string;
  aiRunId?: string;
  aiStatus?: "pending" | "succeeded" | "failed" | "stale";
  notice?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string | string[]>;
};
