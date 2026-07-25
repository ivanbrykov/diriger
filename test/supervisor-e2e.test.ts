import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervise } from "../src/supervisor.js";
import type { SupervisorConfig } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function git(repository: string, args: ReadonlyArray<string>): void {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function fixture(): Promise<SupervisorConfig> {
  const root = await mkdtemp(join(tmpdir(), "goose-supervisor-e2e-"));
  roots.push(root);

  const repository = join(root, "repo");
  const evidence = join(root, "evidence");
  const plan = join(root, "plan.md");
  const recipe = join(root, "worker.yaml");
  const goose = join(root, "fake-goose");
  const verifier = join(root, "verify");

  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "baseline\n");
  await writeFile(plan, "Write the word correct to result.txt.\n");
  await writeFile(recipe, "description: fake\n");
  await writeFile(
    goose,
    `#!/usr/bin/env bash
set -euo pipefail
repo=""
report=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--params" ]]; then
    case "$2" in
      repository_path=*) repo="\${2#repository_path=}" ;;
      failure_report_path=*) report="\${2#failure_report_path=}" ;;
    esac
    shift 2
  else
    shift
  fi
done
if [[ "$report" == "/dev/null" ]]; then
  printf 'wrong\\n' > "$repo/result.txt"
  message="wrong first attempt"
else
  grep -q 'verifier exited with code 1' "$report"
  grep -q 'expected correct' "$report"
  printf 'correct\\n' > "$repo/result.txt"
  message="repair from evidence"
fi
git -C "$repo" add result.txt
git -C "$repo" -c user.name=Test -c user.email=test@example.invalid commit -m "$message" >/dev/null
printf '{"type":"complete","total_tokens":10,"input_tokens":8,"output_tokens":2,"cache_read_input_tokens":4}\\n'
`,
  );
  await writeFile(
    verifier,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$(cat "$SAMOVAR_BENCH_REPO/result.txt")" == "correct" ]]; then
  echo "verified"
else
  echo "expected correct"
  exit 1
fi
`,
  );
  await chmod(goose, 0o755);
  await chmod(verifier, 0o755);

  git(repository, ["init", "-b", "main"]);
  git(repository, ["add", "."]);
  git(repository, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "baseline",
  ]);

  return {
    repositoryPath: repository,
    planPath: plan,
    stage: "1",
    verifierPath: verifier,
    workerRecipePath: recipe,
    evidencePath: evidence,
    gooseBin: goose,
    maxAttempts: 2,
    workerTimeoutMs: 5_000,
    noToolTimeoutMs: 5_000,
    noToolOutputBytes: 1_000_000,
    runId: "fake-recovery",
  };
}

describe("supervise", () => {
  test("passes verifier evidence into a fresh repair attempt", async () => {
    const config = await fixture();
    const record = await supervise(config);

    expect(record.status).toBe("accepted");
    expect(record.attempts).toHaveLength(2);
    expect(record.attempts[0]?.verification?.exitCode).toBe(1);
    expect(record.attempts[1]?.verification?.exitCode).toBe(0);
    expect(
      await readFile(
        `${config.evidencePath}/attempt-1-failure.md`,
        "utf8",
      ),
    ).toContain("expected correct");
    expect(
      await readFile(`${config.repositoryPath}/result.txt`, "utf8"),
    ).toBe("correct\n");
  });

  test("returns failed after the configured attempt limit", async () => {
    const config = await fixture();
    const record = await supervise({ ...config, maxAttempts: 1 });

    expect(record.status).toBe("failed");
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.verification?.exitCode).toBe(1);
  });

  test("the CLI exits nonzero after exhausted attempts", async () => {
    const config = await fixture();
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const process = Bun.spawn(
      [
        processExecPath(),
        cli,
        "run",
        "--repo",
        config.repositoryPath,
        "--plan",
        config.planPath,
        "--stage",
        config.stage,
        "--verifier",
        config.verifierPath,
        "--worker-recipe",
        config.workerRecipePath,
        "--evidence",
        config.evidencePath,
        "--goose",
        config.gooseBin,
        "--max-attempts",
        "1",
        "--run-id",
        "fake-cli-failure",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(await process.exited).toBe(1);
  });
});

function processExecPath(): string {
  return process.execPath;
}
