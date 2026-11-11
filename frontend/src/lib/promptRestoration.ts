const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
function content(value: unknown): string | null {
  if (!record(value) || value.v !== 1 || !record(value.snapshot)) return null;
  const copy = {...value};
  delete copy.at; // Only the envelope's capture clock; nested fields remain exact.
  return JSON.stringify(ordered(copy));
}
export const isPromptRestoration = (key: string) =>
  key.startsWith("frontend_state:ds_promptstudio_rehydration_state_v1_");
export function samePromptRestoration(left: unknown, right: unknown): boolean {
  const value = content(left);
  return value !== null && value === content(right);
}
