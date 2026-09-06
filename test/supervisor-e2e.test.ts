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
import { readState } from "../src/state.js";
import { reconcileRun } from "../src/reconciliation.js";
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
  for (const [name, change, reason] of [
    ["orphan rewrite", "git checkout --orphan replacement", "rewrote history"],
    [
      "amended history",
      "git commit --amend --no-edit --allow-empty",
      "rewrote history",
    ],
    [
      "branch switch",
      "git checkout -b replacement",
      "changed the checked-out branch",
    ],
    [
      "detached HEAD switch",
      "git checkout --detach",
      "changed the checked-out branch",
    ],
  ]) {
    test(`rejects ${name} without verification or a repair retry`, async () => {
      const config = await fixture();
      git(config.repositoryPath, ["config", "user.name", "Test"]);
      git(config.repositoryPath, [
        "config",
        "user.email",
        "test@example.invalid",
      ]);
      await writeFile(
        config.gooseBin,
        `#!/usr/bin/env bash
set -eu
printf 'correct\\n' > result.txt
git add result.txt
${change}
git add .
git commit --allow-empty -m replacement
`,
      );
      const record = await supervise(config);
      expect(record.status).toBe("failed");
      expect(record.attempts).toHaveLength(1);
      expect(record.attempts[0]?.verification).toBeUndefined();
      expect(
        await readFile(`${config.evidencePath}/attempt-1-failure.md`, "utf8"),
      ).toContain(reason!);
    });
  }

  test("rejects a rewrite even when the worker exits nonzero", async () => {
    const config = await fixture();
    await writeFile(
      config.gooseBin,
      `#!/usr/bin/env bash
set -eu
git checkout --orphan replacement
git -c user.name=Test -c user.email=test@example.invalid commit -m replacement
exit 7
`,
    );
    const record = await supervise(config);
    expect(record.status).toBe("failed");
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.worker.exitCode).toBe(7);
    expect(record.attempts[0]?.verification).toBeUndefined();
  });

  test("rejects new merge commits even when they preserve ancestry", async () => {
    const config = await fixture();
    git(config.repositoryPath, ["config", "user.name", "Test"]);
    git(config.repositoryPath, [
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await writeFile(
      config.gooseBin,
      `#!/usr/bin/env bash
set -eu
git checkout -b side
printf 'side' > side.txt
git add .
git commit -m side
git checkout main
printf 'correct\\n' > result.txt
git add .
git commit -m correct
git merge --no-ff side -m merge
`,
    );
    const record = await supervise(config);
    expect(record.status).toBe("failed");
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.verification).toBeUndefined();
    expect(
      await readFile(`${config.evidencePath}/attempt-1-failure.md`, "utf8"),
    ).toContain("introduced a merge commit");
  });

  test("passes verifier evidence into a fresh repair attempt", async () => {
    const config = await fixture();
    const record = await supervise(config);

    expect(record.status).toBe("accepted");
    expect(record.attempts).toHaveLength(2);
    expect(record.attempts[0]?.verification?.exitCode).toBe(1);
    expect(record.attempts[1]?.verification?.exitCode).toBe(0);
    expect(
      await readFile(`${config.evidencePath}/attempt-1-failure.md`, "utf8"),
    ).toContain("expected correct");
    expect(await readFile(`${config.repositoryPath}/result.txt`, "utf8")).toBe(
      "correct\n",
    );
  }, 15_000);

  test("rejects a concurrent supervisor before it starts a worker", async () => {
    const config = await fixture();
    const first = supervise(config);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await expect(
      supervise({ ...config, evidencePath: config.evidencePath + "-second" }),
    ).rejects.toThrow("worktree ownership unavailable");
    await expect(first).resolves.toMatchObject({ status: "accepted" });
  }, 15_000);

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
        config.workerRecipePath!,
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
  test("writes accepted exact-head proof reusable by reconciliation", async () => {
    const config = await fixture();
    const record = await supervise(config);
    const state = await readState(config.evidencePath);
    expect(record.status).toBe("accepted");
    expect(state.phase).toBe("accepted");
    expect(state.verification?.artifact).toBeDefined();
    const proof = state.verification?.artifact as { path?: string } | undefined;
    expect(
      state.completedAttempts
        ?.at(-1)
        ?.artifacts.some((artifact) => artifact.path === proof?.path),
    ).toBe(true);
    const reconciled = await reconcileRun(
      config.evidencePath,
      state,
      config.maxAttempts,
    );
    expect(reconciled.action).toBe("reuse-accepted");
  }, 20_000);

  test("uses frozen verifier snapshot after original verifier changes", async () => {
    const config = await fixture();
    await supervise(config);
    await writeFile(config.verifierPath, "#!/usr/bin/env bash\nexit 99\n");
    await chmod(config.verifierPath, 0o755);
    const state = await readState(config.evidencePath);
    expect(
      await readFile(
        join(config.evidencePath, state.inputs.verifier.entry.path),
        "utf8",
      ),
    ).not.toContain("exit 99");
    expect(
      (await reconcileRun(config.evidencePath, state, config.maxAttempts))
        .action,
    ).toBe("reuse-accepted");
  }, 20_000);

  test("refuses an evidence path collision before worker launch", async () => {
    const config = await fixture();
    await mkdir(config.evidencePath);
    await expect(supervise(config)).rejects.toThrow(
      "evidence directory already exists",
    );
    expect(
      await Bun.file(join(config.repositoryPath, "result.txt")).exists(),
    ).toBe(false);
  });
});

function processExecPath(): string {
  return process.execPath;
}
