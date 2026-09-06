import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureWorkerProfile,
  frozenWorkerEnvironment,
  validateWorkerProfile,
} from "../src/worker-profile.js";
import type { SupervisorConfig } from "../src/types.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-profile-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const agent = join(bin, "goose");
  await writeFile(agent, "#!/bin/sh\nexit 0\n");
  await chmod(agent, 0o755);
  const config: SupervisorConfig = {
    repositoryPath: root,
    planPath: join(root, "plan"),
    stage: "x",
    verifierPath: join(root, "verify"),
    workerRecipePath: join(root, "recipe"),
    evidencePath: join(root, "evidence"),
    gooseBin: "goose",
    maxAttempts: 1,
    workerTimeoutMs: 1,
    noToolTimeoutMs: 1,
    noToolOutputBytes: 1,
    runId: "profile",
  };
  return { root, bin, agent, config };
}
test("rejects PATH executable substitution and executable content drift", async () => {
  const f = await fixture();
  try {
    const env = { PATH: f.bin, GOOSE_MODEL: "m1" };
    const profile = await captureWorkerProfile(f.config, env);
    const other = join(f.root, "other");
    await mkdir(other);
    await writeFile(join(other, "goose"), "#!/bin/sh\nexit 1\n");
    await chmod(join(other, "goose"), 0o755);
    await expect(
      validateWorkerProfile(profile, f.config, { ...env, PATH: other }),
    ).rejects.toThrow("worker runtime profile drift");
    await writeFile(f.agent, "#!/bin/sh\necho changed\n");
    await expect(validateWorkerProfile(profile, f.config, env)).rejects.toThrow(
      "worker runtime profile drift",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("pins model settings and explicit OMP configuration without retaining secrets", async () => {
  const f = await fixture();
  try {
    const omp = join(f.root, "omp");
    await mkdir(omp);
    await writeFile(join(omp, "models.json"), '{"model":"one"}');
    const env = {
      PATH: f.bin,
      OMP_MODEL: "one",
      PI_CODING_AGENT_DIR: omp,
      API_TOKEN: "never-persist",
      GOOSE_API_KEY: "also-never",
    };
    const profile = await captureWorkerProfile(f.config, env);
    const persisted = JSON.stringify(profile);
    expect(persisted).not.toContain("never-persist");
    expect(persisted).not.toContain("also-never");
    await validateWorkerProfile(profile, f.config, env);
    await expect(
      validateWorkerProfile(profile, f.config, { ...env, OMP_MODEL: "two" }),
    ).rejects.toThrow("worker runtime profile drift");
    await writeFile(join(omp, "models.json"), '{"model":"two"}');
    await expect(validateWorkerProfile(profile, f.config, env)).rejects.toThrow(
      "worker runtime profile drift",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("rejects a changed ACP adapter script named in argv", async () => {
  const f = await fixture();
  try {
    const script = join(f.root, "adapter.ts");
    await writeFile(script, "console.log('one')\n");
    const config = {
      ...f.config,
      workerKind: "acp" as const,
      acpCommand: [f.agent, script],
    };
    const profile = await captureWorkerProfile(config, { PATH: f.bin });
    await writeFile(script, "console.log('two')\n");
    await expect(
      validateWorkerProfile(profile, config, { PATH: f.bin }),
    ).rejects.toThrow("worker runtime profile drift");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("captures a stable Goose config reference", async () => {
  const f = await fixture();
  try {
    const goose = join(f.root, "goose-config");
    await mkdir(goose);
    await writeFile(join(goose, "config.yaml"), "model: local\n");
    const env = {
      PATH: f.bin,
      GOOSE_CONFIG_DIR: goose,
      GOOSE_PROVIDER: "local",
    };
    const profile = await captureWorkerProfile(f.config, env);
    await validateWorkerProfile(profile, f.config, env);
    await writeFile(join(goose, "config.yaml"), "model: changed\n");
    await expect(validateWorkerProfile(profile, f.config, env)).rejects.toThrow(
      "worker runtime profile drift",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("records missing default configuration and rejects its later appearance", async () => {
  const f = await fixture();
  try {
    const home = join(f.root, "home");
    await mkdir(home);
    const env = { PATH: f.bin, HOME: home };
    const profile = await captureWorkerProfile(f.config, env);
    expect(
      profile.configFiles.some(
        (file) =>
          !file.exists && file.path.endsWith(".config/goose/config.yaml"),
      ),
    ).toBeTrue();
    expect(
      profile.configFiles.some(
        (file) => !file.exists && file.path.endsWith(".omp/agent/config.yml"),
      ),
    ).toBeTrue();
    const agentDir = join(home, ".omp", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "config.yml"), "model: omp-appeared\n");
    await expect(validateWorkerProfile(profile, f.config, env)).rejects.toThrow(
      "worker runtime profile drift",
    );
    await rm(agentDir, { recursive: true });
    const configDir = join(home, ".config", "goose");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.yaml"), "model: appeared\n");
    await expect(validateWorkerProfile(profile, f.config, env)).rejects.toThrow(
      "worker runtime profile drift",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("pins non-secret OpenAI route controls including host and path", async () => {
  const f = await fixture();
  try {
    const env = {
      PATH: f.bin,
      OPENAI_HOST: "http://route-one.invalid",
      OPENAI_BASE_PATH: "v1/chat/completions",
      OPENAI_API_KEY: "never-persist",
    };
    const profile = await captureWorkerProfile(f.config, env);
    expect(profile.openaiRoute).toEqual({
      OPENAI_HOST: "http://route-one.invalid",
      OPENAI_BASE_PATH: "v1/chat/completions",
      OPENAI_BASE_URL: null,
      API_VERSION: null,
      OPENAI_API_VERSION: null,
    });
    expect(JSON.stringify(profile)).not.toContain("never-persist");
    await expect(
      validateWorkerProfile(profile, f.config, {
        ...env,
        OPENAI_HOST: "http://route-two.invalid",
      }),
    ).rejects.toThrow("worker runtime profile drift");
    await expect(
      validateWorkerProfile(profile, f.config, {
        ...env,
        OPENAI_BASE_PATH: "v1/responses",
      }),
    ).rejects.toThrow("worker runtime profile drift");
    const previous = process.env.OPENAI_HOST;
    process.env.OPENAI_HOST = "http://inherited.invalid";
    try {
      const frozen = frozenWorkerEnvironment(profile);
      expect(frozen.OPENAI_HOST).toBe("http://route-one.invalid");
      expect(frozen.OPENAI_BASE_PATH).toBe("v1/chat/completions");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_HOST;
      else process.env.OPENAI_HOST = previous;
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
