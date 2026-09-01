import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import {
  getClaudeConfigDirectory,
  getClaudeInstructionsPath,
  getClaudeMcpConfigPath,
  getClaudeSkillsDirectory,
  getClaudeSettingsPath,
  getCodexConfigPath,
  getCodexHooksPath,
  getCodexInstructionsPath,
  getCodexSkillsDirectory,
  getDatabaseLockPath,
  getGlobalDatabasePath,
  getHermesConfigPath,
  getHermesHome,
  getLegacyClaudePromptHookSettingsPath,
  getLegacyOpenCodeLoopGuardPath,
  getOpenCodeConfigDirectory,
  getOpenCodeEnnoPluginPath,
  getOpenCodeInstructionsPath,
  getOpenCodeSkillsDirectory,
  getHermesSkillsDirectory,
  getRuntimeDescriptorPath,
  getRuntimeDirectory,
} from '../../src/config/paths.js';

test('derives a per-database lock path from the resolved database path', () => {
  const databasePath = '/tmp/kiokuko-relative/../kiokuko.sqlite3';
  const fingerprint = createHash('sha256').update('/tmp/kiokuko.sqlite3').digest('hex');
  assert.equal(
    getDatabaseLockPath(databasePath, {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/tmp/xdg-runtime' },
    }),
    `/tmp/xdg-runtime/kiokuko/${fingerprint}.lock`,
  );
});

test('derives the runtime descriptor path from the runtime directory', () => {
  assert.equal(
    getRuntimeDescriptorPath({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/tmp/xdg-runtime' },
    }),
    '/tmp/xdg-runtime/kiokuko/server.json',
  );
});

test('uses XDG runtime home on Linux', () => {
  assert.equal(
    getRuntimeDirectory({
      platform: 'linux',
      env: {
        XDG_RUNTIME_DIR: '/tmp/xdg-runtime',
        XDG_DATA_HOME: '/tmp/xdg-data',
        HOME: '/tmp/home',
      },
    }),
    '/tmp/xdg-runtime/kiokuko',
  );
});

test('falls back to the platform home data directory for runtime state', () => {
  assert.equal(
    getRuntimeDirectory({ platform: 'linux', env: { HOME: '/tmp/home' } }),
    '/tmp/home/.local/share/kiokuko',
  );
  assert.equal(
    getRuntimeDirectory({ platform: 'darwin', env: { HOME: '/tmp/home' } }),
    '/tmp/home/Library/Application Support/kiokuko',
  );
  assert.equal(
    getRuntimeDirectory({
      platform: 'win32',
      env: { LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` },
    }),
    String.raw`C:\Users\test\AppData\Local\kiokuko`,
  );
});

test('uses XDG data home on Linux', () => {
  assert.equal(
    getGlobalDatabasePath({
      platform: 'linux',
      env: {
        XDG_DATA_HOME: '/tmp/xdg-data',
        HOME: '/tmp/home',
      },
    }),
    '/tmp/xdg-data/kiokuko/kiokuko.sqlite3',
  );
});

test('uses an explicit isolated Kiokuko data directory for database and runtime state', () => {
  const options = {
    platform: 'darwin' as const,
    env: {
      HOME: '/Users/test',
      KIOKUKO_DATA_DIR: '/work/kiokuko/.kiokuko-dev/../.kiokuko-dev',
    },
  };
  assert.equal(getGlobalDatabasePath(options), '/work/kiokuko/.kiokuko-dev/kiokuko.sqlite3');
  assert.equal(getRuntimeDirectory(options), '/work/kiokuko/.kiokuko-dev');
  assert.equal(getRuntimeDescriptorPath(options), '/work/kiokuko/.kiokuko-dev/server.json');
});

test('an explicit Kiokuko data directory overrides Linux XDG data and runtime directories', () => {
  const options = {
    platform: 'linux' as const,
    env: {
      HOME: '/home/test',
      XDG_DATA_HOME: '/xdg/data',
      XDG_RUNTIME_DIR: '/xdg/runtime',
      KIOKUKO_DATA_DIR: '/work/kiokuko-data',
    },
  };
  assert.equal(getGlobalDatabasePath(options), '/work/kiokuko-data/kiokuko.sqlite3');
  assert.equal(getRuntimeDirectory(options), '/work/kiokuko-data');
});

test('rejects unsafe Kiokuko data-directory overrides without echoing them', () => {
  for (const configured of ['', 'relative/data', ' /tmp/data', '/tmp/data ', '/', `/${'x'.repeat(4096)}`, '/tmp/bad\0path']) {
    assert.throws(
      () => getGlobalDatabasePath({ platform: 'darwin', env: { HOME: '/Users/test', KIOKUKO_DATA_DIR: configured } }),
      (error: unknown) => {
        assert.ok(error instanceof KiokukoError);
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(
          error.message,
          configured === '/'
            ? 'KIOKUKO_DATA_DIR must not be a filesystem root'
            : 'KIOKUKO_DATA_DIR must be a bounded absolute path',
        );
        return true;
      },
    );
  }
});

test('falls back to the platform home data directory', () => {
  assert.equal(
    getGlobalDatabasePath({
      platform: 'linux',
      env: { HOME: '/tmp/home' },
    }),
    '/tmp/home/.local/share/kiokuko/kiokuko.sqlite3',
  );
  assert.equal(
    getGlobalDatabasePath({
      platform: 'darwin',
      env: { HOME: '/tmp/home' },
    }),
    '/tmp/home/Library/Application Support/kiokuko/kiokuko.sqlite3',
  );
  assert.equal(
    getGlobalDatabasePath({
      platform: 'win32',
      env: { LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` },
    }),
    String.raw`C:\Users\test\AppData\Local\kiokuko\kiokuko.sqlite3`,
  );
});

test('derives documented global Codex, OpenCode, and Claude paths without touching the real home directory', () => {
  const options = {
    platform: 'linux' as const,
    env: { HOME: '/tmp/fake-home', XDG_CONFIG_HOME: '/tmp/fake-config' },
  };
  assert.equal(getCodexConfigPath(options), '/tmp/fake-home/.codex/config.toml');
  assert.equal(getCodexHooksPath(options), '/tmp/fake-home/.codex/hooks.json');
  assert.equal(getCodexInstructionsPath(options), '/tmp/fake-home/.codex/AGENTS.md');
  assert.equal(getCodexSkillsDirectory(options), '/tmp/fake-home/.agents/skills');
  assert.equal(getOpenCodeConfigDirectory(options), '/tmp/fake-config/opencode');
  assert.equal(getOpenCodeInstructionsPath(options), '/tmp/fake-config/opencode/AGENTS.md');
  assert.equal(getOpenCodeSkillsDirectory(options), '/tmp/fake-config/opencode/skills');
  assert.equal(getOpenCodeEnnoPluginPath(options), '/tmp/fake-config/opencode/plugins/kiokuko-enno-oduno.js');
  assert.equal(getClaudeConfigDirectory(options), '/tmp/fake-home/.claude');
  assert.equal(getClaudeMcpConfigPath(options), '/tmp/fake-home/.claude.json');
  assert.equal(getClaudeInstructionsPath(options), '/tmp/fake-home/.claude/CLAUDE.md');
  assert.equal(getClaudeSkillsDirectory(options), '/tmp/fake-home/.claude/skills');
  assert.equal(getLegacyClaudePromptHookSettingsPath(options), '/tmp/fake-home/.claude/settings.json');
  assert.equal(getClaudeSettingsPath(options), '/tmp/fake-home/.claude/settings.json');
  assert.equal(getLegacyOpenCodeLoopGuardPath(options), '/tmp/fake-config/opencode/plugins/kiokuko-loop-guard.js');
  assert.equal(getCodexConfigPath({ ...options, env: { ...options.env, CODEX_HOME: '/tmp/custom-codex' } }), '/tmp/custom-codex/config.toml');
  assert.equal(getClaudeMcpConfigPath({ ...options, env: { ...options.env, CLAUDE_CONFIG_DIR: '/tmp/custom-claude' } }), '/tmp/custom-claude/.claude.json');
  assert.equal(getClaudeInstructionsPath({ ...options, env: { ...options.env, CLAUDE_CONFIG_DIR: '/tmp/custom-claude' } }), '/tmp/custom-claude/CLAUDE.md');
  assert.equal(getClaudeSkillsDirectory({ ...options, env: { ...options.env, CLAUDE_CONFIG_DIR: '/tmp/custom-claude' } }), '/tmp/custom-claude/skills');
});

test('derives native standard-skill directories on macOS, Linux, and Windows', async () => {
  assert.equal(getCodexSkillsDirectory({ platform: 'darwin', env: { HOME: '/Users/test', CODEX_HOME: '/custom/codex' } }), '/Users/test/.agents/skills');
  assert.equal(getOpenCodeSkillsDirectory({ platform: 'darwin', env: { HOME: '/Users/test' } }), '/Users/test/.config/opencode/skills');
  assert.equal(getClaudeSkillsDirectory({ platform: 'darwin', env: { HOME: '/Users/test' } }), '/Users/test/.claude/skills');
  assert.equal(await getHermesSkillsDirectory({ platform: 'darwin', env: { HERMES_HOME: '/Users/test/.hermes/profiles/work' } }), '/Users/test/.hermes/profiles/work/skills');

  assert.equal(getOpenCodeSkillsDirectory({ platform: 'linux', env: { HOME: '/home/test', XDG_CONFIG_HOME: '/config' } }), '/config/opencode/skills');
  assert.equal(await getHermesSkillsDirectory({ platform: 'linux', env: { HERMES_HOME: '/home/test/.hermes/profiles/work' } }), '/home/test/.hermes/profiles/work/skills');

  const windowsEnvironment = {
    USERPROFILE: String.raw`C:\Users\test`,
    APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
    CLAUDE_CONFIG_DIR: String.raw`D:\Claude`,
    HERMES_HOME: String.raw`D:\Hermes\profiles\work`,
  };
  assert.equal(getCodexSkillsDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\.agents\skills`);
  assert.equal(getOpenCodeConfigDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\.config\opencode`);
  assert.equal(getOpenCodeInstructionsPath({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\.config\opencode\AGENTS.md`);
  assert.equal(getOpenCodeSkillsDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\.config\opencode\skills`);
  assert.equal(getClaudeSkillsDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`D:\Claude\skills`);
  assert.equal(getLegacyClaudePromptHookSettingsPath({ platform: 'win32', env: windowsEnvironment }), String.raw`D:\Claude\settings.json`);
  assert.equal(getLegacyOpenCodeLoopGuardPath({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\.config\opencode\plugins\kiokuko-loop-guard.js`);
  assert.equal(await getHermesSkillsDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`D:\Hermes\profiles\work\skills`);
});

test('uses the XDG-style OpenCode directory on Windows', () => {
  const options = {
    platform: 'win32' as const,
    env: {
      USERPROFILE: String.raw`C:\Users\test`,
      APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
      LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local`,
    },
  };

  assert.equal(
    getOpenCodeConfigDirectory(options),
    String.raw`C:\Users\test\.config\opencode`,
  );
});

test('honors XDG_CONFIG_HOME before Windows application-data directories', () => {
  const options = {
    platform: 'win32' as const,
    env: {
      USERPROFILE: String.raw`C:\Users\test`,
      APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
      LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local`,
      XDG_CONFIG_HOME: String.raw`D:\xdg-config`,
    },
  };

  assert.equal(
    getOpenCodeConfigDirectory(options),
    String.raw`D:\xdg-config\opencode`,
  );
});

test('treats an empty Windows XDG_CONFIG_HOME as unset', () => {
  assert.equal(
    getOpenCodeConfigDirectory({
      platform: 'win32',
      env: {
        USERPROFILE: String.raw`C:\Users\test`,
        APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
        XDG_CONFIG_HOME: '',
      },
    }),
    String.raw`C:\Users\test\.config\opencode`,
  );
});

test('uses HOME for OpenCode on Windows when USERPROFILE is unavailable', () => {
  assert.equal(
    getOpenCodeConfigDirectory({
      platform: 'win32',
      env: { HOME: String.raw`D:\home\test` },
    }),
    String.raw`D:\home\test\.config\opencode`,
  );
});

test('rejects APPDATA-only OpenCode path resolution on Windows', () => {
  assert.throws(
    () => getOpenCodeConfigDirectory({
      platform: 'win32',
      env: {
        APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
        LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local`,
      },
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

test('keeps OpenCode XDG fallback paths unchanged on Linux and macOS', () => {
  assert.equal(
    getOpenCodeConfigDirectory({ platform: 'linux', env: { HOME: '/home/test' } }),
    '/home/test/.config/opencode',
  );
  assert.equal(
    getOpenCodeConfigDirectory({ platform: 'darwin', env: { HOME: '/Users/test' } }),
    '/Users/test/.config/opencode',
  );
});

test('resolves Linux and macOS Hermes default, named, custom, and profile-shaped homes', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const root = await mkdtemp(path.join(tmpdir(), `kiokuko-hermes-paths-${platform}-`));
    const home = path.join(root, 'home');
    const hermesRoot = path.join(home, '.hermes');
    await mkdir(hermesRoot, { recursive: true });

    const environment = { platform, env: { HOME: home } };
    assert.equal(await getHermesHome(environment), hermesRoot);

    await writeFile(path.join(hermesRoot, 'active_profile'), 'default\n');
    assert.equal(await getHermesHome(environment), hermesRoot);

    const namedProfile = path.join(hermesRoot, 'profiles', 'work');
    await mkdir(namedProfile, { recursive: true });
    await writeFile(path.join(hermesRoot, 'active_profile'), 'work\n');
    assert.equal(await getHermesHome(environment), namedProfile);
    assert.equal(await getHermesConfigPath(environment), path.join(namedProfile, 'config.yaml'));
    assert.equal(await getHermesSkillsDirectory(environment), path.join(namedProfile, 'skills'));

    const customRoot = path.join(root, 'custom-hermes');
    assert.equal(await getHermesHome({ platform, env: { HOME: home, HERMES_HOME: customRoot } }), customRoot);

    const customProfile = path.join(customRoot, 'profiles', 'work');
    await mkdir(customProfile, { recursive: true });
    await writeFile(path.join(customRoot, 'active_profile'), 'other\n');
    assert.equal(
      await getHermesHome({ platform, env: { HOME: home, HERMES_HOME: customProfile } }),
      customProfile,
    );
  }
});

test('rejects invalid or missing active Hermes profiles on Linux and macOS', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    for (const marker of ['', 'Main', 'profile/name', '..', 'a'.repeat(65), 'missing']) {
      const root = await mkdtemp(path.join(tmpdir(), `kiokuko-hermes-invalid-${platform}-`));
      const home = path.join(root, 'home');
      const hermesRoot = path.join(home, '.hermes');
      await mkdir(path.join(hermesRoot, 'profiles'), { recursive: true });
      await writeFile(path.join(hermesRoot, 'active_profile'), `${marker}\n`);

      await assert.rejects(
        getHermesHome({ platform, env: { HOME: home } }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
      );
    }
  }
});

test('uses hermes config path output when no active_profile marker exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-hermes-config-path-'));
  const home = path.join(root, 'home');
  const profileHome = path.join(home, '.hermes', 'profiles', 'main');
  const bin = path.join(root, 'bin');
  const configPath = path.join(profileHome, 'config.yaml');
  await mkdir(profileHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  const hermes = path.join(bin, 'hermes');
  await writeFile(hermes, '#!/bin/sh\nprintf "%s\\n" "$HERMES_CONFIG_PATH"\n');
  await chmod(hermes, 0o755);

  assert.equal(
    await getHermesHome({
      platform: 'linux',
      env: { HOME: home, PATH: bin, HERMES_CONFIG_PATH: configPath },
    }),
    profileHome,
  );
  assert.equal(
    await getHermesConfigPath({
      platform: 'darwin',
      env: { HOME: home, PATH: bin, HERMES_CONFIG_PATH: configPath },
    }),
    profileHome + '/config.yaml',
  );
});

test('rejects a Hermes CLI path that disagrees with a sticky active profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-hermes-sticky-disagreement-'));
  const home = path.join(root, 'home');
  const hermesRoot = path.join(home, '.hermes');
  const expectedHome = path.join(hermesRoot, 'profiles', 'work');
  const otherHome = path.join(hermesRoot, 'profiles', 'other');
  const bin = path.join(root, 'bin');
  await mkdir(expectedHome, { recursive: true });
  await mkdir(otherHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(hermesRoot, 'active_profile'), 'work\n');
  const hermes = path.join(bin, 'hermes');
  await writeFile(hermes, '#!/bin/sh\nprintf "%s\\n" "$HERMES_CONFIG_PATH"\n');
  await chmod(hermes, 0o755);

  await assert.rejects(
    getHermesHome({
      platform: 'linux',
      env: { HOME: home, PATH: bin, HERMES_CONFIG_PATH: path.join(otherHome, 'config.yaml') },
    }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && !error.message.includes(root),
  );
});

test('Hermes config path command failures and malformed output fail explicitly', async () => {
  for (const [name, script] of [
    ['nonzero', '#!/bin/sh\nexit 7\n'],
    ['malformed', '#!/bin/sh\nprintf "relative/config.yaml\\n"\n'],
    ['multiline', '#!/bin/sh\nprintf "/tmp/one/config.yaml\\n/tmp/two/config.yaml\\n"\n'],
  ] as const) {
    const root = await mkdtemp(path.join(tmpdir(), `kiokuko-hermes-cli-${name}-`));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    await mkdir(path.join(home, '.hermes'), { recursive: true });
    await mkdir(bin, { recursive: true });
    const hermes = path.join(bin, 'hermes');
    await writeFile(hermes, script);
    await chmod(hermes, 0o755);

    await assert.rejects(
      getHermesHome({ platform: 'linux', env: { HOME: home, PATH: bin } }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'VALIDATION_ERROR'
        && !error.message.includes(root),
    );
  }
});
