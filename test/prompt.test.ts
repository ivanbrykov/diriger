import { expect, test } from "bun:test";
import { PROMPT_VARIABLES, renderPrompt } from "../src/prompt.js";

const vars = Object.fromEntries(
  PROMPT_VARIABLES.map((name) => [name, "<" + name + ">"]),
);

test("substitutes known variables and tolerates inner whitespace", () => {
  expect(renderPrompt("do {{ plan }} at {{  stage  }}", vars)).toBe(
    "do <plan> at <stage>",
  );
});

test("rejects an unknown variable", () => {
  expect(() => renderPrompt("run {{ mysterious }}", vars)).toThrow(
    "unknown prompt variable: mysterious",
  );
});

test("rejects leftover template markers", () => {
  expect(() => renderPrompt("literal {{ braces", vars)).toThrow(
    "unresolved prompt template token",
  );
  expect(() => renderPrompt("literal }} braces", vars)).toThrow(
    "unresolved prompt template token",
  );
});

test("empty optional variables render as empty strings", () => {
  const optional = { ...vars, worker_report_path: "", worker_judgment: "" };
  expect(
    renderPrompt("a{{ worker_report_path }}b\nc{{ worker_judgment }}d", optional),
  ).toBe("ab\ncd");
});

test("the bundled default template renders with all variables", async () => {
  const template = await Bun.file(
    new URL("../prompts/worker.md", import.meta.url),
  ).text();
  const rendered = renderPrompt(template, vars);
  for (const name of PROMPT_VARIABLES)
    expect(rendered).toContain("<" + name + ">");
});

test("the bundled default template renders with empty optional variables", async () => {
  const template = await Bun.file(
    new URL("../prompts/worker.md", import.meta.url),
  ).text();
  const rendered = renderPrompt(template, {
    ...vars,
    worker_report_path: "",
    worker_judgment: "",
  });
  expect(rendered).not.toContain("{{");
});
