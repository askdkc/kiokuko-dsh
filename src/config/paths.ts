import path from "node:path";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { KiokukoError } from "../errors.js";

const execFile = promisify(execFileCallback);

export interface PathEnvironment {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function selectedEnvironment({
  platform = process.platform,
  env = process.env,
}: PathEnvironment): {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
} {
  return { platform, env };
}

function configuredDataDirectory(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const configured = env.KIOKUKO_DATA_DIR;
  if (configured === undefined) return undefined;

  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (
    configured.length === 0 ||
    configured.length > 4096 ||
    configured !== configured.trim() ||
    configured.includes("\0") ||
    !platformPath.isAbsolute(configured)
  ) {
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "KIOKUKO_DATA_DIR must be a bounded absolute path",
    );
  }
  const normalized = platformPath.normalize(configured);
  if (normalized === platformPath.parse(normalized).root) {
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "KIOKUKO_DATA_DIR must not be a filesystem root",
    );
  }
  return normalized;
}

export function getPlatformDataDirectory(
  options: PathEnvironment = {},
): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const configured = configuredDataDirectory(platform, env);
  if (configured !== undefined) return configured;

  if (platform === "win32") {
    const root = env.LOCALAPPDATA ?? env.APPDATA ?? env.USERPROFILE;
    if (!root) {
      throw new KiokukoError(
        "VALIDATION_ERROR",
        "A Windows user data directory is unavailable",
      );
    }
    return join(root, "kiokuko");
  }

  if (platform === "darwin") {
    const home = env.HOME;
    if (!home)
      throw new KiokukoError("VALIDATION_ERROR", "HOME is unavailable");
    return join(home, "Library", "Application Support", "kiokuko");
  }

  const root =
    env.XDG_DATA_HOME ||
    (env.HOME ? join(env.HOME, ".local", "share") : undefined);
  if (!root)
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "XDG_DATA_HOME or HOME is unavailable",
    );
  return join(root, "kiokuko");
}

export function getRuntimeDirectory(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const configured = configuredDataDirectory(platform, env);
  if (configured !== undefined) return configured;

  if (platform === "linux" && env.XDG_RUNTIME_DIR) {
    return join(env.XDG_RUNTIME_DIR, "kiokuko");
  }

  return getPlatformDataDirectory(options);
}

export function getRuntimeDescriptorPath(
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getRuntimeDirectory(options), "server.json");
}

export function getDatabaseLockPath(
  databasePath: string,
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const resolvedPath = platformPath.resolve(databasePath);
  const fingerprint = createHash("sha256")
    .update(resolvedPath, "utf8")
    .digest("hex");
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getRuntimeDirectory(options), `${fingerprint}.lock`);
}

export function getGlobalDatabasePath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getPlatformDataDirectory(options), "kiokuko-dsh.sqlite3");
}

function requireHome(options: PathEnvironment): {
  home: string;
  join: typeof path.posix.join;
} {
  const { platform, env } = selectedEnvironment(options);
  const home = platform === "win32" ? (env.USERPROFILE ?? env.HOME) : env.HOME;
  if (!home)
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "The user home directory is unavailable",
    );
  return {
    home,
    join: platform === "win32" ? path.win32.join : path.posix.join,
  };
}

/** Global Codex configuration directory. CODEX_HOME intentionally takes precedence. */
export function getCodexHome(options: PathEnvironment = {}): string {
  const { env } = selectedEnvironment(options);
  if (env.CODEX_HOME) return env.CODEX_HOME;
  const { home, join } = requireHome(options);
  return join(home, ".codex");
}

export function getCodexConfigPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getCodexHome(options), "config.toml");
}

/** Codex personal hooks configuration. */
export function getCodexHooksPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getCodexHome(options), "hooks.json");
}

export function getCodexInstructionsPath(
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getCodexHome(options), "AGENTS.md");
}

/** Codex discovers personal skills from ~/.agents/skills, independently of CODEX_HOME. */
export function getCodexSkillsDirectory(options: PathEnvironment = {}): string {
  const { home, join } = requireHome(options);
  return join(home, ".agents", "skills");
}

/** Claude Code's documented personal configuration directory. */
export function getClaudeConfigDirectory(
  options: PathEnvironment = {},
): string {
  const { env } = selectedEnvironment(options);
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  const { home, join } = requireHome(options);
  return join(home, ".claude");
}

/**
 * Claude Code stores personal MCP servers in ~/.claude.json. When
 * CLAUDE_CONFIG_DIR is set, the equivalent state file is .claude.json inside
 * that directory.
 */
export function getClaudeMcpConfigPath(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  if (env.CLAUDE_CONFIG_DIR) {
    const join = platform === "win32" ? path.win32.join : path.posix.join;
    return join(env.CLAUDE_CONFIG_DIR, ".claude.json");
  }
  const { home, join } = requireHome(options);
  return join(home, ".claude.json");
}

export function getClaudeInstructionsPath(
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getClaudeConfigDirectory(options), "CLAUDE.md");
}

export function getClaudeSkillsDirectory(
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getClaudeConfigDirectory(options), "skills");
}

/** Exact one-way upgrade target for the retired managed Claude prompt hook. */
export function getLegacyClaudePromptHookSettingsPath(
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getClaudeConfigDirectory(options), "settings.json");
}

/** Claude Code personal settings, including lifecycle hooks. */
export function getClaudeSettingsPath(options: PathEnvironment = {}): string {
  return getLegacyClaudePromptHookSettingsPath(options);
}

/** OpenCode's documented global configuration directory. */
export function getOpenCodeConfigDirectory(
  options: PathEnvironment = {},
): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "opencode");
  const { home } = requireHome(options);
  return join(home, ".config", "opencode");
}

export function getOpenCodeInstructionsPath(
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getOpenCodeConfigDirectory(options), "AGENTS.md");
}

export function getOpenCodeSkillsDirectory(
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getOpenCodeConfigDirectory(options), "skills");
}

/** Exact one-way upgrade target for the retired managed OpenCode loop guard. */
export function getLegacyOpenCodeLoopGuardPath(
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(
    getOpenCodeConfigDirectory(options),
    "plugins",
    "kiokuko-loop-guard.js",
  );
}

/** Managed OpenCode Enno-Oduno session.idle plugin. */
export function getOpenCodeEnnoPluginPath(
  options: PathEnvironment = {},
): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(
    getOpenCodeConfigDirectory(options),
    "plugins",
    "kiokuko-enno-oduno.js",
  );
}

function getHermesRoot(options: PathEnvironment): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  if (env.HERMES_HOME) return env.HERMES_HOME;

  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA ??
      (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Local") : undefined);
    if (!localAppData)
      throw new KiokukoError(
        "VALIDATION_ERROR",
        "A Hermes home directory is unavailable",
      );
    return join(localAppData, "hermes");
  }

  if (!env.HOME)
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "A Hermes home directory is unavailable",
    );
  return join(env.HOME, ".hermes");
}

function isProfileShapedHermesHome(
  home: string,
  platform: NodeJS.Platform,
): boolean {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const normalized = platformPath.normalize(home);
  const profileName = platformPath.basename(normalized);
  return (
    profileName.length > 0 &&
    profileName !== "." &&
    profileName !== ".." &&
    platformPath.basename(platformPath.dirname(normalized)) === "profiles"
  );
}

async function getHermesHomeFromCli(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!env.PATH) return undefined;
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  let result: Awaited<ReturnType<typeof execFile>>;
  try {
    result = await execFile("hermes", ["config", "path"], {
      env,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return undefined;
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "Hermes config path command failed",
    );
  }
  const output = String(result.stdout).trim();
  if (
    output.length === 0 ||
    output.includes("\0") ||
    /[\r\n]/u.test(output) ||
    !platformPath.isAbsolute(output) ||
    platformPath.basename(output) !== "config.yaml"
  ) {
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "Hermes config path command returned invalid output",
    );
  }
  return platformPath.dirname(platformPath.normalize(output));
}

function sameHermesHome(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string): string => {
    const normalized = platformPath.resolve(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

async function requireCliMatchesStickyHermesHome(
  expectedHome: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const cliHome = await getHermesHomeFromCli(platform, env);
  if (
    cliHome !== undefined &&
    !sameHermesHome(cliHome, expectedHome, platform)
  ) {
    throw new KiokukoError(
      "CONFLICT",
      "Hermes config path disagrees with the active profile marker",
    );
  }
  return expectedHome;
}

/** Resolve the effective Hermes profile home without consulting or mutating the active Hermes profile. */
export async function getHermesHome(
  options: PathEnvironment = {},
): Promise<string> {
  const { platform, env } = selectedEnvironment(options);
  const root = getHermesRoot(options);
  if (env.HERMES_HOME && isProfileShapedHermesHome(root, platform)) return root;

  const join = platform === "win32" ? path.win32.join : path.posix.join;
  let activeProfile: string;
  try {
    activeProfile = (
      await readFile(join(root, "active_profile"), "utf8")
    ).trim();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return (await getHermesHomeFromCli(platform, env)) ?? root;
    }
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "Hermes active profile marker is unavailable",
    );
  }

  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(activeProfile)) {
    throw new KiokukoError(
      "VALIDATION_ERROR",
      "Hermes active profile marker is invalid",
    );
  }
  if (activeProfile === "default")
    return requireCliMatchesStickyHermesHome(root, platform, env);

  const profileHome = join(root, "profiles", activeProfile);
  try {
    if (!(await lstat(profileHome)).isDirectory()) {
      throw new KiokukoError(
        "VALIDATION_ERROR",
        "Hermes active profile directory is unavailable",
      );
    }
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR"].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    ) {
      throw new KiokukoError(
        "VALIDATION_ERROR",
        "Hermes active profile directory is unavailable",
      );
    }
    throw error;
  }
  return requireCliMatchesStickyHermesHome(profileHome, platform, env);
}

export interface HermesProfilePaths {
  home: string;
  configPath: string;
  skillsDirectory: string;
}

/** Resolve the active Hermes profile once and bind every setup destination to it. */
export async function resolveHermesProfilePaths(
  options: PathEnvironment = {},
): Promise<HermesProfilePaths> {
  const { platform } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const home = await getHermesHome(options);
  return {
    home,
    configPath: join(home, "config.yaml"),
    skillsDirectory: join(home, "skills"),
  };
}

export async function getHermesConfigPath(
  options: PathEnvironment = {},
): Promise<string> {
  return (await resolveHermesProfilePaths(options)).configPath;
}

export async function getHermesSkillsDirectory(
  options: PathEnvironment = {},
): Promise<string> {
  return (await resolveHermesProfilePaths(options)).skillsDirectory;
}

export async function ensurePlatformDataDirectory(
  options: PathEnvironment = {},
): Promise<string> {
  const directory = getPlatformDataDirectory(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function embeddingCoordinate(value: string, field: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value) && field === "preset") {
    throw new KiokukoError("VALIDATION_ERROR", `${field} is invalid`);
  }
  if (field === "revision" && !/^[0-9a-f]{40}$/u.test(value)) {
    throw new KiokukoError("VALIDATION_ERROR", `${field} is invalid`);
  }
  return value;
}

export function getEmbeddingModelsDirectory(
  options: PathEnvironment = {},
): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(
    getPlatformDataDirectory({ platform, env }),
    "models",
    "embeddings",
  );
}

export function getEmbeddingModelStagingDirectory(
  options: PathEnvironment = {},
): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getEmbeddingModelsDirectory({ platform, env }), ".staging");
}

export function getEmbeddingSetupLockPath(
  options: PathEnvironment = {},
): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(getEmbeddingModelsDirectory({ platform, env }), ".setup.lock");
}

export function getEmbeddingPresetDirectory(
  preset: string,
  revision: string,
  options: PathEnvironment = {},
): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(
    getEmbeddingModelsDirectory({ platform, env }),
    embeddingCoordinate(preset, "preset"),
    embeddingCoordinate(revision, "revision"),
  );
}

export function getEmbeddingModelManifestPath(
  preset: string,
  revision: string,
  options: PathEnvironment = {},
): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(
    getEmbeddingPresetDirectory(preset, revision, { platform, env }),
    "kiokuko-model-manifest.json",
  );
}
