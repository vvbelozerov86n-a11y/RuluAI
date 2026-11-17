/** Serializable form response. Failed submissions keep every entered value. */
export type ActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string | string[]>;
};
