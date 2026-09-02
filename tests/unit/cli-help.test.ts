import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { buildCli } from "../../src/cli.js";
import { KiokukoError } from "../../src/errors.js";
import {
  parseSetupSkillDiscoveryMode,
  promptCommunitySkillDiscovery,
  promptReplaceConflictingMcp,
  promptSetupClients,
  promptSetupConfiguration,
} from "../../src/commands/setup.js";

function interactiveAnswers(
  ...answers: string[]
): PassThrough & { isTTY?: boolean } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  let index = 0;
  const writeNext = () => {
    const answer = answers[index];
    if (answer === undefined) {
      input.end();
      return;
    }
    index += 1;
    input.write(answer);
    setImmediate(writeNext);
  };
  setImmediate(writeNext);
  return input;
}

test("reports the package version instead of a stale hard-coded CLI version", () => {
  const packageMetadata = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(buildCli().version(), packageMetadata.version);
});

test("prints the package version from the version subcommand", async () => {
  const packageMetadata = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli().parseAsync(["node", "kiokuko", "version"]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(stdout, `${packageMetadata.version}\n`);
});

test("registers required commands", () => {
  const names = buildCli().commands.map((command) => command.name());
  for (const name of [
    "version",
    "init",
    "setup",
    "mcp",
    "use",
    "recall",
    "memory",
    "search",
    "read",
    "record",
    "promote",
    "curator",
    "supersede",
    "link",
    "export",
    "import",
    "backup",
    "purge",
    "doctor",
    "web",
    "guide",
    "call",
    "agent",
    "skills",
  ]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
});

test("does not synthesize an agent-file override when the use flag is omitted", () => {
  const use = buildCli().commands.find((command) => command.name() === "use");
  assert.ok(use);
  const agentFile = use.options.find(
    (option) => option.long === "--agent-file",
  );
  assert.ok(agentFile);
  assert.equal(agentFile.defaultValue, undefined);
});

test("exposes the small external-skill management surface", () => {
  const skills = buildCli().commands.find(
    (command) => command.name() === "skills",
  );
  assert.ok(skills);
  assert.deepEqual(
    skills.commands.map((command) => command.name()),
    [
      "find",
      "import",
      "list",
      "show",
      "disable",
      "enable",
      "refresh",
      "prune-cache",
    ],
  );
  assert.match(
    skills.commands
      .find((command) => command.name() === "find")
      ?.helpInformation() ?? "",
    /--official-only/,
  );
  assert.match(
    skills.commands
      .find((command) => command.name() === "import")
      ?.helpInformation() ?? "",
    /<skill>/,
  );
  assert.deepEqual(
    skills.commands
      .find((command) => command.name() === "list")
      ?.options.find((option) => option.long === "--state")?.argChoices,
    ["discovered", "imported", "blocked", "stale", "disabled"],
  );
});

test("exposes scoped recall through the documented memory recall command", () => {
  const memory = buildCli().commands.find(
    (command) => command.name() === "memory",
  );
  assert.ok(memory);
  assert.deepEqual(
    memory.commands.map((command) => command.name()),
    ["recall"],
  );
  const recall = memory.commands[0];
  assert.ok(recall);
  assert.match(recall.helpInformation(), /<query>/);
  assert.match(recall.helpInformation(), /--scope <scope>/);
  assert.match(recall.helpInformation(), /--cwd <path>/);
  assert.match(recall.helpInformation(), /--limit <number>/);
  assert.match(recall.helpInformation(), /--max-chars <number>/);
  assert.match(recall.helpInformation(), /--workspace <name>/);
  assert.match(recall.helpInformation(), /--json/);
  assert.match(recall.description(), /Human\/operator management/u);
  assert.match(
    buildCli()
      .commands.find((command) => command.name() === "call")
      ?.description() ?? "",
    /memory reads are not supported/u,
  );
});

test("exposes the curator review and confirmation options", () => {
  const curator = buildCli().commands.find(
    (command) => command.name() === "curator",
  );
  assert.ok(curator);
  const help = curator.helpInformation();
  assert.match(help, /--workspace <name>/);
  assert.match(help, /--entry-id <id>/);
  assert.match(help, /--skill-ready-only/);
  assert.match(help, /--yes/);
  assert.match(help, /--json/);
});

test("exposes the Akinator guide subcommands", () => {
  const guide = buildCli().commands.find(
    (command) => command.name() === "guide",
  );
  assert.ok(guide);
  assert.deepEqual(
    guide.commands.map((command) => command.name()),
    ["start", "answer"],
  );
});

test("exposes the generic agent lifecycle subcommands and required options", () => {
  const agent = buildCli().commands.find(
    (command) => command.name() === "agent",
  );
  assert.ok(agent);
  assert.deepEqual(
    agent.commands.map((command) => command.name()),
    ["open", "answer", "events", "checkpoint", "close", "feedback"],
  );
  assert.match(
    agent.commands
      .find((command) => command.name() === "open")
      ?.helpInformation() ?? "",
    /--workspace <workspace>/,
  );
  assert.match(
    agent.commands
      .find((command) => command.name() === "open")
      ?.helpInformation() ?? "",
    /--client <kind>/,
  );
  assert.match(
    agent.commands
      .find((command) => command.name() === "open")
      ?.helpInformation() ?? "",
    /--task <task>/,
  );
  assert.match(
    agent.commands
      .find((command) => command.name() === "open")
      ?.helpInformation() ?? "",
    /--capabilities-json <file\|->/,
  );
  assert.match(
    agent.commands
      .find((command) => command.name() === "answer")
      ?.helpInformation() ?? "",
    /--question-id <id>/,
  );
  assert.match(
    agent.commands
      .find((command) => command.name() === "answer")
      ?.helpInformation() ?? "",
    /--capabilities-json <file\|->/,
  );
  assert.match(
    agent.commands
      .find((command) => command.name() === "checkpoint")
      ?.helpInformation() ?? "",
    /--capabilities-json <file\|->/,
  );
  assert.match(
    agent.commands
      .find((command) => command.name() === "events")
      ?.helpInformation() ?? "",
    /--input-json <file\|->/,
  );
});
test("exposes help for the use command", () => {
  const use = buildCli().commands.find((command) => command.name() === "use");
  assert.ok(use);
  assert.match(use.helpInformation(), /--root/);
  assert.match(use.helpInformation(), /--workspace/);
  assert.match(use.helpInformation(), /--dry-run/);
});

test("exposes Claude Code as a global setup client", () => {
  const setup = buildCli().commands.find(
    (command) => command.name() === "setup",
  );
  assert.ok(setup);
  assert.match(setup.helpInformation(), /codex,opencode,claude,hermes/);
  assert.match(setup.description(), /Claude Code/);
  assert.match(setup.description(), /Hermes Agent/);
  assert.match(setup.helpInformation(), /--no-standard-skills/);
  assert.match(setup.helpInformation(), /--skill-discovery <mode>/);
  assert.doesNotMatch(
    setup.helpInformation(),
    /claude-prompt-hook|opencode-capture|opencode-mode/u,
  );
});

test("plans Hermes-only setup when Hermes Agent is detected and no client is selected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiokuko-cli-hermes-"));
  const hermesHome = path.join(root, ".hermes");
  const bin = path.join(root, "bin");
  await mkdir(hermesHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(hermesHome, "active_profile"), "default\n");
  const hermes = path.join(bin, "hermes");
  await writeFile(hermes, '#!/bin/sh\nprintf "%s\\n" "$HERMES_CONFIG_PATH"\n');
  await chmod(hermes, 0o755);

  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      setupEnvironment: {
        platform: "linux",
        env: {
          HOME: root,
          PATH: bin,
          HERMES_CONFIG_PATH: path.join(hermesHome, "config.yaml"),
        },
      },
    }).parseAsync(["node", "kiokuko", "setup", "--dry-run", "--json"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as {
    data: {
      clients: string[];
      databaseAction: string;
      databasePath: string;
      dryRun: boolean;
      files: Array<{ client: string; path: string }>;
    };
    ok: boolean;
  };
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.clients, ["hermes"]);
  assert.equal(response.data.databaseAction, "planned");
  assert.equal(response.data.dryRun, true);
  assert.ok(response.data.files.every((file) => file.client === "hermes"));
  for (const file of response.data.files)
    await assert.rejects(access(file.path));
  await assert.rejects(access(response.data.databasePath));
});

test("no-argument setup does not configure clients when no client executable is detected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiokuko-cli-no-hermes-"));
  const hermesHome = path.join(root, ".hermes");
  await mkdir(hermesHome, { recursive: true });
  await writeFile(path.join(hermesHome, "config.yaml"), "mcp_servers: {}\n");

  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      setupEnvironment: { platform: "linux", env: { HOME: root, PATH: "" } },
    }).parseAsync(["node", "kiokuko", "setup", "--dry-run", "--json"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as {
    data: { clients: string[]; files: unknown[] };
    ok: boolean;
  };
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.clients, []);
  assert.deepEqual(response.data.files, []);
});

test("no-argument setup configures only client executables detected on PATH", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kiokuko-cli-detected-clients-"),
  );
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const client of ["codex", "claude"]) {
    const executable = path.join(bin, client);
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o755);
  }

  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      setupEnvironment: { platform: "linux", env: { HOME: root, PATH: bin } },
    }).parseAsync(["node", "kiokuko", "setup", "--dry-run", "--json"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as {
    data: { clients: string[]; files: Array<{ client: string }> };
    ok: boolean;
  };
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.clients, ["codex", "claude"]);
  assert.ok(
    response.data.files.every((file) =>
      ["codex", "claude"].includes(file.client),
    ),
  );
});

test("setup prompt preselects detected clients and accepts names or numbers", async () => {
  let outputText = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += chunk.toString();
      callback();
    },
  });
  const selected = await promptSetupClients(["codex", "claude"], {
    input: Readable.from(["2,4\n"]),
    output,
  });

  assert.deepEqual(selected, ["opencode", "hermes"]);
  assert.match(outputText, /1\. \[x\] Codex \(detected\)/);
  assert.match(outputText, /2\. \[ \] OpenCode \(not detected\)/);
  assert.match(outputText, /3\. \[x\] Claude Code \(detected\)/);
});

test("setup prompt accepts the detected selection on an empty answer", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const selected = await promptSetupClients(["hermes"], {
    input: Readable.from(["\n"]),
    output,
  });
  assert.deepEqual(selected, ["hermes"]);
});

test("setup prompt keeps official discovery by default and explicitly enables community discovery", async () => {
  let outputText = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += chunk.toString();
      callback();
    },
  });
  assert.equal(
    await promptCommunitySkillDiscovery({
      input: Readable.from(["\n"]),
      output,
    }),
    "official",
  );
  assert.match(
    outputText,
    /Official external Skill discovery is enabled by default/u,
  );
  assert.match(outputText, /Enable community Skill discovery\? \[y\/N\]/u);

  const enabledOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  assert.equal(
    await promptCommunitySkillDiscovery({
      input: Readable.from(["yes\n"]),
      output: enabledOutput,
    }),
    "community",
  );
  assert.equal(parseSetupSkillDiscoveryMode("off"), "off");
  assert.equal(parseSetupSkillDiscoveryMode("community"), "community");
  assert.throws(
    () => parseSetupSkillDiscoveryMode("on"),
    /off, official, or community/u,
  );
});

test("combined setup prompt keeps both answers in one readline session", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const selected = await promptSetupConfiguration(["codex"], {
    input: interactiveAnswers("4\n", "y\n"),
    output,
  });
  assert.deepEqual(selected, {
    clients: ["hermes"],
    skillDiscoveryMode: "community",
  });
});

test("client conflict prompt defaults to yes and accepts explicit negative answers", async () => {
  let outputText = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += chunk.toString();
      callback();
    },
  });
  assert.equal(
    await promptReplaceConflictingMcp("opencode", {
      input: Readable.from(["\n"]),
      output,
    }),
    true,
  );
  assert.match(
    outputText,
    /remove that identity, install the managed configuration, and continue setup/u,
  );
  assert.match(
    outputText,
    /Replace the existing OpenCode Kiokuko MCP identity and continue\? \[Y\/n\]/u,
  );

  for (const answer of ["n\n", "no\n", "いいえ\n"]) {
    const declineOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    assert.equal(
      await promptReplaceConflictingMcp("hermes", {
        input: Readable.from([answer]),
        output: declineOutput,
      }),
      false,
    );
  }
});

test("interactive setup replaces an orphaned Codex MCP marker after accepting the default confirmation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiokuko-cli-codex-replace-"));
  const bin = path.join(root, "bin");
  const codexDirectory = path.join(root, ".codex");
  const configPath = path.join(codexDirectory, "config.toml");
  await mkdir(bin, { recursive: true });
  await mkdir(codexDirectory, { recursive: true });
  const codexExecutable = path.join(bin, "codex");
  await writeFile(codexExecutable, "#!/bin/sh\n");
  await chmod(codexExecutable, 0o755);
  await writeFile(configPath, 'model = "keep"\n# END KIOKUKO MCP\n');

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  let promptOutput = "";
  let answeredClients = false;
  let answeredCommunity = false;
  let answeredReplacement = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      promptOutput += text;
      if (!answeredClients && text.includes("Clients [")) {
        answeredClients = true;
        setImmediate(() => input.write("\n"));
      }
      if (
        !answeredCommunity &&
        text.includes("Enable community Skill discovery?")
      ) {
        answeredCommunity = true;
        setImmediate(() => input.write("\n"));
      }
      if (
        !answeredReplacement &&
        text.includes("Replace the existing Codex Kiokuko MCP identity")
      ) {
        answeredReplacement = true;
        setImmediate(() => {
          input.write("\n");
          input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      setupEnvironment: { platform: "linux", env: { HOME: root, PATH: bin } },
      setupInput: input,
      setupOutput: output,
    }).parseAsync(["node", "kiokuko", "setup", "--no-standard-skills"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(promptOutput, /1\. \[x\] Codex \(detected\)/u);
  assert.match(promptOutput, /Enable community Skill discovery\? \[y\/N\]/u);
  assert.match(
    promptOutput,
    /non-canonical or unmanaged Kiokuko MCP identity/u,
  );
  assert.match(stdout, /Kiokuko configured for codex/u);
  const config = await readFile(configPath, "utf8");
  assert.match(config, /^model = "keep"/u);
  assert.equal((config.match(/# BEGIN KIOKUKO MCP/gu) ?? []).length, 1);
  assert.equal((config.match(/# END KIOKUKO MCP/gu) ?? []).length, 1);
  assert.match(config, /# Managed by `kiokuko setup`\./u);
});

test("interactive setup confirms and replaces conflicts for every selected client before committing", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kiokuko-cli-all-client-replace-"),
  );
  const configRoot = path.join(root, "config");
  const dataRoot = path.join(root, "data");
  const codexConfigPath = path.join(root, ".codex", "config.toml");
  const openCodeConfigPath = path.join(
    configRoot,
    "opencode",
    "opencode.jsonc",
  );
  const claudeConfigPath = path.join(root, ".claude.json");
  const hermesProfile = path.join(root, "hermes", "profiles", "main");
  const hermesConfigPath = path.join(hermesProfile, "config.yaml");
  await mkdir(path.dirname(codexConfigPath), { recursive: true });
  await mkdir(path.dirname(openCodeConfigPath), { recursive: true });
  await mkdir(hermesProfile, { recursive: true });
  await writeFile(
    codexConfigPath,
    'model = "keep"\n[mcp_servers.kiokuko]\ncommand = "codex-wrapper"\n',
  );
  await writeFile(
    openCodeConfigPath,
    `${JSON.stringify(
      {
        theme: "keep",
        mcp: {
          other: { command: ["keep"] },
          kiokuko: { type: "remote", url: "https://example.test" },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    claudeConfigPath,
    `${JSON.stringify(
      {
        theme: "keep",
        mcpServers: {
          other: { type: "http", url: "https://example.test" },
          kiokuko: { command: "claude-wrapper", args: ["serve"] },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    hermesConfigPath,
    [
      "model: keep",
      "mcp_servers:",
      "  other:",
      "    command: keep-other",
      "  kiokuko:",
      "    command: hermes-wrapper",
      "    args: [serve]",
      "",
    ].join("\n"),
  );

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const promptedClients: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const match =
        /Replace the existing (Codex|OpenCode|Claude Code|Hermes Agent) Kiokuko MCP identity/u.exec(
          chunk.toString(),
        );
      const label = match?.[1];
      if (label !== undefined && !promptedClients.includes(label)) {
        promptedClients.push(label);
        setImmediate(() => {
          input.write("y\n");
          if (promptedClients.length === 4) input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      setupEnvironment: {
        platform: "linux",
        env: {
          HOME: root,
          PATH: "",
          XDG_CONFIG_HOME: configRoot,
          XDG_DATA_HOME: dataRoot,
          HERMES_HOME: hermesProfile,
        },
      },
      setupInput: input,
      setupOutput: output,
    }).parseAsync([
      "node",
      "kiokuko",
      "setup",
      "--clients",
      "codex,opencode,claude,hermes",
      "--skill-discovery",
      "official",
      "--no-standard-skills",
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.deepEqual(promptedClients, [
    "Codex",
    "OpenCode",
    "Claude Code",
    "Hermes Agent",
  ]);
  assert.match(
    stdout,
    /Kiokuko configured for codex, opencode, claude, hermes/u,
  );
  const codexConfig = await readFile(codexConfigPath, "utf8");
  assert.doesNotMatch(codexConfig, /codex-wrapper/u);
  assert.match(codexConfig, /# Managed by `kiokuko setup`\./u);
  const openCodeConfig = JSON.parse(
    await readFile(openCodeConfigPath, "utf8"),
  ) as {
    theme: string;
    mcp: { other: unknown; kiokuko: { type: string } };
  };
  assert.equal(openCodeConfig.theme, "keep");
  assert.deepEqual(openCodeConfig.mcp.other, { command: ["keep"] });
  assert.equal(openCodeConfig.mcp.kiokuko.type, "local");
  const claudeConfig = JSON.parse(await readFile(claudeConfigPath, "utf8")) as {
    theme: string;
    mcpServers: { other: unknown; kiokuko: { type: string } };
  };
  assert.equal(claudeConfig.theme, "keep");
  assert.deepEqual(claudeConfig.mcpServers.other, {
    type: "http",
    url: "https://example.test",
  });
  assert.equal(claudeConfig.mcpServers.kiokuko.type, "stdio");
  const hermesConfig = await readFile(hermesConfigPath, "utf8");
  assert.match(hermesConfig, /command: keep-other/u);
  assert.doesNotMatch(hermesConfig, /hermes-wrapper/u);
  assert.match(hermesConfig, /Managed by `kiokuko setup`\./u);
});

test("interactive setup preserves an unmanaged Codex MCP identity when replacement is declined", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiokuko-cli-codex-decline-"));
  const codexDirectory = path.join(root, ".codex");
  const configPath = path.join(codexDirectory, "config.toml");
  const original =
    'model = "keep"\n[mcp_servers.kiokuko]\ncommand = "custom"\n';
  await mkdir(codexDirectory, { recursive: true });
  await writeFile(configPath, original);

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  let answered = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (
        !answered &&
        chunk
          .toString()
          .includes("Replace the existing Codex Kiokuko MCP identity")
      ) {
        answered = true;
        setImmediate(() => {
          input.write("n\n");
          input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  await assert.rejects(
    buildCli({
      setupEnvironment: { platform: "linux", env: { HOME: root, PATH: "" } },
      setupInput: input,
      setupOutput: output,
    }).parseAsync([
      "node",
      "kiokuko",
      "setup",
      "--clients",
      "codex",
      "--skill-discovery",
      "official",
      "--no-standard-skills",
    ]),
    (error: unknown) =>
      error instanceof KiokukoError &&
      error.code === "CONFLICT" &&
      /unmanaged Kiokuko MCP identity/u.test(error.message),
  );

  assert.equal(await readFile(configPath, "utf8"), original);
  await assert.rejects(access(path.join(codexDirectory, "AGENTS.md")));
});

test("declining a later client conflict preserves every earlier approved client file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiokuko-cli-later-decline-"));
  const configRoot = path.join(root, "config");
  const dataRoot = path.join(root, "data");
  const codexConfigPath = path.join(root, ".codex", "config.toml");
  const openCodeConfigPath = path.join(
    configRoot,
    "opencode",
    "opencode.jsonc",
  );
  const codexOriginal =
    'model = "keep"\n[mcp_servers.kiokuko]\ncommand = "codex-wrapper"\n';
  const openCodeOriginal =
    '{"theme":"keep","mcp":{"kiokuko":{"type":"remote"}}}\n';
  await mkdir(path.dirname(codexConfigPath), { recursive: true });
  await mkdir(path.dirname(openCodeConfigPath), { recursive: true });
  await writeFile(codexConfigPath, codexOriginal);
  await writeFile(openCodeConfigPath, openCodeOriginal);

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const promptedClients: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      if (text.includes("Replace the existing Codex Kiokuko MCP identity")) {
        promptedClients.push("Codex");
        setImmediate(() => input.write("y\n"));
      }
      if (text.includes("Replace the existing OpenCode Kiokuko MCP identity")) {
        promptedClients.push("OpenCode");
        setImmediate(() => {
          input.write("n\n");
          input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;

  await assert.rejects(
    buildCli({
      setupEnvironment: {
        platform: "linux",
        env: {
          HOME: root,
          PATH: "",
          XDG_CONFIG_HOME: configRoot,
          XDG_DATA_HOME: dataRoot,
        },
      },
      setupInput: input,
      setupOutput: output,
    }).parseAsync([
      "node",
      "kiokuko",
      "setup",
      "--clients",
      "codex,opencode",
      "--skill-discovery",
      "official",
      "--no-standard-skills",
    ]),
    (error: unknown) =>
      error instanceof KiokukoError &&
      error.code === "CONFLICT" &&
      /OpenCode/u.test(error.message),
  );

  assert.deepEqual(promptedClients, ["Codex", "OpenCode"]);
  assert.equal(await readFile(codexConfigPath, "utf8"), codexOriginal);
  assert.equal(await readFile(openCodeConfigPath, "utf8"), openCodeOriginal);
  await assert.rejects(access(path.join(root, ".codex", "AGENTS.md")));
  await assert.rejects(
    access(path.join(dataRoot, "kiokuko", "kiokuko-dsh.sqlite3")),
  );
});

test("interactive setup applies the selection returned by the prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiokuko-cli-interactive-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const codex = path.join(bin, "codex");
  await writeFile(codex, "#!/bin/sh\n");
  await chmod(codex, 0o755);

  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  let promptOutput = "";
  let answeredClients = false;
  let answeredCommunity = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      promptOutput += text;
      if (!answeredClients && text.includes("Clients [")) {
        answeredClients = true;
        setImmediate(() => input.write("4\n"));
      }
      if (
        !answeredCommunity &&
        text.includes("Enable community Skill discovery?")
      ) {
        answeredCommunity = true;
        setImmediate(() => {
          input.write("y\n");
          input.end();
        });
      }
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      setupEnvironment: { platform: "linux", env: { HOME: root, PATH: bin } },
      setupInput: input,
      setupOutput: output,
    }).parseAsync(["node", "kiokuko", "setup", "--dry-run"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(promptOutput, /1\. \[x\] Codex \(detected\)/);
  assert.match(promptOutput, /Enable community Skill discovery\? \[y\/N\]/u);
  assert.match(stdout, /Kiokuko setup plan for hermes:/);
});

test("explicit client selection takes precedence over Hermes detection", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kiokuko-cli-hermes-explicit-"),
  );
  const hermesHome = path.join(root, ".hermes");
  await mkdir(hermesHome, { recursive: true });
  await writeFile(path.join(hermesHome, "config.yaml"), "mcp_servers: {}\n");

  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      setupEnvironment: { platform: "linux", env: { HOME: root, PATH: "" } },
    }).parseAsync([
      "node",
      "kiokuko",
      "setup",
      "--clients",
      "codex",
      "--dry-run",
      "--json",
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as {
    data: { clients: string[] };
    ok: boolean;
  };
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.clients, ["codex"]);
});

test("exposes foreground serve options without capability-token controls", () => {
  const serve = buildCli().commands.find(
    (command) => command.name() === "serve",
  );
  assert.ok(serve);
  const help = serve.helpInformation();
  assert.match(help, /--host <host>/);
  assert.match(help, /--port <number>/);
  assert.match(help, /--json/);
  assert.doesNotMatch(help, /token|database|lock/i);
});

test("exposes exactly server status in the server command group", () => {
  const server = buildCli().commands.find(
    (command) => command.name() === "server",
  );
  assert.ok(server);
  assert.deepEqual(
    server.commands.map((command) => command.name()),
    ["status"],
  );
  const status = server.commands[0];
  assert.ok(status);
  assert.match(status.helpInformation(), /--json/);
});
