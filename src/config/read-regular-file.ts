import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { KiokukoError } from '../errors.js';

export interface FileIdentity {
  device: bigint;
  inode: bigint;
}

export interface RegularFileSnapshot {
  content: string;
  mode: number;
  identity: FileIdentity;
}

export interface ReadRegularFileDependencies {
  /** Test seam for proving that reads remain bound to the opened descriptor. */
  afterOpen?: (filePath: string, handle: FileHandle) => void | Promise<void>;
  /** Test seam for preserving an operation failure when descriptor close also fails. */
  closeHandle?: (handle: FileHandle) => Promise<void>;
  /** Test seam for exercising the Windows no-O_NOFOLLOW strategy on any host. */
  platform?: NodeJS.Platform;
}

function errno(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isMissingFile(error: unknown): boolean {
  return errno(error) === 'ENOENT';
}

function isSymlinkFailure(error: unknown): boolean {
  return ['ELOOP', 'EMLINK'].includes(errno(error) ?? '');
}

function changedAfterPlanning(filePath?: string): KiokukoError {
  return new KiokukoError(
    'CONFLICT',
    'Managed file changed after planning',
    filePath === undefined ? {} : { target: filePath },
  );
}

function identityFromStat(info: Awaited<ReturnType<FileHandle['stat']>>): FileIdentity {
  const device = BigInt(info.dev);
  const inode = BigInt(info.ino);
  if (inode === 0n) {
    throw new KiokukoError(
      'SECURITY_REJECTION',
      'The filesystem does not expose a stable file identity required for safe mutation',
    );
  }
  return { device, inode };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function ensureContained(root: string, filePath: string): { root: string; target: string } {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(filePath);
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Managed file must remain inside its repository root');
  }
  return { root: resolvedRoot, target };
}

async function rejectLinkedComponents(root: string, filePath: string): Promise<void> {
  const contained = ensureContained(root, filePath);
  const relative = path.relative(contained.root, contained.target);
  let current = contained.root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new KiokukoError('SECURITY_REJECTION', 'Refusing to traverse a symbolic link');
      }
      if (current !== contained.target && !info.isDirectory()) {
        throw new KiokukoError('VALIDATION_ERROR', `Expected a directory: ${current}`);
      }
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }
}

function decodeUtf8(buffer: Buffer, filePath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', `Managed text file is not valid UTF-8: ${filePath}`);
  }
}

export async function readRegularFile(
  filePath: string,
  dependencies: ReadRegularFileDependencies & { containmentRoot?: string } = {},
): Promise<RegularFileSnapshot | undefined> {
  if (dependencies.containmentRoot !== undefined) {
    await rejectLinkedComponents(dependencies.containmentRoot, filePath);
  }

  let plannedIdentity: FileIdentity | undefined;
  try {
    const planned = await lstat(filePath, { bigint: true });
    if (planned.isSymbolicLink()) {
      throw new KiokukoError('SECURITY_REJECTION', 'Refusing to follow a symbolic link');
    }
    if (!planned.isFile()) throw new KiokukoError('VALIDATION_ERROR', `Expected a regular file: ${filePath}`);
    plannedIdentity = { device: planned.dev, inode: planned.ino };
    if (plannedIdentity.inode === 0n) {
      throw new KiokukoError(
        'SECURITY_REJECTION',
        'The filesystem does not expose a stable file identity required for safe mutation',
      );
    }
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let handle: FileHandle;
  const platform = dependencies.platform ?? process.platform;
  const flags = platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    if (isMissingFile(error)) throw changedAfterPlanning();
    if (isSymlinkFailure(error)) throw new KiokukoError('SECURITY_REJECTION', 'Refusing to follow a symbolic link');
    throw error;
  }
  let operationResult: { value: RegularFileSnapshot } | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    await dependencies.afterOpen?.(filePath, handle);
    const info = await handle.stat();
    if (!info.isFile()) throw new KiokukoError('VALIDATION_ERROR', `Expected a regular file: ${filePath}`);
    const identity = identityFromStat(info);
    if (!sameIdentity(identity, plannedIdentity)) throw changedAfterPlanning();
    const content = decodeUtf8(await handle.readFile(), filePath);
    operationResult = { value: { content, mode: info.mode & 0o777, identity } };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await (dependencies.closeHandle ?? ((openHandle: FileHandle) => openHandle.close()))(handle);
  } catch (closeError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        'Regular-file read failed and its file descriptor could not be closed',
      );
    }
    throw closeError;
  }
  if (operationFailed) throw operationError;
  if (operationResult === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Regular-file read produced no result');
  }
  return operationResult.value;
}
