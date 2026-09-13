/** Variables substituted into the worker prompt template. */
export const PROMPT_VARIABLES = [
  "plan",
  "repository_path",
  "plan_path",
  "stage",
  "attempt",
  "failure_report_path",
  "worker_report_path",
  "worker_judgment",
] as const;

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Substitute `{{ name }}` tokens, tolerating inner whitespace. Unknown
 * variables and leftover `{{`/`}}` markers are template errors.
 */
export function renderPrompt(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  const rendered = template.replaceAll(TOKEN, (token, name: string) => {
    if (!Object.hasOwn(vars, name))
      throw new Error(`unknown prompt variable: ${name}`);
    return vars[name] ?? "";
  });
  if (rendered.includes("{{") || rendered.includes("}}"))
    throw new Error("unresolved prompt template token");
  return rendered;
}
