import assert from "node:assert/strict";
import {
  access,
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  atomicWriteTextIfUnchanged,
  AtomicCommittedMutationError,
  AtomicCommittedUnlinkError,
  unlinkRegularFileIfUnchanged,
} from "../../src/agent-file/atomic-write.js";
import { buildCli } from "../../src/cli.js";
import { useRepository } from "../../src/commands/use.js";
import {
  setupGlobalClients,
  type SetupOptions,
} from "../../src/commands/setup.js";
import { initializeDatabase } from "../../src/commands/init.js";
import { openConnection } from "../../src/db/connection.js";
import {
  GLOBAL_REPOSITORY_ID,
  GLOBAL_WORKSPACE,
} from "../../src/memory/workspaces.js";
import { registerRepositoryAndLocation } from "../../src/repository/binding.js";
import {
  STANDARD_ENNO_SKILL_FILES,
  STANDARD_FUNCTION_SKILL_FILES,
  STANDARD_MEMORY_SKILL_FILES,
  STANDARD_SIMPLE_SKILL_FILES,
  STANDARD_SOUL_SKILL_FILES,
  STANDARD_UI_SKILL_FILES,
} from "../../src/setup/standard-skills.js";
import {
  LEGACY_CLAUDE_PROMPT_HOOK,
  legacyOpenCodeLoopGuardFixture,
} from "../fixtures/legacy-client-cleanup.js";

const STANDARD_SKILL_FIXTURES = [
  {
    name: "kiokuko-ui-design-soul",
    files: STANDARD_UI_SKILL_FILES,
  },
  {
    name: "kiokuko-simple-work",
    files: STANDARD_SIMPLE_SKILL_FILES,
  },
  {
    name: "kiokuko-single-purpose-functions",
    files: STANDARD_FUNCTION_SKILL_FILES,
  },
  {
    name: "kiokuko-enno-oduno",
    files: STANDARD_ENNO_SKILL_FILES,
  },
  {
    name: "memory-reasoning",
    files: STANDARD_MEMORY_SKILL_FILES,
  },
  {
    name: "kiokuko-soul",
    files: STANDARD_SOUL_SKILL_FILES,
  },
] as const;

function standardSkillPaths(
  skillsDirectory: string,
  join: (...paths: string[]) => string = path.join,
): string[] {
  return STANDARD_SKILL_FIXTURES.flatMap((skill) =>
    skill.files.map((relativePath) =>
      join(skillsDirectory, skill.name, relativePath),
    ),
  );
}

async function temporaryEnvironment(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-setup-${prefix}-`));
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  await mkdir(home, { recursive: true });
  return {
    root,
    home,
    config,
    data,
    env: { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
    databasePath: path.join(data, "kiokuko", "kiokuko-dsh.sqlite3"),
  };
}

function openConnectionWithCloseFailure(
  closeFailure: unknown,
): typeof openConnection {
  return (filePath, options) => {
    const database = openConnection(filePath, options);
    return new Proxy(database, {
      get(target, property) {
        if (property === "close") {
          return () => {
            target.close();
            throw closeFailure;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

async function runCliJson(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({ setupEnvironment: { platform, env } }).parseAsync([
      "node",
      "kiokuko",
      ...args,
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(stdout) as { ok: boolean; data: Record<string, unknown> };
}

test("setup preserves both global-workspace initialization and database-close failures", async () => {
  const temporary = await temporaryEnvironment("workspace-dual-failure");
  const workspaceFailure = new Error(
    "workspace-initialization-failure-sentinel",
  );
  const closeFailure = new Error("setup-database-close-failure-sentinel");

  await assert.rejects(
    setupGlobalClients(
      {
        clients: [],
        databasePath: temporary.databasePath,
        platform: "linux",
        env: temporary.env,
      },
      {
        openConnection: openConnectionWithCloseFailure(closeFailure),
        ensureGlobalWorkspace: () => {
          throw workspaceFailure;
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Global workspace initialization failed and closing the database connection also failed",
      );
      assert.deepEqual(error.errors, [workspaceFailure, closeFailure]);
      return true;
    },
  );
});

test("CLI no-argument setup configures only the detected Hermes profile when the executable is present", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const temporary = await temporaryEnvironment(`cli-hermes-${platform}`);
    const hermesHome = path.join(temporary.home, ".hermes");
    const bin = path.join(temporary.root, "bin");
    await mkdir(hermesHome, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(hermesHome, "active_profile"), "default\n");
    await writeFile(
      path.join(hermesHome, "config.yaml"),
      "model: test\nmcp_servers:\n  other:\n    command: other\n    args: [serve]\n",
    );
    const hermes = path.join(bin, "hermes");
    await writeFile(
      hermes,
      '#!/bin/sh\nprintf "%s\\n" "$HERMES_CONFIG_PATH"\n',
    );
    await chmod(hermes, 0o755);
    const env = {
      ...temporary.env,
      PATH: bin,
      HERMES_CONFIG_PATH: path.join(hermesHome, "config.yaml"),
    };

    const dryRun = await runCliJson(platform, env, [
      "setup",
      "--dry-run",
      "--json",
    ]);
    assert.equal(dryRun.ok, true);
    assert.deepEqual(dryRun.data.clients, ["hermes"]);
    assert.equal(dryRun.data.databaseAction, "planned");
    assert.equal(dryRun.data.dryRun, true);
    const dryRunFiles = dryRun.data.files as Array<{
      path: string;
      client: string;
    }>;
    assert.ok(dryRunFiles.every((file) => file.client === "hermes"));
    await assert.rejects(access(String(dryRun.data.databasePath)));
    await assert.rejects(
      access(
        path.join(hermesHome, "skills", "kiokuko-ui-design-soul", "SKILL.md"),
      ),
    );
    await assert.rejects(
      access(
        path.join(hermesHome, "skills", "kiokuko-simple-work", "SKILL.md"),
      ),
    );
    await assert.rejects(
      access(
        path.join(
          hermesHome,
          "skills",
          "kiokuko-single-purpose-functions",
          "SKILL.md",
        ),
      ),
    );
    await assert.rejects(
      access(path.join(hermesHome, "skills", "kiokuko-enno-oduno", "SKILL.md")),
    );
    await assert.rejects(
      access(path.join(hermesHome, "skills", "kiokuko-soul", "SKILL.md")),
    );

    const first = await runCliJson(platform, env, ["setup", "--json"]);
    assert.equal(first.ok, true);
    assert.deepEqual(first.data.clients, ["hermes"]);
    assert.equal(first.data.databaseAction, "initialized");
    await access(String(first.data.databasePath));
    await access(path.join(hermesHome, "config.yaml"));
    await access(
      path.join(hermesHome, "skills", "kiokuko-ui-design-soul", "SKILL.md"),
    );
    await access(
      path.join(hermesHome, "skills", "kiokuko-simple-work", "SKILL.md"),
    );
    await access(
      path.join(
        hermesHome,
        "skills",
        "kiokuko-single-purpose-functions",
        "SKILL.md",
      ),
    );
    await access(
      path.join(hermesHome, "skills", "kiokuko-enno-oduno", "SKILL.md"),
    );
    await access(path.join(hermesHome, "skills", "kiokuko-soul", "SKILL.md"));
    assert.match(
      await readFile(path.join(hermesHome, "config.yaml"), "utf8"),
      /command: kiokuko/,
    );
    assert.match(
      await readFile(path.join(hermesHome, "config.yaml"), "utf8"),
      /command: other/,
    );
    await assert.rejects(
      access(path.join(temporary.home, ".codex", "config.toml")),
    );
    await assert.rejects(
      access(path.join(temporary.config, "opencode", "opencode.json")),
    );
    await assert.rejects(access(path.join(temporary.home, ".claude.json")));

    const migrated = await runCliJson(platform, env, [
      "setup",
      "--clients",
      "hermes",
      "--command",
      "/opt/homebrew/bin/kiokuko",
      "--json",
    ]);
    const migratedFiles = migrated.data.files as Array<{
      path: string;
      action: string;
      purpose: string;
    }>;
    assert.equal(migrated.data.databaseAction, "initialized");
    assert.equal(
      migratedFiles.find((file) => file.purpose === "mcp-config")?.action,
      "updated",
    );
    assert.ok(
      migratedFiles
        .filter((file) => file.purpose === "standard-skill")
        .every((file) => file.action === "unchanged"),
    );
    const migratedConfig = await readFile(
      path.join(hermesHome, "config.yaml"),
      "utf8",
    );
    assert.match(migratedConfig, /command: \/opt\/homebrew\/bin\/kiokuko/);
    assert.match(migratedConfig, /command: other/);

    const second = await runCliJson(platform, env, [
      "setup",
      "--clients",
      "hermes",
      "--command",
      "/opt/homebrew/bin/kiokuko",
      "--json",
    ]);
    const secondFiles = second.data.files as Array<{ action: string }>;
    assert.ok(secondFiles.every((file) => file.action === "unchanged"));
  }
});

test("CLI uses hermes config path to select a profile when active_profile is unavailable", async () => {
  const temporary = await temporaryEnvironment("cli-hermes-config-path");
  const profileHome = path.join(temporary.home, ".hermes", "profiles", "main");
  const bin = path.join(temporary.root, "bin");
  const configPath = path.join(profileHome, "config.yaml");
  await mkdir(profileHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  const hermes = path.join(bin, "hermes");
  await writeFile(hermes, '#!/bin/sh\nprintf "%s\\n" "$HERMES_CONFIG_PATH"\n');
  await chmod(hermes, 0o755);

  const result = await runCliJson(
    "linux",
    {
      ...temporary.env,
      PATH: bin,
      HERMES_CONFIG_PATH: configPath,
    },
    ["setup", "--json"],
  );

  assert.deepEqual(result.data.clients, ["hermes"]);
  const files = result.data.files as Array<{ path: string; client: string }>;
  assert.ok(files.every((file) => file.client === "hermes"));
  assert.equal(files[0]?.path, configPath);
  await access(configPath);
  await assert.rejects(
    access(path.join(temporary.home, ".hermes", "config.yaml")),
  );
});

test("CLI Claude setup enables Enno-Oduno for a new installation", async () => {
  const temporary = await temporaryEnvironment("cli-no-claude-hook-management");
  const result = await runCliJson("linux", temporary.env, [
    "setup",
    "--clients",
    "claude",
    "--no-standard-skills",
    "--json",
  ]);
  assert.equal(result.ok, true);
  const files = result.data.files as Array<{ purpose: string }>;
  assert.deepEqual(files.map((file) => file.purpose).sort(), [
    "enno-hook",
    "instructions",
    "mcp-config",
  ]);
  assert.match(
    await readFile(
      path.join(temporary.home, ".claude", "settings.json"),
      "utf8",
    ),
    /enno hook --client claude/u,
  );
});

test("CLI batch setup persists an explicit community discovery choice", async () => {
  const temporary = await temporaryEnvironment("cli-community-discovery");
  const result = await runCliJson("linux", temporary.env, [
    "setup",
    "--clients",
    "codex",
    "--no-standard-skills",
    "--skill-discovery",
    "community",
    "--json",
  ]);
  assert.equal(result.ok, true);
  assert.match(
    await readFile(path.join(temporary.home, ".codex", "config.toml"), "utf8"),
    /KIOKUKO_SKILL_DISCOVERY = "community"/,
  );
});

test("CLI setup preserves an explicit discovery environment override", async () => {
  const temporary = await temporaryEnvironment("cli-discovery-environment");
  const result = await runCliJson(
    "linux",
    {
      ...temporary.env,
      KIOKUKO_SKILL_DISCOVERY: "off",
    },
    ["setup", "--clients", "codex", "--no-standard-skills", "--json"],
  );
  assert.equal(result.ok, true);
  assert.match(
    await readFile(path.join(temporary.home, ".codex", "config.toml"), "utf8"),
    /KIOKUKO_SKILL_DISCOVERY = "off"/,
  );
});

test("Windows OpenCode dry-run plans every artifact below the XDG-style global root", async () => {
  const temporary = await temporaryEnvironment("windows-opencode-dry-run");
  const windowsHome = String.raw`C:\Users\test`;
  const windowsAppData = String.raw`C:\Users\test\AppData\Roaming`;
  const windowsLocalAppData = String.raw`C:\Users\test\AppData\Local`;
  const canonicalRoot = String.raw`C:\Users\test\.config\opencode`;

  const result = await setupGlobalClients({
    clients: ["opencode"],
    dryRun: true,
    platform: "win32",
    env: {
      USERPROFILE: windowsHome,
      APPDATA: windowsAppData,
      LOCALAPPDATA: windowsLocalAppData,
    },
    databasePath: temporary.databasePath,
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(
    result.files.map((file) => file.path).sort(),
    [
      path.win32.join(canonicalRoot, "AGENTS.md"),
      path.win32.join(canonicalRoot, "opencode.json"),
      path.win32.join(canonicalRoot, "plugins", "kiokuko-enno-oduno.js"),
      ...standardSkillPaths(
        path.win32.join(canonicalRoot, "skills"),
        path.win32.join,
      ),
    ].sort(),
  );
  assert.ok(
    result.files.every(
      (file) =>
        !file.path.startsWith(path.win32.join(windowsAppData, "opencode")),
    ),
  );
  assert.ok(
    result.files.every(
      (file) =>
        !file.path.startsWith(path.win32.join(windowsLocalAppData, "opencode")),
    ),
  );
});

test("Windows OpenCode dry-run honors XDG_CONFIG_HOME before APPDATA", async () => {
  const temporary = await temporaryEnvironment("windows-opencode-xdg-dry-run");
  const xdgRoot = String.raw`D:\xdg-config\opencode`;

  const result = await setupGlobalClients({
    clients: ["opencode"],
    dryRun: true,
    platform: "win32",
    env: {
      USERPROFILE: String.raw`C:\Users\test`,
      APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
      LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local`,
      XDG_CONFIG_HOME: String.raw`D:\xdg-config`,
    },
    databasePath: temporary.databasePath,
  });

  assert.ok(result.files.every((file) => file.path.startsWith(`${xdgRoot}\\`)));
  assert.ok(
    result.files.some(
      (file) => file.path === path.win32.join(xdgRoot, "opencode.json"),
    ),
  );
  assert.ok(
    result.files.some(
      (file) => file.path === path.win32.join(xdgRoot, "AGENTS.md"),
    ),
  );
  assert.ok(
    result.files.some(
      (file) =>
        file.path ===
        path.win32.join(
          xdgRoot,
          "skills",
          "kiokuko-ui-design-soul",
          "SKILL.md",
        ),
    ),
  );
  assert.ok(
    result.files.some(
      (file) =>
        file.path ===
        path.win32.join(xdgRoot, "skills", "kiokuko-simple-work", "SKILL.md"),
    ),
  );
  assert.ok(
    result.files.some(
      (file) =>
        file.path ===
        path.win32.join(
          xdgRoot,
          "skills",
          "kiokuko-single-purpose-functions",
          "SKILL.md",
        ),
    ),
  );
  assert.ok(
    result.files.some(
      (file) =>
        file.path ===
        path.win32.join(xdgRoot, "skills", "kiokuko-enno-oduno", "SKILL.md"),
    ),
  );
  assert.ok(
    result.files.some(
      (file) =>
        file.path ===
        path.win32.join(xdgRoot, "skills", "kiokuko-soul", "SKILL.md"),
    ),
  );
});

test("setup safely merges Codex, OpenCode, and Claude Code global configuration and is idempotent", async () => {
  const temporary = await temporaryEnvironment("merge");
  const codexDirectory = path.join(temporary.home, ".codex");
  const openCodeDirectory = path.join(temporary.config, "opencode");
  const claudeDirectory = path.join(temporary.home, ".claude");
  await mkdir(codexDirectory, { recursive: true });
  await mkdir(openCodeDirectory, { recursive: true });
  await mkdir(claudeDirectory, { recursive: true });
  await writeFile(
    path.join(codexDirectory, "config.toml"),
    'model = "gpt-test"\n',
  );
  await writeFile(
    path.join(codexDirectory, "AGENTS.md"),
    "# Human Codex rules\n",
  );
  await writeFile(
    path.join(openCodeDirectory, "opencode.jsonc"),
    '{\n  // keep this comment\n  "theme": "dark",\n}\n',
  );
  await writeFile(
    path.join(openCodeDirectory, "AGENTS.md"),
    "# Human OpenCode rules\n",
  );
  await writeFile(
    path.join(temporary.home, ".claude.json"),
    '{\n  "theme": "dark"\n}\n',
  );
  await writeFile(
    path.join(claudeDirectory, "CLAUDE.md"),
    "# Human Claude rules\n",
  );

  const first = await setupGlobalClients({
    clients: ["codex", "opencode", "claude", "hermes"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
  });
  assert.equal(first.standardSkills, true);
  assert.equal(
    first.files.length,
    10 + standardSkillPaths("ignored").length * 4,
  );
  assert.equal(
    first.files.filter((file) => file.action === "updated").length,
    6,
  );
  assert.equal(
    first.files.filter((file) => file.action === "created").length,
    4 + standardSkillPaths("ignored").length * 4,
  );
  assert.equal(
    first.files.filter((file) => file.purpose === "standard-skill").length,
    standardSkillPaths("ignored").length * 4,
  );
  assert.match(
    first.nextStep,
    /run \/hooks in Codex and trust the new Kiokuko Stop hook/u,
  );

  const codexConfig = await readFile(
    path.join(codexDirectory, "config.toml"),
    "utf8",
  );
  assert.match(codexConfig, /^model = "gpt-test"/);
  assert.match(codexConfig, /\[mcp_servers\.kiokuko\]/);
  assert.match(codexConfig, /command = "kiokuko"/);
  assert.match(codexConfig, /KIOKUKO_SKILL_DISCOVERY = "official"/);
  const openCodeText = await readFile(
    path.join(openCodeDirectory, "opencode.jsonc"),
    "utf8",
  );
  assert.match(openCodeText, /keep this comment/);
  const openCode = parse(openCodeText) as {
    theme: string;
    mcp: {
      kiokuko: {
        type: string;
        command: string[];
        enabled: boolean;
        environment: { KIOKUKO_SKILL_DISCOVERY: string };
      };
    };
  };
  assert.equal(openCode.theme, "dark");
  assert.deepEqual(openCode.mcp.kiokuko, {
    type: "local",
    command: ["kiokuko", "mcp"],
    enabled: true,
    environment: { KIOKUKO_SKILL_DISCOVERY: "official" },
  });
  const claude = JSON.parse(
    await readFile(path.join(temporary.home, ".claude.json"), "utf8"),
  ) as {
    theme: string;
    mcpServers: {
      kiokuko: { type: string; command: string; args: string[]; env: object };
    };
  };
  assert.equal(claude.theme, "dark");
  assert.deepEqual(claude.mcpServers.kiokuko, {
    type: "stdio",
    command: "kiokuko",
    args: ["mcp"],
    env: { KIOKUKO_SKILL_DISCOVERY: "official" },
  });
  assert.match(
    await readFile(path.join(claudeDirectory, "settings.json"), "utf8"),
    /enno hook --client claude/u,
  );
  assert.match(
    await readFile(path.join(codexDirectory, "hooks.json"), "utf8"),
    /enno hook --client codex/u,
  );
  assert.match(
    await readFile(
      path.join(openCodeDirectory, "plugins", "kiokuko-enno-oduno.js"),
      "utf8",
    ),
    /session\.idle/u,
  );
  const hermesConfig = await readFile(
    path.join(temporary.home, ".hermes", "config.yaml"),
    "utf8",
  );
  assert.match(hermesConfig, /Managed by `kiokuko setup`\./);
  assert.match(hermesConfig, /command: kiokuko/);
  assert.match(hermesConfig, /- mcp/);
  assert.match(hermesConfig, /KIOKUKO_SKILL_DISCOVERY: official/);

  const skillsDirectories = [
    path.join(temporary.home, ".agents", "skills"),
    path.join(openCodeDirectory, "skills"),
    path.join(claudeDirectory, "skills"),
    path.join(temporary.home, ".hermes", "skills"),
  ];
  for (const skillsDirectory of skillsDirectories) {
    for (const fixture of STANDARD_SKILL_FIXTURES) {
      const skill = await readFile(
        path.join(skillsDirectory, fixture.name, "SKILL.md"),
        "utf8",
      );
      assert.match(skill, new RegExp(`^---\\nname: ${fixture.name}\\n`));
      assert.match(skill, /KIOKUKO MANAGED STANDARD SKILL/);
    }
    assert.match(
      await readFile(
        path.join(
          skillsDirectory,
          "kiokuko-ui-design-soul",
          "references",
          "ui-checklist.md",
        ),
        "utf8",
      ),
      /Last reviewed against the official sources: 2026-08-22/,
    );
    assert.match(
      await readFile(
        path.join(
          skillsDirectory,
          "kiokuko-single-purpose-functions",
          "references",
          "kiokuko-patterns.md",
        ),
        "utf8",
      ),
      /Single-purpose implementation patterns/,
    );
    assert.match(
      await readFile(
        path.join(
          skillsDirectory,
          "kiokuko-single-purpose-functions",
          "references",
          "review-checklist.md",
        ),
        "utf8",
      ),
      /Function-contract coding and review checklist/,
    );
    assert.match(
      await readFile(
        path.join(
          skillsDirectory,
          "kiokuko-single-purpose-functions",
          "references",
          "problem-shaping-and-language.md",
        ),
        "utf8",
      ),
      /problem shaping and representation design/iu,
    );
    assert.match(
      await readFile(
        path.join(skillsDirectory, "kiokuko-enno-oduno", "SKILL.md"),
        "utf8",
      ),
      /Enno-Oduno alone owns this state machine/,
    );
    assert.match(
      await readFile(
        path.join(skillsDirectory, "kiokuko-enno-oduno", "SKILL.md"),
        "utf8",
      ),
      /oduno_ideal[\s\S]*enno_ideal_submit[\s\S]*oduno_meditation[\s\S]*enno_meditation_submit/u,
    );
  }

  for (const instructionsPath of [
    path.join(codexDirectory, "AGENTS.md"),
    path.join(openCodeDirectory, "AGENTS.md"),
    path.join(claudeDirectory, "CLAUDE.md"),
  ]) {
    const instructions = await readFile(instructionsPath, "utf8");
    assert.match(instructions, /^# Human/);
    assert.equal(
      (instructions.match(/BEGIN KIOKUKO GLOBAL MEMORY/g) ?? []).length,
      1,
    );
    assert.match(instructions, /task_prepare/);
    assert.match(
      instructions,
      /`Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>`/u,
    );
    assert.match(
      instructions,
      /Every descriptor must include its kind and canonical name/u,
    );
    assert.match(instructions, /bounded opaque `requestId`/);
    assert.match(instructions, /Use a new ID for every new logical request/);
    assert.match(
      instructions,
      /Reuse an ID only for an exact transport retry; changed bound input under the same ID is a conflict/,
    );
    assert.match(instructions, /task_answer/);
    assert.match(instructions, /memory_checkpoint/);
    assert.match(instructions, /curator_check/);
    assert.match(instructions, /curator_globalize/);
    assert.match(
      instructions,
      /Optional external skill discovery is feature-flagged and reference-only/,
    );
    assert.match(
      instructions,
      /read and apply the complete bundled `kiokuko-soul` Skill before any other Kiokuko Skill/iu,
    );
    assert.match(
      instructions,
      /`task_prepare` is the Enno-Oduno orchestration entry point/u,
    );
    assert.match(
      instructions,
      /first identifies Codex, Claude Code, or OpenCode from MCP `clientInfo`/u,
    );
    assert.match(
      instructions,
      /Every Enno-Oduno directive requires the bundled `kiokuko-soul` Skill first/u,
    );
    assert.match(
      instructions,
      /read and apply `kiokuko-enno-oduno` after the master SOUL/u,
    );
    assert.match(
      instructions,
      /derives and persists the Oduno ideal.*every Akinator-discovered Skill/iu,
    );
    assert.match(
      instructions,
      /Zenki must read the master SOUL and then the compact `kiokuko-single-purpose-functions` index/u,
    );
    assert.match(instructions, /one to three versioned `expertRefs`/u);
    assert.match(
      instructions,
      /Goki receives only approved, already-decomposed WorkUnits/u,
    );
    assert.match(
      instructions,
      /Goki can start only after Zenki submits a complete WorkPlan/u,
    );
    assert.match(
      instructions,
      /A failed review never returns directly to Goki/u,
    );
    assert.match(
      instructions,
      /Oduno meditation.*obsolete tests or functions.*without mutating the repository/iu,
    );
    assert.match(instructions, /`ennoOduno\.orchestrationId`/u);
    assert.match(instructions, /never select a repository-wide latest run/iu);
    assert.match(
      instructions,
      /ambiguous candidates fail open without mutation/u,
    );
    assert.match(
      instructions,
      /routing metadata, not authorization ownership/u,
    );
    assert.match(
      instructions,
      /leaves the run active for another local project client/u,
    );
    assert.match(
      instructions,
      /userFacingRecovery.*whenToChoose.*whatHappens.*explicit choice/isu,
    );
    assert.match(
      instructions,
      /Do not retry, cancel, or create a new task automatically/iu,
    );
    assert.match(
      instructions,
      /never ask the user to locate or construct that catalog/iu,
    );
    assert.match(
      instructions,
      /active planning attempt.*restart choice explicitly cancels it before starting a new `task_prepare`/iu,
    );
    assert.match(
      instructions,
      /attempt already ended.*do not try to cancel it again/iu,
    );
    assert.match(
      instructions,
      /Inspect `nextAction` and `memoryPolicy` after every `task_prepare` and `task_answer` response/,
    );
    assert.match(
      instructions,
      /`memoryPolicy\.deliveryEmpty=true` with `storedEntryCount>0`.*inspect `contextWithheld`/u,
    );
    assert.match(
      instructions,
      /`memory-reasoning` is missing or unknown.*`memoryPolicy\.contextWithheld=true`.*`nextAction=proceed`/u,
    );
    assert.match(
      instructions,
      /`required_capability_unavailable` is a hard stop for missing or unknown `kiokuko-soul`/,
    );
    assert.match(
      instructions,
      /created by `kiokuko-curator` and matching the current deterministic Curator projection is `system_verified`/,
    );
    assert.match(instructions, /does not by itself require `memory-reasoning`/);
    assert.match(instructions, /continue from repository evidence/);
    assert.match(
      instructions,
      /Before build\/debug `task_prepare`, read it and advertise its exact descriptor/,
    );
    assert.match(
      instructions,
      /apply local `memory-reasoning` before using it/,
    );
    assert.match(
      instructions,
      /convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/,
    );
    assert.match(
      instructions,
      /`executionContext\.repositoryRoot` \(equal to `project\.repositoryRoot`\) as the canonical filesystem base/u,
    );
    assert.match(
      instructions,
      /For OpenCode filesystem tools, prefer canonical absolute paths under that root/u,
    );
    assert.match(
      instructions,
      /never pass `~`, `\$HOME`, or HOME-relative fragments/u,
    );
    assert.match(
      instructions,
      /produces an `external_directory` permission request, reject the malformed path and retry/u,
    );
    assert.match(
      instructions,
      /Call `task_answer` with the same capability catalog, run ID, and context budget/,
    );
    assert.match(
      instructions,
      /When `runId` is supplied, the run must be active/,
    );
    assert.match(
      instructions,
      /Do not call `memory_checkpoint` while `task_prepare` or `task_answer` reports `needs_answer`/,
    );
    assert.match(
      instructions,
      /complete the required `task_answer` loop first/,
    );
    assert.match(
      instructions,
      /successful terminal checkpoint is allowed at most once per logical request/,
    );
    assert.match(
      instructions,
      /rejected precondition does not count as that successful checkpoint/,
    );
    assert.match(
      instructions,
      /rejected precondition .*may be retried only after the indicated run-state change/,
    );
    assert.doesNotMatch(
      instructions,
      /Call `memory_checkpoint` at most once for the current user request/,
    );
    assert.match(
      instructions,
      /unavailable before a non-trivial build\/debug request can obtain its policy, stop and report/,
    );
    assert.match(instructions, /diagnosing or repairing Kiokuko itself/);
    assert.match(
      instructions,
      /`task_prepare` fails before returning scoped context/,
    );
    assert.match(
      instructions,
      /continue only from repository evidence without Kiokuko memory/,
    );
    assert.match(
      instructions,
      /do not call `task_answer` or `memory_checkpoint` for that failed request/,
    );
    assert.doesNotMatch(
      instructions,
      /Kiokuko is unavailable[^.]*continue from current evidence/iu,
    );
    assert.doesNotMatch(
      instructions,
      /legacy fallback|mattpocock\/skills|explicitly empty catalog/iu,
    );
  }

  const database = openConnection(temporary.databasePath);
  try {
    const globalRow = database
      .prepare(
        "SELECT repository_id AS repositoryId, workspace FROM repositories WHERE repository_id = ?",
      )
      .get<{ repositoryId: string; workspace: string }>(GLOBAL_REPOSITORY_ID);
    assert.equal(globalRow?.repositoryId, GLOBAL_REPOSITORY_ID);
    assert.equal(globalRow?.workspace, GLOBAL_WORKSPACE);
  } finally {
    database.close();
  }

  const before = await Promise.all(
    first.files.map((file) => readFile(file.path, "utf8")),
  );
  const second = await setupGlobalClients({
    clients: ["codex", "opencode", "claude", "hermes"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
  });
  assert.ok(second.files.every((file) => file.action === "unchanged"));
  assert.doesNotMatch(second.nextStep, /\/hooks/u);
  assert.deepEqual(
    await Promise.all(first.files.map((file) => readFile(file.path, "utf8"))),
    before,
  );
});

test("setup keeps upgrades unchanged until explicit Enno-Oduno ON and OFF preserves user hooks", async () => {
  const temporary = await temporaryEnvironment("enno-upgrade-toggle");
  const options: SetupOptions = {
    clients: ["codex", "opencode", "claude"],
    platform: "linux" as const,
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  };
  await setupGlobalClients({ ...options, ennoOduno: "off" });
  const codexHooks = path.join(temporary.home, ".codex", "hooks.json");
  const claudeSettings = path.join(temporary.home, ".claude", "settings.json");
  const openCodePlugin = path.join(
    temporary.config,
    "opencode",
    "plugins",
    "kiokuko-enno-oduno.js",
  );
  for (const filePath of [codexHooks, claudeSettings, openCodePlugin])
    await assert.rejects(access(filePath));

  const preserved = await setupGlobalClients(options);
  assert.equal(preserved.ennoOduno, "new-installs-only");
  assert.equal(
    preserved.files.some((file) => file.purpose === "enno-hook"),
    false,
  );
  for (const filePath of [codexHooks, claudeSettings, openCodePlugin])
    await assert.rejects(access(filePath));

  const enabled = await setupGlobalClients({ ...options, ennoOduno: "on" });
  assert.equal(
    enabled.files.filter((file) => file.purpose === "enno-hook").length,
    3,
  );
  assert.match(
    enabled.nextStep,
    /run \/hooks in Codex and trust the new Kiokuko Stop hook/u,
  );
  const codex = JSON.parse(await readFile(codexHooks, "utf8")) as {
    hooks: { Stop: unknown[] };
  };
  const claude = JSON.parse(await readFile(claudeSettings, "utf8")) as {
    hooks: { Stop: unknown[] };
  };
  codex.hooks.Stop.unshift({
    matcher: "user",
    hooks: [{ type: "command", command: "user-codex-hook" }],
  });
  claude.hooks.Stop.unshift({
    matcher: "user",
    hooks: [{ type: "command", command: "user-claude-hook" }],
  });
  await writeFile(codexHooks, `${JSON.stringify(codex, null, 2)}\n`);
  await writeFile(claudeSettings, `${JSON.stringify(claude, null, 2)}\n`);

  const disabled = await setupGlobalClients({ ...options, ennoOduno: "off" });
  assert.equal(
    disabled.files.filter((file) => file.purpose === "enno-hook").length,
    3,
  );
  assert.doesNotMatch(disabled.nextStep, /\/hooks/u);
  assert.match(await readFile(codexHooks, "utf8"), /user-codex-hook/u);
  assert.doesNotMatch(await readFile(codexHooks, "utf8"), /enno hook/u);
  assert.match(await readFile(claudeSettings, "utf8"), /user-claude-hook/u);
  assert.doesNotMatch(await readFile(claudeSettings, "utf8"), /enno hook/u);
  await assert.rejects(access(openCodePlugin));
});

test("setup removes exact retired Claude and OpenCode automation once, then is idempotent", async () => {
  const temporary = await temporaryEnvironment("legacy-automation-cleanup");
  const pluginPath = path.join(
    temporary.config,
    "opencode",
    "plugins",
    "kiokuko-loop-guard.js",
  );
  const settingsPath = path.join(temporary.home, ".claude", "settings.json");
  const settings = `${JSON.stringify(
    {
      permissions: { allow: ["Read"] },
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "human",
            hooks: [{ type: "command", command: "echo keep" }],
          },
          { hooks: [LEGACY_CLAUDE_PROMPT_HOOK] },
        ],
      },
    },
    null,
    2,
  )}\n`;
  await mkdir(path.dirname(pluginPath), { recursive: true });
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(pluginPath, legacyOpenCodeLoopGuardFixture());
  await writeFile(settingsPath, settings);

  const first = await setupGlobalClients({
    clients: ["opencode", "claude"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });
  assert.deepEqual(
    first.files
      .filter((file) => file.purpose === "legacy-cleanup")
      .map((file) => ({ client: file.client, action: file.action })),
    [{ client: "opencode", action: "deleted" }],
  );
  assert.ok(
    first.files.some(
      (file) =>
        file.client === "claude" &&
        file.purpose === "enno-hook" &&
        file.action === "updated",
    ),
  );
  await assert.rejects(access(pluginPath));
  const cleaned = JSON.parse(await readFile(settingsPath, "utf8")) as {
    permissions: object;
    hooks: { UserPromptSubmit: unknown[]; Stop: unknown[] };
  };
  assert.deepEqual(cleaned.permissions, { allow: ["Read"] });
  assert.deepEqual(cleaned.hooks.UserPromptSubmit, [
    { matcher: "human", hooks: [{ type: "command", command: "echo keep" }] },
  ]);
  assert.equal(cleaned.hooks.Stop.length, 1);

  const second = await setupGlobalClients({
    clients: ["opencode", "claude"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });
  assert.equal(
    second.files.some((file) => file.purpose === "legacy-cleanup"),
    false,
  );
  assert.ok(second.files.every((file) => file.action === "unchanged"));
});

test("setup rejects modified retired automation before database or client writes", async () => {
  for (const client of ["opencode", "claude"] as const) {
    const temporary = await temporaryEnvironment(
      `legacy-automation-conflict-${client}`,
    );
    if (client === "opencode") {
      const pluginPath = path.join(
        temporary.config,
        "opencode",
        "plugins",
        "kiokuko-loop-guard.js",
      );
      await mkdir(path.dirname(pluginPath), { recursive: true });
      await writeFile(
        pluginPath,
        `${legacyOpenCodeLoopGuardFixture()}\n// modified\n`,
      );
    } else {
      const settingsPath = path.join(
        temporary.home,
        ".claude",
        "settings.json",
      );
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: "mcp_tool", server: "kiokuko" }] },
            ],
          },
        }),
      );
    }

    await assert.rejects(
      setupGlobalClients({
        clients: [client],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CONFLICT",
    );
    await assert.rejects(access(temporary.databasePath));
    await assert.rejects(
      access(
        client === "opencode"
          ? path.join(temporary.config, "opencode", "opencode.json")
          : path.join(temporary.home, ".claude.json"),
      ),
    );
  }
});

test("setup restores retired automation cleanup when a later write fails", async () => {
  const temporary = await temporaryEnvironment(
    "legacy-automation-cleanup-rollback",
  );
  const pluginPath = path.join(
    temporary.config,
    "opencode",
    "plugins",
    "kiokuko-loop-guard.js",
  );
  const settingsPath = path.join(temporary.home, ".claude", "settings.json");
  const plugin = legacyOpenCodeLoopGuardFixture();
  const settings = `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [LEGACY_CLAUDE_PROMPT_HOOK] }] } }, null, 2)}\n`;
  await mkdir(path.dirname(pluginPath), { recursive: true });
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(pluginPath, plugin);
  await writeFile(settingsPath, settings);
  const failure = new Error("later standard skill write failed");

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["opencode", "claude"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectedContent,
          mode,
        ) => {
          if (filePath.endsWith("SKILL.md")) throw failure;
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectedContent,
            mode,
          );
        },
      },
    ),
    (error: unknown) => error === failure,
  );

  assert.equal(await readFile(pluginPath, "utf8"), plugin);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  await assert.rejects(
    access(path.join(temporary.config, "opencode", "opencode.json")),
  );
  await assert.rejects(
    access(path.join(temporary.config, "opencode", "AGENTS.md")),
  );
  await assert.rejects(access(path.join(temporary.home, ".claude.json")));
  await assert.rejects(
    access(path.join(temporary.home, ".claude", "CLAUDE.md")),
  );
});

test("setup persists community discovery for every client and preserves it when a later batch run omits the mode", async () => {
  const temporary = await temporaryEnvironment("community-discovery");
  const first = await setupGlobalClients({
    clients: ["codex", "opencode", "claude", "hermes"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
    skillDiscoveryMode: "community",
  });
  assert.ok(first.files.every((file) => file.action === "created"));

  const codexPath = path.join(temporary.home, ".codex", "config.toml");
  const openCodePath = path.join(temporary.config, "opencode", "opencode.json");
  const claudePath = path.join(temporary.home, ".claude.json");
  const hermesPath = path.join(temporary.home, ".hermes", "config.yaml");
  assert.match(
    await readFile(codexPath, "utf8"),
    /KIOKUKO_SKILL_DISCOVERY = "community"/,
  );
  const openCode = parse(await readFile(openCodePath, "utf8")) as {
    mcp: { kiokuko: { environment: { KIOKUKO_SKILL_DISCOVERY: string } } };
  };
  assert.equal(
    openCode.mcp.kiokuko.environment.KIOKUKO_SKILL_DISCOVERY,
    "community",
  );
  const claude = JSON.parse(await readFile(claudePath, "utf8")) as {
    mcpServers: { kiokuko: { env: { KIOKUKO_SKILL_DISCOVERY: string } } };
  };
  assert.equal(
    claude.mcpServers.kiokuko.env.KIOKUKO_SKILL_DISCOVERY,
    "community",
  );
  assert.match(
    await readFile(hermesPath, "utf8"),
    /KIOKUKO_SKILL_DISCOVERY: community/,
  );

  const before = await Promise.all(
    [codexPath, openCodePath, claudePath, hermesPath].map((file) =>
      readFile(file, "utf8"),
    ),
  );
  const second = await setupGlobalClients({
    clients: ["codex", "opencode", "claude", "hermes"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });
  assert.ok(second.files.every((file) => file.action === "unchanged"));
  assert.deepEqual(
    await Promise.all(
      [codexPath, openCodePath, claudePath, hermesPath].map((file) =>
        readFile(file, "utf8"),
      ),
    ),
    before,
  );
});

test("explicit setup discovery mode outranks an invalid lower-priority environment value", async () => {
  const temporary = await temporaryEnvironment("explicit-discovery-precedence");
  const result = await runCliJson(
    "linux",
    {
      ...temporary.env,
      PATH: "",
      KIOKUKO_SKILL_DISCOVERY: "invalid-lower-priority-value",
    },
    [
      "setup",
      "--clients",
      "codex",
      "--skill-discovery",
      "community",
      "--no-standard-skills",
      "--json",
    ],
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.clients, ["codex"]);
  const config = await readFile(
    path.join(temporary.home, ".codex", "config.toml"),
    "utf8",
  );
  assert.match(config, /KIOKUKO_SKILL_DISCOVERY = "community"/u);
});

test("setup rejects an invalid explicit discovery mode before writing with no selected clients", async () => {
  const temporary = await temporaryEnvironment("invalid-explicit-discovery");

  await assert.rejects(
    setupGlobalClients({
      clients: [],
      platform: "linux",
      env: temporary.env,
      databasePath: temporary.databasePath,
      skillDiscoveryMode: "invalid" as never,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "VALIDATION_ERROR",
  );
  await assert.rejects(access(temporary.databasePath));
});

test("setup rejects a non-string command as validation before writing", async () => {
  const temporary = await temporaryEnvironment("invalid-command-type");

  await assert.rejects(
    setupGlobalClients({
      clients: [],
      platform: "linux",
      env: temporary.env,
      databasePath: temporary.databasePath,
      command: 42 as never,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "VALIDATION_ERROR",
  );
  await assert.rejects(access(temporary.databasePath));
});

test("setup rejects a non-array client selection as validation before writing", async () => {
  const temporary = await temporaryEnvironment("invalid-client-type");

  await assert.rejects(
    setupGlobalClients({
      clients: "codex" as never,
      platform: "linux",
      env: temporary.env,
      databasePath: temporary.databasePath,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "VALIDATION_ERROR",
  );
  await assert.rejects(access(temporary.databasePath));
});

test("setup rejects malformed or duplicate conflict-replacement authorization before writing", async () => {
  for (const replacementClients of ["codex", ["unknown"], ["codex", "codex"]]) {
    const temporary = await temporaryEnvironment("invalid-replacement-clients");
    await assert.rejects(
      setupGlobalClients({
        clients: [],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        replaceConflictingMcpServers: replacementClients as never,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "VALIDATION_ERROR",
    );
    await assert.rejects(access(temporary.databasePath));
  }
});

test("new Claude setup preserves existing settings while adding only the managed Stop hook", async () => {
  const temporary = await temporaryEnvironment("claude-settings-preserved");
  const claudeDirectory = path.join(temporary.home, ".claude");
  const settingsPath = path.join(claudeDirectory, "settings.json");
  const settings =
    '{"permissions":{"allow":["Bash(git status)"]},"customSetting":{"keep":true}}\n';
  await mkdir(claudeDirectory, { recursive: true });
  await writeFile(settingsPath, settings);

  const result = await setupGlobalClients({
    clients: ["claude"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });

  assert.deepEqual(result.files.map((file) => file.purpose).sort(), [
    "enno-hook",
    "instructions",
    "mcp-config",
  ]);
  const updated = JSON.parse(await readFile(settingsPath, "utf8")) as {
    permissions: object;
    customSetting: object;
    hooks: { Stop: unknown[] };
  };
  assert.deepEqual(updated.permissions, { allow: ["Bash(git status)"] });
  assert.deepEqual(updated.customSetting, { keep: true });
  assert.equal(updated.hooks.Stop.length, 1);
});

test("setup dry-run validates but writes no files or database", async () => {
  const temporary = await temporaryEnvironment("dry-run");
  const result = await setupGlobalClients({
    clients: ["codex", "opencode", "claude", "hermes"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    dryRun: true,
  });
  assert.equal(result.databaseAction, "planned");
  assert.ok(result.files.every((file) => file.action === "created"));
  for (const file of result.files) await assert.rejects(access(file.path));
  await assert.rejects(access(temporary.databasePath));
});

test("setup without detected clients initializes only the database", async () => {
  const temporary = await temporaryEnvironment("no-detected-clients");
  const result = await setupGlobalClients({
    platform: "linux",
    env: { ...temporary.env, PATH: "" },
    databasePath: temporary.databasePath,
  });

  assert.deepEqual(result.clients, []);
  assert.deepEqual(result.files, []);
  await access(result.databasePath);
  await assert.rejects(
    access(path.join(temporary.home, ".codex", "config.toml")),
  );
  await assert.rejects(
    access(path.join(temporary.config, "opencode", "opencode.json")),
  );
  await assert.rejects(access(path.join(temporary.home, ".claude.json")));
  await assert.rejects(
    access(path.join(temporary.home, ".claude", "settings.json")),
  );
  await assert.rejects(
    access(path.join(temporary.home, ".hermes", "config.yaml")),
  );
});

test("setup applies the use-managed AGENTS update to every registered live project", async () => {
  const temporary = await temporaryEnvironment("registered-project-agents");
  const staleRoot = path.join(temporary.root, "stale-project");
  const locationOnlyRoot = path.join(temporary.root, "location-only-project");
  const missingRoot = path.join(temporary.root, "missing-project");
  await mkdir(staleRoot);
  await mkdir(locationOnlyRoot);
  await mkdir(missingRoot);
  const locationOnlyGitignorePath = path.join(locationOnlyRoot, ".gitignore");
  await writeFile(locationOnlyGitignorePath, "node_modules/\r\n");

  const stale = await useRepository({
    root: staleRoot,
    allowDirectory: true,
    databasePath: temporary.databasePath,
    repositoryId: "repo_setup_refresh_stale",
    workspace: "project:setup-refresh-stale",
  });
  const staleAgentPath = path.join(stale.repositoryRoot, "AGENTS.md");
  const staleBindingPath = path.join(stale.repositoryRoot, ".kiokuko.json");
  const staleAgent = await readFile(staleAgentPath, "utf8");
  const staleBinding = JSON.parse(
    await readFile(staleBindingPath, "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    staleAgentPath,
    `human project rule\n${staleAgent.replace("kiokuko-template-version: 23", "kiokuko-template-version: 14")}`,
  );
  await writeFile(
    staleBindingPath,
    `${JSON.stringify({ ...staleBinding, templateVersion: 12 }, null, 2)}\n`,
  );

  await initializeDatabase({ databasePath: temporary.databasePath });
  const locationOnlyCanonicalRoot = await realpath(locationOnlyRoot);
  const missingCanonicalRoot = await realpath(missingRoot);
  const database = openConnection(temporary.databasePath);
  try {
    for (const location of [
      {
        repositoryId: "repo_setup_refresh_location_only",
        workspace: "project:setup-refresh-location-only",
        canonicalRoot: locationOnlyCanonicalRoot,
        displayName: "location-only-project",
      },
      {
        repositoryId: "repo_setup_refresh_missing",
        workspace: "project:setup-refresh-missing",
        canonicalRoot: missingCanonicalRoot,
        displayName: "missing-project",
      },
    ]) {
      registerRepositoryAndLocation(database, {
        ...location,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 0,
        now: "2026-08-26T00:00:00.000Z",
      });
    }
  } finally {
    database.close();
  }
  await rename(
    missingRoot,
    path.join(temporary.root, "missing-project-displaced"),
  );

  const dryRun = await setupGlobalClients({
    clients: [],
    standardSkills: false,
    databasePath: temporary.databasePath,
    platform: "linux",
    env: temporary.env,
    dryRun: true,
  });
  assert.deepEqual(
    dryRun.projectAgentFiles.map((project) => project.status),
    ["created", "skipped", "updated"],
  );
  await assert.rejects(access(path.join(locationOnlyRoot, ".kiokuko.json")));
  await assert.rejects(access(path.join(locationOnlyRoot, "AGENTS.md")));
  assert.equal(
    await readFile(locationOnlyGitignorePath, "utf8"),
    "node_modules/\r\n",
  );
  assert.match(
    await readFile(staleAgentPath, "utf8"),
    /kiokuko-template-version: 14/u,
  );

  const result = await setupGlobalClients({
    clients: [],
    standardSkills: false,
    databasePath: temporary.databasePath,
    platform: "linux",
    env: temporary.env,
  });

  assert.deepEqual(
    result.projectAgentFiles.map((project) => ({
      repositoryRoot: project.repositoryRoot,
      status: project.status,
      ...("reason" in project ? { reason: project.reason } : {}),
    })),
    [
      {
        repositoryRoot: locationOnlyCanonicalRoot,
        status: "created",
      },
      {
        repositoryRoot: stale.repositoryRoot,
        status: "updated",
      },
    ],
  );

  const afterCleanup = openConnection(temporary.databasePath);
  try {
    assert.equal(
      Number(
        afterCleanup
          .prepare(
            "SELECT COUNT(*) AS count FROM repository_locations WHERE canonical_root = ?",
          )
          .get<{ count: number }>(missingCanonicalRoot)?.count ?? 0,
      ),
      0,
    );
    assert.equal(
      Number(
        afterCleanup
          .prepare(
            "SELECT COUNT(*) AS count FROM repositories WHERE repository_id = ?",
          )
          .get<{ count: number }>("repo_setup_refresh_missing")?.count ?? 0,
      ),
      1,
    );
  } finally {
    afterCleanup.close();
  }

  const refreshedAgent = await readFile(staleAgentPath, "utf8");
  assert.match(refreshedAgent, /^human project rule\n/u);
  assert.match(refreshedAgent, /kiokuko-template-version: 23/u);
  assert.equal(refreshedAgent.includes("kiokuko-template-version: 14"), false);
  assert.equal(stale.agentFile, staleAgentPath);
  const refreshedBinding = JSON.parse(
    await readFile(staleBindingPath, "utf8"),
  ) as { templateVersion: number };
  assert.equal(refreshedBinding.templateVersion, 23);

  const locationOnlyAgent = await readFile(
    path.join(locationOnlyRoot, "AGENTS.md"),
    "utf8",
  );
  assert.match(locationOnlyAgent, /repo_setup_refresh_location_only/u);
  assert.match(locationOnlyAgent, /project:setup-refresh-location-only/u);
  const locationOnlyBinding = JSON.parse(
    await readFile(path.join(locationOnlyRoot, ".kiokuko.json"), "utf8"),
  ) as { repositoryId: string; workspace: string; templateVersion: number };
  assert.deepEqual(locationOnlyBinding, {
    schemaVersion: 1,
    repositoryId: "repo_setup_refresh_location_only",
    workspace: "project:setup-refresh-location-only",
    agentFile: "AGENTS.md",
    templateVersion: 23,
  });
  assert.equal(
    await readFile(locationOnlyGitignorePath, "utf8"),
    "node_modules/\r\n.kiokuko.json\r\n",
  );
  await assert.rejects(access(path.join(stale.repositoryRoot, ".gitignore")));
});

test("setup creates a root gitignore when it materializes a registered project binding", async () => {
  const temporary = await temporaryEnvironment("registered-project-gitignore");
  const projectRoot = path.join(temporary.root, "registered-project");
  await mkdir(projectRoot);
  await initializeDatabase({ databasePath: temporary.databasePath });
  const canonicalRoot = await realpath(projectRoot);
  const database = openConnection(temporary.databasePath);
  try {
    registerRepositoryAndLocation(database, {
      repositoryId: "repo_setup_gitignore_create",
      workspace: "project:setup-gitignore-create",
      canonicalRoot,
      displayName: "registered-project",
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 0,
      now: "2026-08-26T00:00:00.000Z",
    });
  } finally {
    database.close();
  }

  const result = await setupGlobalClients({
    clients: [],
    standardSkills: false,
    databasePath: temporary.databasePath,
    platform: "linux",
    env: temporary.env,
  });

  const project = result.projectAgentFiles[0];
  assert.ok(project !== undefined);
  assert.equal(project.status, "created");
  if (!("bindingAction" in project))
    assert.fail("setup did not materialize the registered project binding");
  assert.equal(project.bindingAction, "created");
  assert.equal(
    await readFile(path.join(canonicalRoot, ".gitignore"), "utf8"),
    ".kiokuko.json\n",
  );
});

test("setup resolves a sticky named Hermes profile without crossing into another profile", async () => {
  const temporary = await temporaryEnvironment("sticky-profile");
  const hermesRoot = path.join(temporary.root, "hermes");
  const mainProfile = path.join(hermesRoot, "profiles", "main");
  await mkdir(mainProfile, { recursive: true });
  await writeFile(path.join(hermesRoot, "active_profile"), "main\n");

  const result = await setupGlobalClients({
    clients: ["hermes"],
    platform: "linux",
    env: { ...temporary.env, HERMES_HOME: hermesRoot },
    databasePath: temporary.databasePath,
  });

  assert.deepEqual(result.files, [
    {
      path: path.join(mainProfile, "config.yaml"),
      action: "created",
      purpose: "mcp-config",
      client: "hermes",
    },
    ...standardSkillPaths(path.join(mainProfile, "skills")).map((filePath) => ({
      path: filePath,
      action: "created" as const,
      purpose: "standard-skill" as const,
      client: "hermes" as const,
    })),
  ]);
  assert.match(result.nextStep, /Hermes Agent/);
  assert.match(result.nextStep, /\/reload-mcp/);
  await access(path.join(mainProfile, "config.yaml"));
  await assert.rejects(access(path.join(hermesRoot, "config.yaml")));
  await assert.rejects(
    access(path.join(hermesRoot, "profiles", "default", "config.yaml")),
  );
});

test("setup can skip new standard-skill installation without deleting an existing skill", async () => {
  const temporary = await temporaryEnvironment("no-standard-skills");
  const skillPath = path.join(
    temporary.home,
    ".agents",
    "skills",
    "kiokuko-ui-design-soul",
    "SKILL.md",
  );
  const simpleSkillPath = path.join(
    temporary.home,
    ".agents",
    "skills",
    "kiokuko-simple-work",
    "SKILL.md",
  );
  const functionSkillPath = path.join(
    temporary.home,
    ".agents",
    "skills",
    "kiokuko-single-purpose-functions",
    "SKILL.md",
  );
  const ennoSkillPath = path.join(
    temporary.home,
    ".agents",
    "skills",
    "kiokuko-enno-oduno",
    "SKILL.md",
  );
  const memorySkillPath = path.join(
    temporary.home,
    ".agents",
    "skills",
    "memory-reasoning",
    "SKILL.md",
  );
  const soulSkillPath = path.join(
    temporary.home,
    ".agents",
    "skills",
    "kiokuko-soul",
    "SKILL.md",
  );
  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(path.dirname(simpleSkillPath), { recursive: true });
  await mkdir(path.dirname(functionSkillPath), { recursive: true });
  await mkdir(path.dirname(ennoSkillPath), { recursive: true });
  await mkdir(path.dirname(memorySkillPath), { recursive: true });
  await mkdir(path.dirname(soulSkillPath), { recursive: true });
  await writeFile(skillPath, "human-owned skill\n");
  await writeFile(simpleSkillPath, "human-owned simple skill\n");
  await writeFile(functionSkillPath, "human-owned function skill\n");
  await writeFile(ennoSkillPath, "human-owned Enno skill\n");
  await writeFile(memorySkillPath, "human-owned memory skill\n");
  await writeFile(soulSkillPath, "human-owned SOUL skill\n");

  const result = await setupGlobalClients({
    clients: ["codex"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });

  assert.equal(result.standardSkills, false);
  assert.equal(
    result.files.some((file) => file.purpose === "standard-skill"),
    false,
  );
  assert.equal(await readFile(skillPath, "utf8"), "human-owned skill\n");
  assert.equal(
    await readFile(simpleSkillPath, "utf8"),
    "human-owned simple skill\n",
  );
  assert.equal(
    await readFile(functionSkillPath, "utf8"),
    "human-owned function skill\n",
  );
  assert.equal(
    await readFile(ennoSkillPath, "utf8"),
    "human-owned Enno skill\n",
  );
  assert.equal(
    await readFile(memorySkillPath, "utf8"),
    "human-owned memory skill\n",
  );
  assert.equal(
    await readFile(soulSkillPath, "utf8"),
    "human-owned SOUL skill\n",
  );
});

test("setup upgrades an older managed standard skill and then reports it unchanged", async () => {
  const temporary = await temporaryEnvironment("managed-skill-upgrade");
  const skillDirectory = path.join(
    temporary.home,
    ".agents",
    "skills",
    "kiokuko-ui-design-soul",
  );
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const checklistPath = path.join(
    skillDirectory,
    "references",
    "ui-checklist.md",
  );
  const functionSkillDirectory = path.join(
    temporary.home,
    ".agents",
    "skills",
    "kiokuko-single-purpose-functions",
  );
  const functionSkillPath = path.join(functionSkillDirectory, "SKILL.md");
  const modelingPath = path.join(
    functionSkillDirectory,
    "references",
    "problem-shaping-and-language.md",
  );
  const marker =
    "<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->";
  const functionMarker =
    "<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->";
  await mkdir(path.dirname(checklistPath), { recursive: true });
  await mkdir(functionSkillDirectory, { recursive: true });
  await writeFile(
    skillPath,
    `---\nname: kiokuko-ui-design-soul\ndescription: old\n---\n\n${marker}\nold\n`,
  );
  await writeFile(checklistPath, `${marker}\nold checklist\n`);
  await writeFile(
    functionSkillPath,
    `---\nname: kiokuko-single-purpose-functions\ndescription: old\n---\n\n${functionMarker}\nold\n`,
  );

  const first = await setupGlobalClients({
    clients: ["codex"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
  });
  const standardSkillActions = first.files
    .filter((file) => file.purpose === "standard-skill")
    .map((file) => file.action);
  assert.equal(
    standardSkillActions.filter((action) => action === "updated").length,
    3,
  );
  assert.equal(
    standardSkillActions.filter((action) => action === "created").length,
    standardSkillPaths("ignored").length - 3,
  );
  assert.match(
    await readFile(skillPath, "utf8"),
    /description: Prevent common UI and UX failures/,
  );
  assert.match(await readFile(checklistPath, "utf8"), /Eight-principle map/);
  assert.match(
    await readFile(functionSkillPath, "utf8"),
    /problem-shaping contracts/,
  );
  assert.match(await readFile(modelingPath, "utf8"), /code\.modeling\.v1/u);
  assert.match(
    await readFile(
      path.join(
        temporary.home,
        ".agents",
        "skills",
        "kiokuko-enno-oduno",
        "SKILL.md",
      ),
      "utf8",
    ),
    /Enno-Oduno alone owns this state machine/,
  );
  assert.match(
    await readFile(
      path.join(
        temporary.home,
        ".agents",
        "skills",
        "kiokuko-soul",
        "SKILL.md",
      ),
      "utf8",
    ),
    /mandatory first-read SOUL router/,
  );
  assert.match(
    await readFile(
      path.join(
        temporary.home,
        ".agents",
        "skills",
        "memory-reasoning",
        "SKILL.md",
      ),
      "utf8",
    ),
    /source of testable hypotheses/,
  );

  const second = await setupGlobalClients({
    clients: ["codex"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
  });
  assert.ok(second.files.every((file) => file.action === "unchanged"));
});

test("setup fails closed on every unmanaged same-name standard skill before any write", async () => {
  for (const fixture of STANDARD_SKILL_FIXTURES) {
    const temporary = await temporaryEnvironment(
      `unmanaged-skill-conflict-${fixture.name}`,
    );
    const skillPath = path.join(
      temporary.home,
      ".agents",
      "skills",
      fixture.name,
      "SKILL.md",
    );
    const original = `---\nname: ${fixture.name}\n---\nhuman-owned\n`;
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, original);

    await assert.rejects(
      setupGlobalClients({
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "CONFLICT" &&
        error.message.includes(skillPath) &&
        /back up or rename.*rerun kiokuko setup/u.test(error.message),
    );

    assert.equal(await readFile(skillPath, "utf8"), original);
    await assert.rejects(
      access(path.join(temporary.home, ".codex", "config.toml")),
    );
    await assert.rejects(access(temporary.databasePath));
  }
});

test("setup only installs the standard skill for selected clients", async () => {
  const temporary = await temporaryEnvironment("selected-client");
  const result = await setupGlobalClients({
    clients: ["opencode"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
  });
  const openCodeSkills = path.join(temporary.config, "opencode", "skills");
  assert.equal(
    result.files.filter((file) => file.purpose === "standard-skill").length,
    standardSkillPaths(openCodeSkills).length,
  );
  for (const filePath of standardSkillPaths(openCodeSkills))
    await access(filePath);
  for (const otherSkillsDirectory of [
    path.join(temporary.home, ".agents", "skills"),
    path.join(temporary.home, ".claude", "skills"),
    path.join(temporary.home, ".hermes", "skills"),
  ]) {
    for (const fixture of STANDARD_SKILL_FIXTURES) {
      await assert.rejects(
        access(path.join(otherSkillsDirectory, fixture.name, "SKILL.md")),
      );
    }
  }
});

test(
  "setup rolls back earlier client and skill files when a later standard-skill write fails",
  { skip: process.platform === "win32" },
  async () => {
    const temporary = await temporaryEnvironment("skill-rollback");
    const skillsDirectory = path.join(temporary.home, ".agents", "skills");
    const referencesDirectory = path.join(
      skillsDirectory,
      "kiokuko-single-purpose-functions",
      "references",
    );
    await mkdir(referencesDirectory, { recursive: true });
    await chmod(referencesDirectory, 0o500);
    try {
      await assert.rejects(
        setupGlobalClients({
          clients: ["codex"],
          platform: "linux",
          env: temporary.env,
          databasePath: temporary.databasePath,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PARTIAL_FAILURE",
      );
    } finally {
      await chmod(referencesDirectory, 0o700);
    }

    await assert.rejects(
      access(path.join(temporary.home, ".codex", "config.toml")),
    );
    await assert.rejects(
      access(path.join(temporary.home, ".codex", "AGENTS.md")),
    );
    for (const filePath of standardSkillPaths(skillsDirectory))
      await assert.rejects(access(filePath));
  },
);

test(
  "setup rolls back Claude MCP and instructions when a later standard-skill write fails",
  { skip: process.platform === "win32" },
  async () => {
    const temporary = await temporaryEnvironment("claude-setup-rollback");
    const settingsPath = path.join(temporary.home, ".claude", "settings.json");
    const settings = '{"permissions":{"allow":["Bash(git status)"]}}\n';
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, settings);
    const skillsDirectory = path.join(temporary.home, ".claude", "skills");
    const referencesDirectory = path.join(
      skillsDirectory,
      "kiokuko-single-purpose-functions",
      "references",
    );
    await mkdir(referencesDirectory, { recursive: true });
    await chmod(referencesDirectory, 0o500);
    try {
      await assert.rejects(
        setupGlobalClients({
          clients: ["claude"],
          platform: "linux",
          env: temporary.env,
          databasePath: temporary.databasePath,
        }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PARTIAL_FAILURE",
      );
    } finally {
      await chmod(referencesDirectory, 0o700);
    }

    assert.equal(await readFile(settingsPath, "utf8"), settings);
    await assert.rejects(access(path.join(temporary.home, ".claude.json")));
    await assert.rejects(
      access(path.join(temporary.home, ".claude", "CLAUDE.md")),
    );
    for (const filePath of standardSkillPaths(skillsDirectory))
      await assert.rejects(access(filePath));
  },
);

test("setup exposes the initiating failure and every failed restore after attempting them all", async () => {
  const temporary = await temporaryEnvironment("restore-failures");
  const initiatingFailure = new Error("initiating-write-sensitive-detail");
  const agentRestoreFailure = new Error("agent-restore-sensitive-detail");
  const configRestoreFailure = new Error("config-restore-sensitive-detail");
  const restoreAttempts: string[] = [];

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["opencode"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectedContent,
          mode,
        ) => {
          if (filePath.endsWith("SKILL.md")) throw initiatingFailure;
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectedContent,
            mode,
          );
        },
        unlinkRegularFileIfUnchanged: async (filePath) => {
          const restoredPath = String(filePath);
          restoreAttempts.push(restoredPath);
          if (restoredPath.endsWith("AGENTS.md")) throw agentRestoreFailure;
          throw configRestoreFailure;
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Setup failed and filesystem restoration also failed",
      );
      assert.doesNotMatch(error.message, /sensitive|opencode/u);
      assert.equal(error.errors[0], initiatingFailure);
      assert.equal(error.errors[1], agentRestoreFailure);
      assert.equal(error.errors[2], configRestoreFailure);
      assert.equal(error.errors[3], configRestoreFailure);
      return true;
    },
  );

  assert.deepEqual(
    restoreAttempts.map((filePath) => path.basename(filePath)),
    ["AGENTS.md", "kiokuko-enno-oduno.js", "opencode.json"],
  );
});

test("setup preserves a file concurrently created after planning and fails with conflict", async () => {
  const temporary = await temporaryEnvironment("forward-create-cas");
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  const concurrent = "human concurrent config\n";
  let injected = false;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectedContent,
          mode,
        ) => {
          if (!injected && filePath === configPath) {
            injected = true;
            await mkdir(path.dirname(configPath), { recursive: true });
            await writeFile(configPath, concurrent);
          }
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectedContent,
            mode,
          );
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Setup failed and filesystem restoration also failed",
      );
      assert.equal(error.errors.length, 2);
      assert.equal(
        error.errors[0] instanceof Error &&
          "code" in error.errors[0] &&
          error.errors[0].code,
        "CONFLICT",
      );
      assert.equal(
        error.errors[1] instanceof Error &&
          "code" in error.errors[1] &&
          error.errors[1].code,
        "ENOTEMPTY",
      );
      return true;
    },
  );

  assert.equal(injected, true);
  assert.equal(await readFile(configPath, "utf8"), concurrent);
  await assert.rejects(
    access(path.join(temporary.home, ".codex", "AGENTS.md")),
  );
});

test("setup preserves a concurrent edit made before an update commit", async () => {
  const temporary = await temporaryEnvironment("forward-edit-cas");
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  await setupGlobalClients({
    clients: ["codex"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });
  const concurrent = "human concurrent replacement\n";
  let injected = false;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        command: "/new/kiokuko",
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectedContent,
          mode,
        ) => {
          if (!injected && filePath === configPath) {
            injected = true;
            await writeFile(configPath, concurrent);
          }
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectedContent,
            mode,
          );
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFLICT",
  );

  assert.equal(injected, true);
  assert.equal(await readFile(configPath, "utf8"), concurrent);
});

test("setup rejects a replaced parent even when every planned child keeps its exact inode", async () => {
  const temporary = await temporaryEnvironment("parent-swap-exact-children");
  const codexDirectory = path.join(temporary.home, ".codex");
  const displacedDirectory = path.join(temporary.home, ".codex.displaced");
  const configPath = path.join(codexDirectory, "config.toml");
  const instructionsPath = path.join(codexDirectory, "AGENTS.md");
  await setupGlobalClients({
    clients: ["codex"],
    command: "/old/kiokuko",
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });
  const originalConfig = await readFile(configPath, "utf8");
  const originalInstructions = await readFile(instructionsPath, "utf8");
  const originalParent = await lstat(codexDirectory, { bigint: true });

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        command: "/new/kiokuko",
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        beforeCommit: async () => {
          await rename(codexDirectory, displacedDirectory);
          await mkdir(codexDirectory);
          await link(path.join(displacedDirectory, "config.toml"), configPath);
          await link(
            path.join(displacedDirectory, "AGENTS.md"),
            instructionsPath,
          );
          await writeFile(
            path.join(displacedDirectory, "human-sentinel"),
            "untouched\n",
          );
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFLICT",
  );

  const replacementParent = await lstat(codexDirectory, { bigint: true });
  assert.notEqual(replacementParent.ino, originalParent.ino);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  assert.equal(await readFile(instructionsPath, "utf8"), originalInstructions);
  assert.equal(
    await readFile(path.join(displacedDirectory, "config.toml"), "utf8"),
    originalConfig,
  );
  assert.equal(
    await readFile(path.join(displacedDirectory, "AGENTS.md"), "utf8"),
    originalInstructions,
  );
  assert.equal(
    await readFile(path.join(displacedDirectory, "human-sentinel"), "utf8"),
    "untouched\n",
  );
  assert.doesNotMatch(originalConfig, /\/new\/kiokuko/u);
});

test("setup never adopts a parent directory that was absent during planning", async () => {
  const temporary = await temporaryEnvironment("parent-create-only");
  const codexDirectory = path.join(temporary.home, ".codex");
  const sentinelPath = path.join(codexDirectory, "human-sentinel");

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        beforeCommit: async () => {
          await mkdir(codexDirectory);
          await writeFile(sentinelPath, "human-owned\n");
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFLICT",
  );

  assert.equal(await readFile(sentinelPath, "utf8"), "human-owned\n");
  await assert.rejects(access(path.join(codexDirectory, "config.toml")));
  await assert.rejects(access(path.join(codexDirectory, "AGENTS.md")));
});

test("setup never adopts a nested skill directory chain that was absent during planning", async () => {
  const temporary = await temporaryEnvironment("nested-parent-create-only");
  const skillDirectory = path.join(
    temporary.home,
    ".agents",
    "skills",
    "kiokuko-ui-design-soul",
  );
  const referencesDirectory = path.join(skillDirectory, "references");
  const sentinelPath = path.join(referencesDirectory, "human-sentinel");
  await setupGlobalClients({
    clients: ["codex"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
      },
      {
        beforeCommit: async () => {
          await mkdir(referencesDirectory, { recursive: true });
          await writeFile(sentinelPath, "human-owned\n");
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFLICT",
  );

  assert.equal(await readFile(sentinelPath, "utf8"), "human-owned\n");
  await assert.rejects(access(path.join(skillDirectory, "SKILL.md")));
  await assert.rejects(
    access(path.join(referencesDirectory, "ui-checklist.md")),
  );
});

test("setup binds a newly created parent into the first write and never follows a replacement", async () => {
  const temporary = await temporaryEnvironment("created-parent-swap");
  const codexDirectory = path.join(temporary.home, ".codex");
  const displacedDirectory = path.join(temporary.home, ".codex.displaced");
  const sentinelPath = path.join(codexDirectory, "human-sentinel");
  let expectedParentInode: bigint | undefined;
  let injected = false;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectation,
          mode,
        ) => {
          if (!injected) {
            injected = true;
            expectedParentInode = expectation.expectedParentDirectory?.inode;
            await rename(codexDirectory, displacedDirectory);
            await mkdir(codexDirectory);
            await writeFile(sentinelPath, "human-owned\n");
          }
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectation,
            mode,
          );
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Setup failed and filesystem restoration also failed",
      );
      assert.equal(error.errors.length, 2);
      assert.equal(
        error.errors[0] instanceof Error &&
          "code" in error.errors[0] &&
          error.errors[0].code,
        "CONFLICT",
      );
      assert.equal(
        error.errors[1] instanceof Error &&
          "code" in error.errors[1] &&
          error.errors[1].code,
        "CONFLICT",
      );
      return true;
    },
  );

  assert.equal(injected, true);
  const displaced = await lstat(displacedDirectory, { bigint: true });
  assert.equal(expectedParentInode, displaced.ino);
  assert.equal(await readFile(sentinelPath, "utf8"), "human-owned\n");
  await assert.rejects(access(path.join(codexDirectory, "config.toml")));
  await assert.rejects(access(path.join(displacedDirectory, "config.toml")));
});

test("setup restores the original after an update quarantine commits and its post-rename hook fails", async () => {
  const temporary = await temporaryEnvironment("write-quarantine-committed");
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  await setupGlobalClients({
    clients: ["codex"],
    command: "/old/kiokuko",
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });
  const original = await readFile(configPath, "utf8");
  const sentinel = new Error("post-rename hook failed after update quarantine");
  let injected = false;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        command: "/new/kiokuko",
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectation,
          mode,
        ) => {
          if (!injected && filePath === configPath) {
            injected = true;
            return atomicWriteTextIfUnchanged(
              filePath,
              content,
              expectation,
              mode,
              {
                afterRename: async (_source, destination) => {
                  if (destination.endsWith(".previous")) {
                    throw sentinel;
                  }
                },
              },
            );
          }
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectation,
            mode,
          );
        },
      },
    ),
    (error: unknown) =>
      error instanceof AtomicCommittedUnlinkError &&
      error.operationError === sentinel,
  );

  assert.equal(injected, true);
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /\/new\/kiokuko/u);
});

test("setup rollback does not delete a newly installed file after a concurrent edit", async () => {
  const temporary = await temporaryEnvironment("rollback-edit-cas");
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  const instructionsPath = path.join(temporary.home, ".codex", "AGENTS.md");
  const concurrent = "human edit after setup write\n";
  const laterFailure = new Error("later setup write failed");

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectedContent,
          mode,
        ) => {
          if (filePath === instructionsPath) {
            await writeFile(configPath, concurrent);
            throw laterFailure;
          }
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectedContent,
            mode,
          );
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Setup failed and filesystem restoration also failed",
      );
      assert.equal(error.errors[0], laterFailure);
      assert.equal(error.errors.length, 3);
      assert.equal(
        error.errors[1] instanceof Error &&
          "code" in error.errors[1] &&
          error.errors[1].code,
        "CONFLICT",
      );
      assert.equal(
        error.errors[2] instanceof Error &&
          "code" in error.errors[2] &&
          error.errors[2].code,
        "ENOTEMPTY",
      );
      return true;
    },
  );

  assert.equal(await readFile(configPath, "utf8"), concurrent);
  await assert.rejects(access(instructionsPath));
});

test("a profile-shaped HERMES_HOME wins over the sticky root profile", async () => {
  const temporary = await temporaryEnvironment("profile-home");
  const hermesRoot = path.join(temporary.root, "hermes");
  const profileHome = path.join(hermesRoot, "profiles", "main");
  await mkdir(profileHome, { recursive: true });
  await writeFile(path.join(hermesRoot, "active_profile"), "other\n");

  const result = await setupGlobalClients({
    clients: ["hermes"],
    platform: "linux",
    env: { ...temporary.env, HERMES_HOME: profileHome },
    databasePath: temporary.databasePath,
  });

  assert.equal(result.files[0]?.path, path.join(profileHome, "config.yaml"));
  await access(path.join(profileHome, "config.yaml"));
  await assert.rejects(
    access(path.join(hermesRoot, "profiles", "other", "config.yaml")),
  );
});

test("a missing sticky Hermes profile is a fixed validation error", async () => {
  const temporary = await temporaryEnvironment("missing-profile");
  const hermesRoot = path.join(temporary.root, "hermes");
  await mkdir(hermesRoot, { recursive: true });
  await writeFile(path.join(hermesRoot, "active_profile"), "missing\n");

  await assert.rejects(
    setupGlobalClients({
      clients: ["hermes"],
      platform: "linux",
      env: { ...temporary.env, HERMES_HOME: hermesRoot },
      databasePath: temporary.databasePath,
    }),
    (error: unknown) => {
      assert.equal(
        error instanceof Error &&
          "code" in error &&
          error.code === "VALIDATION_ERROR",
        true,
      );
      assert.equal(
        error instanceof Error && error.message.includes("missing"),
        false,
      );
      return true;
    },
  );
  await assert.rejects(access(temporary.databasePath));
});

test("malformed sticky Hermes profile content is rejected without echoing it", async () => {
  for (const sentinel of ["../profile-secret", "Main", "a".repeat(65)]) {
    const temporary = await temporaryEnvironment("malformed-profile");
    const hermesRoot = path.join(temporary.root, "hermes");
    await mkdir(path.join(hermesRoot, "profiles", sentinel), {
      recursive: true,
    });
    await writeFile(path.join(hermesRoot, "active_profile"), sentinel);

    await assert.rejects(
      setupGlobalClients({
        clients: ["hermes"],
        platform: "linux",
        env: { ...temporary.env, HERMES_HOME: hermesRoot },
        databasePath: temporary.databasePath,
      }),
      (error: unknown) => {
        assert.equal(
          error instanceof Error &&
            "code" in error &&
            error.code === "VALIDATION_ERROR",
          true,
        );
        assert.equal(
          error instanceof Error && error.message.includes(sentinel),
          false,
        );
        assert.equal(
          error instanceof Error && error.message.includes(hermesRoot),
          false,
        );
        return true;
      },
    );
    await assert.rejects(access(temporary.databasePath));
  }
});

test("a Hermes conflict plans no database or other client writes", async () => {
  const temporary = await temporaryEnvironment("hermes-conflict");
  const hermesHome = path.join(temporary.root, "hermes");
  const codexDirectory = path.join(temporary.home, ".codex");
  const codexPath = path.join(codexDirectory, "config.toml");
  await mkdir(hermesHome, { recursive: true });
  await mkdir(codexDirectory, { recursive: true });
  const originalHermes =
    "mcp_servers:\n  kiokuko:\n    command: human-tool\n    args: [mcp]\n";
  await writeFile(path.join(hermesHome, "config.yaml"), originalHermes);
  const originalCodex = 'model = "human"\n';
  await writeFile(codexPath, originalCodex);

  await assert.rejects(
    setupGlobalClients({
      clients: ["hermes", "codex"],
      platform: "linux",
      env: { ...temporary.env, HERMES_HOME: hermesHome },
      databasePath: temporary.databasePath,
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFLICT",
  );

  assert.equal(await readFile(codexPath, "utf8"), originalCodex);
  assert.equal(
    await readFile(path.join(hermesHome, "config.yaml"), "utf8"),
    originalHermes,
  );
  await assert.rejects(access(temporary.databasePath));
});

test("semantically invalid Codex TOML fails before any setup mutation", async () => {
  const temporary = await temporaryEnvironment("invalid-codex-toml");
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  const original = "a = 1\n[a]\nb = 2\n";
  await writeFile(configPath, original);

  await assert.rejects(
    setupGlobalClients({
      clients: ["codex", "opencode"],
      platform: "linux",
      env: temporary.env,
      databasePath: temporary.databasePath,
      standardSkills: false,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "VALIDATION_ERROR",
  );

  assert.equal(await readFile(configPath, "utf8"), original);
  await assert.rejects(
    access(path.join(temporary.config, "opencode", "opencode.json")),
  );
  await assert.rejects(access(temporary.databasePath));
});

test("setup refuses an unmanaged Codex kiokuko table before writing anything", async () => {
  const temporary = await temporaryEnvironment("conflict");
  const codexDirectory = path.join(temporary.home, ".codex");
  await mkdir(codexDirectory, { recursive: true });
  const configPath = path.join(codexDirectory, "config.toml");
  const original = '[mcp_servers.kiokuko]\ncommand = "custom"\n';
  await writeFile(configPath, original);
  await assert.rejects(
    setupGlobalClients({
      clients: ["codex"],
      platform: "linux",
      env: temporary.env,
      databasePath: temporary.databasePath,
    }),
    /unmanaged/,
  );
  assert.equal(await readFile(configPath, "utf8"), original);
  await assert.rejects(access(temporary.databasePath));
});

test("setup upgrades the exact previous Codex block to required MCP", async () => {
  const temporary = await temporaryEnvironment("codex-required-upgrade");
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  const previous = [
    'model = "human"',
    "# BEGIN KIOKUKO MCP",
    "# Managed by `kiokuko setup`.",
    "[mcp_servers.kiokuko]",
    'command = "kiokuko"',
    'args = ["mcp"]',
    "enabled = true",
    'env = { KIOKUKO_SKILL_DISCOVERY = "official" }',
    "# END KIOKUKO MCP",
    "",
  ].join("\n");
  await writeFile(configPath, previous);

  await setupGlobalClients({
    clients: ["codex"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });

  const upgraded = await readFile(configPath, "utf8");
  assert.match(upgraded, /^model = "human"$/mu);
  assert.match(upgraded, /^required = true$/mu);
  assert.equal((upgraded.match(/# BEGIN KIOKUKO MCP/gu) ?? []).length, 1);
});

test("setup refuses incomplete or tampered marked Codex blocks without rewriting them", async () => {
  const variants = [
    [
      'model = "human"',
      "# BEGIN KIOKUKO MCP",
      "# Managed by `kiokuko setup`.",
      "[mcp_servers.kiokuko]",
      'command = "kiokuko"',
      'args = ["mcp"]',
      "enabled = true",
      "# END KIOKUKO MCP",
      "",
    ].join("\n"),
    [
      'model = "human"',
      "# BEGIN KIOKUKO MCP",
      "# copied markers around a human wrapper",
      "[mcp_servers.kiokuko]",
      'command = "human-wrapper"',
      'args = ["run", "kiokuko"]',
      "enabled = true",
      'env = { KIOKUKO_SKILL_DISCOVERY = "official" }',
      "# END KIOKUKO MCP",
      "",
    ].join("\n"),
  ];

  for (const [index, original] of variants.entries()) {
    const temporary = await temporaryEnvironment(
      `codex-marked-conflict-${index}`,
    );
    const configPath = path.join(temporary.home, ".codex", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, original);

    await assert.rejects(
      setupGlobalClients({
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CONFLICT",
    );

    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(
      access(path.join(temporary.home, ".codex", "AGENTS.md")),
    );
    await assert.rejects(access(temporary.databasePath));
  }
});

test("setup refuses modified OpenCode and Claude kiokuko servers before writing anything", async () => {
  for (const client of ["opencode", "claude"] as const) {
    const temporary = await temporaryEnvironment(`${client}-mcp-conflict`);
    const codexDirectory = path.join(temporary.home, ".codex");
    const codexPath = path.join(codexDirectory, "config.toml");
    await mkdir(codexDirectory, { recursive: true });
    const originalCodex = 'model = "human"\n';
    await writeFile(codexPath, originalCodex);

    const configPath =
      client === "opencode"
        ? path.join(temporary.config, "opencode", "opencode.json")
        : path.join(temporary.home, ".claude.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    const originalClient =
      client === "opencode"
        ? '{"theme":"human","mcp":{"kiokuko":{"type":"local","command":["kiokuko","mcp"],"enabled":true,"environment":{"KIOKUKO_SKILL_DISCOVERY":"official","PATH":"/human"}}}}\n'
        : '{"theme":"human","mcpServers":{"kiokuko":{"type":"stdio","command":"kiokuko","args":["mcp"],"env":{"KIOKUKO_SKILL_DISCOVERY":"official","PATH":"/human"}}}}\n';
    await writeFile(configPath, originalClient);

    await assert.rejects(
      setupGlobalClients({
        clients: ["codex", client],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CONFLICT",
    );

    assert.equal(await readFile(codexPath, "utf8"), originalCodex);
    assert.equal(await readFile(configPath, "utf8"), originalClient);
    await assert.rejects(access(temporary.databasePath));
  }
});

test(
  "setup rejects a dangling preferred OpenCode JSONC entry instead of falling back to JSON",
  { skip: process.platform === "win32" },
  async () => {
    const temporary = await temporaryEnvironment("opencode-dangling-jsonc");
    const directory = path.join(temporary.config, "opencode");
    const jsonc = path.join(directory, "opencode.jsonc");
    await mkdir(directory, { recursive: true });
    await symlink(path.join(directory, "missing.jsonc"), jsonc);

    await assert.rejects(
      setupGlobalClients({
        clients: ["opencode"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "SECURITY_REJECTION",
    );
    await assert.rejects(access(path.join(directory, "opencode.json")));
    await assert.rejects(access(temporary.databasePath));
  },
);

test("setup binds OpenCode alternate-path absence through commit", async () => {
  const temporary = await temporaryEnvironment("opencode-alternate-race");
  const directory = path.join(temporary.config, "opencode");
  const jsonc = path.join(directory, "opencode.jsonc");
  const json = path.join(directory, "opencode.json");

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["opencode"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        beforeCommit: async () => {
          await mkdir(directory, { recursive: true });
          await writeFile(jsonc, "{}\n");
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFLICT",
  );

  assert.equal(await readFile(jsonc, "utf8"), "{}\n");
  await assert.rejects(access(json));
});

test("setup revalidates unchanged targets by identity before committing", async () => {
  const temporary = await temporaryEnvironment("unchanged-identity-race");
  await setupGlobalClients({
    clients: ["codex"],
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  const displaced = path.join(temporary.home, ".codex", "config.previous");
  const identical = await readFile(configPath, "utf8");

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        beforeCommit: async () => {
          await rename(configPath, displaced);
          await writeFile(configPath, identical);
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFLICT",
  );

  assert.equal(await readFile(configPath, "utf8"), identical);
});

test("setup commit detects a retired artifact that appears after an absent cleanup plan", async () => {
  const temporary = await temporaryEnvironment("retired-artifact-race");
  const pluginPath = path.join(
    temporary.config,
    "opencode",
    "plugins",
    "kiokuko-loop-guard.js",
  );
  const plugin = legacyOpenCodeLoopGuardFixture();

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["opencode"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        beforeCommit: async () => {
          await mkdir(path.dirname(pluginPath), { recursive: true });
          await writeFile(pluginPath, plugin);
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CONFLICT",
  );

  assert.equal(await readFile(pluginPath, "utf8"), plugin);
  await assert.rejects(
    access(path.join(temporary.config, "opencode", "opencode.json")),
  );
});

test("setup resolves the Hermes profile once for config and standard-skill destinations", async () => {
  const temporary = await temporaryEnvironment("hermes-single-resolution");
  const bin = path.join(temporary.root, "bin");
  const profile = path.join(temporary.home, ".hermes", "profiles", "bound");
  const countPath = path.join(temporary.root, "hermes-count");
  await mkdir(bin, { recursive: true });
  await mkdir(profile, { recursive: true });
  const executable = path.join(bin, "hermes");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf "x\\n" >> "$HERMES_COUNT"\nprintf "%s\\n" "$HERMES_CONFIG_PATH"\n',
  );
  await chmod(executable, 0o755);

  await setupGlobalClients({
    clients: ["hermes"],
    platform: "linux",
    env: {
      ...temporary.env,
      PATH: bin,
      HERMES_COUNT: countPath,
      HERMES_CONFIG_PATH: path.join(profile, "config.yaml"),
    },
    databasePath: temporary.databasePath,
  });

  assert.equal(await readFile(countPath, "utf8"), "x\n");
  await access(path.join(profile, "config.yaml"));
  await access(
    path.join(profile, "skills", "kiokuko-ui-design-soul", "SKILL.md"),
  );
  await access(
    path.join(
      profile,
      "skills",
      "kiokuko-single-purpose-functions",
      "SKILL.md",
    ),
  );
  await access(path.join(profile, "skills", "kiokuko-enno-oduno", "SKILL.md"));
});

test("setup rejects invalid UTF-8 managed text before database mutation", async () => {
  const temporary = await temporaryEnvironment("invalid-utf8");
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, Buffer.from([0xc3, 0x28]));

  await assert.rejects(
    setupGlobalClients({
      clients: ["codex"],
      platform: "linux",
      env: temporary.env,
      databasePath: temporary.databasePath,
      standardSkills: false,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "VALIDATION_ERROR",
  );
  await assert.rejects(access(temporary.databasePath));
});

test("setup compensates a committed file and exposes post-commit cleanup failure", async () => {
  const temporary = await temporaryEnvironment("cleanup-partial-commit");
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  let injected = false;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectation,
          mode,
        ) => {
          if (!injected) {
            injected = true;
            return atomicWriteTextIfUnchanged(
              filePath,
              content,
              expectation,
              mode,
              {
                beforeCleanup: async () => {
                  throw new Error("cleanup-sentinel");
                },
              },
            );
          }
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectation,
            mode,
          );
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Setup failed and filesystem restoration also failed",
      );
      assert.equal(error.errors.length, 2);
      assert.ok(error.errors[0] instanceof AggregateError);
      assert.equal(
        error.errors[0].message,
        "File mutation committed, but committed-artifact cleanup failed",
      );
      assert.equal(
        error.errors[1] instanceof Error &&
          "code" in error.errors[1] &&
          error.errors[1].code,
        "ENOTEMPTY",
      );
      return true;
    },
  );

  assert.equal(injected, true);
  await assert.rejects(access(configPath));
  await assert.rejects(
    access(path.join(temporary.home, ".codex", "AGENTS.md")),
  );
});

test("setup compensates a target committed before post-install validation fails", async () => {
  const temporary = await temporaryEnvironment("post-install-partial-commit");
  const configPath = path.join(temporary.home, ".codex", "config.toml");
  const sentinel = new Error("post-install-sentinel");
  let injected = false;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["codex"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectation,
          mode,
        ) => {
          if (!injected) {
            injected = true;
            return atomicWriteTextIfUnchanged(
              filePath,
              content,
              expectation,
              mode,
              {
                afterInstall: async () => {
                  throw sentinel;
                },
              },
            );
          }
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectation,
            mode,
          );
        },
      },
    ),
    (error: unknown) =>
      error instanceof AtomicCommittedMutationError &&
      error.operationError === sentinel,
  );

  await assert.rejects(access(configPath));
  await assert.rejects(
    access(path.join(temporary.home, ".codex", "AGENTS.md")),
  );
});

test("setup compensates a create whose alternate-conflict rollback rename fails", async () => {
  const temporary = await temporaryEnvironment(
    "alternate-rollback-committed-create",
  );
  const configDirectory = path.join(temporary.config, "opencode");
  const configPath = path.join(configDirectory, "opencode.json");
  const alternatePath = path.join(configDirectory, "opencode.jsonc");
  const sentinel = new Error("installed-target rollback rename failed");
  let injected = false;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["opencode"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectation,
          mode,
        ) => {
          if (!injected && filePath === configPath) {
            injected = true;
            return atomicWriteTextIfUnchanged(
              filePath,
              content,
              expectation,
              mode,
              {
                afterInstall: async () =>
                  writeFile(alternatePath, '{"concurrent":true}\n'),
                beforeRename: async (_source, destination) => {
                  if (destination.endsWith(".rollback")) {
                    throw sentinel;
                  }
                },
              },
            );
          }
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectation,
            mode,
          );
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "Setup failed and filesystem restoration also failed",
      );
      assert.ok(error.errors[0] instanceof AtomicCommittedMutationError);
      assert.ok(error.errors[0].operationError instanceof AggregateError);
      assert.equal(
        error.errors[0].operationError.errors.includes(sentinel),
        true,
      );
      return true;
    },
  );

  assert.equal(injected, true);
  await assert.rejects(access(configPath));
  assert.equal(await readFile(alternatePath, "utf8"), '{"concurrent":true}\n');
  await assert.rejects(access(path.join(configDirectory, "AGENTS.md")));
  assert.deepEqual(await readdir(configDirectory), ["opencode.jsonc"]);
});

test("setup restores an update whose alternate-conflict rollback rename fails", async () => {
  const temporary = await temporaryEnvironment(
    "alternate-rollback-committed-update",
  );
  const configDirectory = path.join(temporary.config, "opencode");
  const configPath = path.join(configDirectory, "opencode.json");
  const alternatePath = path.join(configDirectory, "opencode.jsonc");
  await setupGlobalClients({
    clients: ["opencode"],
    command: "/old/kiokuko",
    platform: "linux",
    env: temporary.env,
    databasePath: temporary.databasePath,
    standardSkills: false,
  });
  const original = await readFile(configPath, "utf8");
  const sentinel = new Error("installed update rollback rename failed");
  let injected = false;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["opencode"],
        command: "/new/kiokuko",
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        atomicWriteTextIfUnchanged: async (
          filePath,
          content,
          expectation,
          mode,
        ) => {
          if (!injected && filePath === configPath) {
            injected = true;
            return atomicWriteTextIfUnchanged(
              filePath,
              content,
              expectation,
              mode,
              {
                afterInstall: async () =>
                  writeFile(alternatePath, '{"concurrent":true}\n'),
                beforeRename: async (_source, destination) => {
                  if (destination.endsWith(".rollback")) {
                    throw sentinel;
                  }
                },
              },
            );
          }
          return atomicWriteTextIfUnchanged(
            filePath,
            content,
            expectation,
            mode,
          );
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedMutationError);
      assert.ok(error.operationError instanceof AggregateError);
      assert.equal(error.operationError.errors.includes(sentinel), true);
      return true;
    },
  );

  assert.equal(injected, true);
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /\/new\/kiokuko/u);
  assert.equal(await readFile(alternatePath, "utf8"), '{"concurrent":true}\n');
  assert.equal(
    (await readdir(configDirectory)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("setup restores a deletion whose quarantine committed before exact observation failed", async () => {
  const temporary = await temporaryEnvironment("committed-unlink-rollback");
  const pluginPath = path.join(
    temporary.config,
    "opencode",
    "plugins",
    "kiokuko-loop-guard.js",
  );
  const plugin = legacyOpenCodeLoopGuardFixture();
  await mkdir(path.dirname(pluginPath), { recursive: true });
  await writeFile(pluginPath, plugin);
  let injected = false;
  let committedError: AtomicCommittedUnlinkError | undefined;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["opencode"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        unlinkRegularFileIfUnchanged: async (
          filePath,
          expectation,
          dependencies,
        ) => {
          if (filePath !== pluginPath || injected) {
            return unlinkRegularFileIfUnchanged(
              filePath,
              expectation,
              dependencies,
            );
          }
          injected = true;
          return unlinkRegularFileIfUnchanged(filePath, expectation, {
            ...dependencies,
            afterRename: async (_source, destination) => {
              if (destination.endsWith(".deleted")) {
                await writeFile(destination, "attacker quarantine\n");
              }
            },
          });
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AtomicCommittedUnlinkError);
      committedError = error;
      assert.equal(error.outcome.cleanupFailures.length, 1);
      return true;
    },
  );

  assert.equal(injected, true);
  assert.ok(committedError);
  assert.equal(await readFile(pluginPath, "utf8"), plugin);
  const [quarantineName] = (await readdir(path.dirname(pluginPath))).filter(
    (name) => name.endsWith(".deleted"),
  );
  assert.ok(quarantineName);
  assert.equal(
    await readFile(path.join(path.dirname(pluginPath), quarantineName), "utf8"),
    "attacker quarantine\n",
  );
  await assert.rejects(
    access(path.join(temporary.config, "opencode", "opencode.json")),
  );
  await assert.rejects(
    access(path.join(temporary.config, "opencode", "AGENTS.md")),
  );
});

test("setup restores a deletion when its post-rename hook fails after quarantine commits", async () => {
  const temporary = await temporaryEnvironment("committed-unlink-rename-error");
  const pluginPath = path.join(
    temporary.config,
    "opencode",
    "plugins",
    "kiokuko-loop-guard.js",
  );
  const plugin = legacyOpenCodeLoopGuardFixture();
  const sentinel = new Error("post-rename hook failed after unlink quarantine");
  await mkdir(path.dirname(pluginPath), { recursive: true });
  await writeFile(pluginPath, plugin);
  let injected = false;

  await assert.rejects(
    setupGlobalClients(
      {
        clients: ["opencode"],
        platform: "linux",
        env: temporary.env,
        databasePath: temporary.databasePath,
        standardSkills: false,
      },
      {
        unlinkRegularFileIfUnchanged: async (
          filePath,
          expectation,
          dependencies,
        ) => {
          if (filePath !== pluginPath || injected) {
            return unlinkRegularFileIfUnchanged(
              filePath,
              expectation,
              dependencies,
            );
          }
          injected = true;
          return unlinkRegularFileIfUnchanged(filePath, expectation, {
            ...dependencies,
            afterRename: async (_source, destination) => {
              if (destination.endsWith(".deleted")) {
                throw sentinel;
              }
            },
          });
        },
      },
    ),
    (error: unknown) =>
      error instanceof AtomicCommittedUnlinkError &&
      error.operationError === sentinel,
  );

  assert.equal(injected, true);
  assert.equal(await readFile(pluginPath, "utf8"), plugin);
  await assert.rejects(
    access(path.join(temporary.config, "opencode", "opencode.json")),
  );
  await assert.rejects(
    access(path.join(temporary.config, "opencode", "AGENTS.md")),
  );
});
