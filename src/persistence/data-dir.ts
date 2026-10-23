/**
 * Profile-scoped persistence directory resolution, atomic file IO and tolerant
 * JSON/JSONL recovery (P0-4 persistence layer).
 *
 * Ownership: src/persistence/** (added by the persistence engineer).
 *
 * Durability rules enforced here:
 *  - every structured write goes to a sibling temp file, is fsynced, then renamed
 *    over its target, so a crash can never expose a half-written snapshot;
 *  - a truncated JSON document, or a JSONL tail written without its terminating
 *    newline, is detected on load; the damaged file is quarantined as
 *    '<name>.corrupt' (never silently deleted) and the healthy prefix is rewritten
 *    atomically, so already-durable state survives a partial write;
 *  - every recovery decision is reported as a diagnostic string; loading never
 *    throws because of damaged persistence (callers keep working from a clean
 *    state instead of refusing to start).
 *
 * The module owns no domain state: it only resolves paths and moves bytes.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

/** Schema version of every persisted envelope written by this package. */
export const PERSISTENCE_SCHEMA_VERSION = 1 as const;

/** Profile directory name used when no DSH profile is resolved. */
export const DEFAULT_PROFILE_NAME = 'default';

/** Environment variable that pins the persistence root explicitly. */
export const EVO_HARNESS_DATA_ROOT_ENV = 'EVO_HARNESS_DATA_DIR';

/** DSH-wide data root environment variable (fallback). */
export const DSH_DATA_ROOT_ENV = 'DSH_DATA_DIR';

/** DSH profile environment variable (fallback for the profile name). */
export const DSH_PROFILE_ENV = 'DSH_PROFILE';

/** Sub-directory created under the DSH data root by this plugin. */
export const EVO_HARNESS_DATA_SUBDIR = 'evo-harness';

/** Suffix used to quarantine a damaged persistence file. */
export const CORRUPT_SUFFIX = '.corrupt';

/** Append-only record of recovery/repair diagnostics written next to the data. */
export const DIAGNOSTICS_FILE = 'persistence-diagnostics.jsonl';

/** Marker that identifies a write-file temp file of this module. */
export const TEMP_FILE_MARKER = '.tmp-';

/** Failure of a persistence operation; carries a stable machine-readable code. */
export class PersistenceError extends Error {
  readonly code: string;
  readonly filePath: string | undefined;

  constructor(code: string, message: string, filePath?: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    this.filePath = filePath;
  }
}

/** Inputs that locate the profile data directory. */
export interface ProfileDataDirOptions {
  /** Explicit final directory; wins over every other option. */
  readonly dataDir?: string;
  /** DSH profile name; defaults to DSH_PROFILE then 'default'. */
  readonly profile?: string;
  /** Persistence root that contains the 'profiles/<name>' directory. */
  readonly rootDir?: string;
  /** Environment snapshot; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Home directory used by the default root; defaults to os.homedir(). */
  readonly homeDir?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Reduce an arbitrary profile name to a single safe path segment. Path
 * separators, traversal sequences and control characters cannot survive, so a
 * hostile profile can never escape the configured data root.
 */
export function sanitizeProfileName(profile: string | undefined): string {
  if (profile === undefined) {
    return DEFAULT_PROFILE_NAME;
  }
  const replaced = profile.trim().replace(/[^A-Za-z0-9._-]+/g, '_');
  // Collapse dot runs so no '..' segment can survive inside the name, then strip
  // leading/trailing dots (Windows would silently drop them anyway).
  const collapsed = replaced.replace(/\.{2,}/g, '.');
  const normalized = collapsed.replace(/^\.+/, '').replace(/\.+$/, '');
  if (normalized.length === 0 || normalized === '.' || normalized === '..') {
    return DEFAULT_PROFILE_NAME;
  }
  return normalized.slice(0, 64);
}

/**
 * Resolve the profile data directory, in precedence order:
 *  1. options.dataDir (explicit final directory);
 *  2. options.rootDir / EVO_HARNESS_DATA_DIR / DSH_DATA_DIR / <home>/.dsh/,
 *     joined with 'profiles/<sanitized profile>'.
 * The result is absolute and depends only on its inputs (deterministic).
 */
export function resolveProfileDataDir(options: ProfileDataDirOptions = {}): string {
  if (options.dataDir !== undefined && options.dataDir.trim().length > 0) {
    return path.resolve(options.dataDir);
  }
  const env = options.env ?? process.env;
  const explicitRoot = options.rootDir ?? readEnv(env, EVO_HARNESS_DATA_ROOT_ENV);
  const root =
    explicitRoot ?? readEnv(env, DSH_DATA_ROOT_ENV) ?? path.join(options.homeDir ?? homedir(), '.dsh', EVO_HARNESS_DATA_SUBDIR);
  const profile = options.profile ?? readEnv(env, DSH_PROFILE_ENV) ?? DEFAULT_PROFILE_NAME;
  return path.join(path.resolve(root), 'profiles', sanitizeProfileName(profile));
}

/** Create the directory (recursively) when it does not exist yet. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** True when the path exists (file or directory), false on any access error. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically replace a file: write a random sibling temp file, fsync it, then
 * rename it over the target. rename(2) is atomic on POSIX; on Windows Node maps
 * it to MoveFileExW with MOVEFILE_REPLACE_EXISTING, which also replaces an
 * existing target. A failure removes the temp file so no debris is left behind.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string | Uint8Array,
  options: { readonly mode?: number; readonly fsync?: boolean } = {}
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const temp = filePath + TEMP_FILE_MARKER + String(process.pid) + '-' + randomBytes(6).toString('hex');
  let committed = false;
  try {
    const handle = await fs.open(temp, 'wx', options.mode ?? 0o600);
    try {
      await handle.writeFile(contents);
      if (options.fsync !== false) {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    await fs.rename(temp, filePath);
    committed = true;
  } finally {
    if (!committed) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

/** Append one pre-encoded record to a JSONL log, then fsync it. */
export async function appendFileDurable(filePath: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const handle = await fs.open(filePath, 'a', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Read a UTF-8 file, returning undefined when it does not exist. */
export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error instanceof Error ? error : new PersistenceError('read_failed', String(error), filePath);
  }
}

/** Remove a file if present; returns true when a file was actually removed. */
export async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.rm(filePath);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Move a damaged file aside as '<name>.corrupt' (or '<name>.corrupt.<n>' when a
 * previous quarantine exists). The original bytes are preserved for postmortem
 * analysis; the caller is responsible for describing the damage in diagnostics.
 */
export async function quarantineFile(
  filePath: string,
  now: () => number = (): number => Date.now()
): Promise<string | undefined> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }
  let target = filePath + CORRUPT_SUFFIX;
  let suffix = 1;
  while (await pathExists(target)) {
    target = filePath + CORRUPT_SUFFIX + '.' + String(suffix);
    suffix += 1;
  }
  await fs.rename(filePath, target);
  // The quarantine target keeps the file's mtime; the diagnostic only needs a
  // stable timestamp, which the caller supplies through its own now().
  void now;
  return target;
}

/** Remove stale '<name>.tmp-*' leftovers of an interrupted atomic write. */
export async function sweepTempFiles(dir: string): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.includes(TEMP_FILE_MARKER)) {
      continue;
    }
    try {
      await fs.rm(path.join(dir, entry), { force: true });
      removed.push(entry);
    } catch {
      // A concurrent writer may still own the temp file; leave it alone.
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Tolerant JSON / JSONL recovery
// ---------------------------------------------------------------------------

/** One non-blank JSONL line with its parse outcome. */
export interface JsonlLine {
  readonly index: number;
  readonly raw: string;
  readonly value: unknown;
  readonly error: string | null;
}

/** Structural parse of a JSONL document; never throws. */
export interface JsonlParseResult {
  readonly lines: readonly JsonlLine[];
  /** True when the document did not end with a newline (possible torn write). */
  readonly missingTerminator: boolean;
}

/** Parse a JSONL document line by line, tolerating CRLF and blank lines. */
export function parseJsonlText(text: string): JsonlParseResult {
  if (text.length === 0) {
    return { lines: [], missingTerminator: false };
  }
  const missingTerminator = !text.endsWith('\n');
  const body = missingTerminator ? text : text.slice(0, -1);
  const rawLines = body.split('\n');
  const lines: JsonlLine[] = [];
  for (const rawLine of rawLines) {
    const raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (raw.trim().length === 0) {
      continue;
    }
    let value: unknown;
    let error: string | null = null;
    try {
      value = JSON.parse(raw);
    } catch (caught) {
      error = errorMessage(caught);
    }
    lines.push({ index: lines.length, raw, value, error });
  }
  return { lines, missingTerminator };
}

/** Encode one record as a single JSONL line terminated by '\n'. */
export function encodeJsonlRecord(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

/**
 * Persist recovery diagnostics as JSONL next to the data they describe, so an
 * operator can diff what a restart repaired after the process is gone. Failures
 * to write diagnostics are swallowed: observability must never break startup.
 */
export async function recordDiagnostics(
  dataDir: string,
  messages: readonly string[],
  now: () => number = (): number => Date.now()
): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  let payload = '';
  for (const message of messages) {
    payload += encodeJsonlRecord({ at: now(), message });
  }
  try {
    await appendFileDurable(path.join(dataDir, DIAGNOSTICS_FILE), payload);
  } catch {
    // Diagnostics are best effort; the in-memory copy is already reported.
  }
}

function joinRawLines(lines: readonly JsonlLine[], upTo: number): string {
  const kept: string[] = [];
  for (let index = 0; index < upTo; index += 1) {
    const line = lines[index];
    if (line !== undefined) {
      kept.push(line.raw);
    }
  }
  return kept.length === 0 ? '' : kept.join('\n') + '\n';
}

/** Outcome of a tolerant JSONL read. */
export interface JsonlRecovery<T> {
  readonly records: readonly T[];
  readonly existed: boolean;
  /** Path of the quarantined damaged file, when one was moved aside. */
  readonly quarantinedPath?: string;
  /** True when the healthy prefix was rewritten (repair or quarantine). */
  readonly repaired: boolean;
  /** True when the dropped record was an unterminated trailing write. */
  readonly droppedTornTail: boolean;
  /** True when a complete-but-invalid record or an interior line was found. */
  readonly corrupt: boolean;
  readonly diagnostics: readonly string[];
}

/**
 * Read a JSONL log and recover as much durable state as possible.
 *
 * Validation is applied per line through `parse`. Recovery policy:
 *  - the first line that fails to parse or fails `parse` ends the healthy prefix;
 *  - when that line is the unterminated tail of the file it is treated as a torn
 *    append (partial write) and dropped;
 *  - any other bad line is treated as corruption;
 *  - in both cases the original file is quarantined as '<name>.corrupt' and the
 *    healthy prefix is rewritten atomically, so a later load starts clean and the
 *    operator can still inspect the damaged bytes;
 *  - a valid file whose last line lost only its newline is repaired in place.
 */
export async function readJsonlRecovering<T>(
  filePath: string,
  parse: (value: unknown, index: number) => T | undefined
): Promise<JsonlRecovery<T>> {
  const text = await readTextIfExists(filePath);
  if (text === undefined) {
    return { records: [], existed: false, repaired: false, droppedTornTail: false, corrupt: false, diagnostics: [] };
  }
  const diagnostics: string[] = [];
  const parsed = parseJsonlText(text);
  if (parsed.lines.length === 0) {
    if (text.trim().length === 0 && text.length > 0) {
      const quarantinedPath = await quarantineFile(filePath);
      await writeFileAtomic(filePath, '');
      diagnostics.push(
        'persistence: ' + path.basename(filePath) + ' was empty after an interrupted write; it was quarantined as ' +
          path.basename(quarantinedPath ?? filePath) +
          ' and reset'
      );
      return {
        records: [],
        existed: true,
        ...(quarantinedPath === undefined ? {} : { quarantinedPath }),
        repaired: true,
        droppedTornTail: true,
        corrupt: false,
        diagnostics
      };
    }
    return { records: [], existed: true, repaired: false, droppedTornTail: false, corrupt: false, diagnostics };
  }

  const records: T[] = [];
  let cut = parsed.lines.length;
  let invalidError: string | null = null;
  let invalidRaw: string | undefined;
  for (const line of parsed.lines) {
    if (line.error !== null) {
      cut = line.index;
      invalidError = line.error;
      invalidRaw = line.raw;
      break;
    }
    const record = parse(line.value, line.index);
    if (record === undefined) {
      cut = line.index;
      invalidError = 'record failed schema validation';
      invalidRaw = line.raw;
      break;
    }
    records.push(record);
  }

  if (cut === parsed.lines.length) {
    const last = parsed.lines[parsed.lines.length - 1];
    if (parsed.missingTerminator && last !== undefined) {
      await writeFileAtomic(filePath, joinRawLines(parsed.lines, parsed.lines.length));
      diagnostics.push(
        'persistence: ' + path.basename(filePath) + ' was missing its trailing newline; the complete tail record was kept and the file was repaired'
      );
      return { records, existed: true, repaired: true, droppedTornTail: false, corrupt: false, diagnostics };
    }
    return { records, existed: true, repaired: false, droppedTornTail: false, corrupt: false, diagnostics };
  }

  const isLastLine = cut === parsed.lines.length - 1;
  const invalidLine = parsed.lines[cut];
  // A torn append fails to parse and never received its newline. A complete JSON
  // record that fails schema validation is corruption even if it is the last line.
  const droppedTornTail =
    isLastLine && parsed.missingTerminator && invalidLine !== undefined && invalidLine.error !== null;
  const quarantinedPath = await quarantineFile(filePath);
  await writeFileAtomic(filePath, joinRawLines(parsed.lines, cut));
  if (droppedTornTail) {
    diagnostics.push(
      'persistence: dropped a partially written trailing record from ' +
        path.basename(filePath) +
        ' (' +
        String(invalidError) +
        '); the original file was quarantined as ' +
        path.basename(quarantinedPath ?? filePath)
    );
  } else {
    diagnostics.push(
      'persistence: isolated a corrupt record in ' +
        path.basename(filePath) +
        ' at line ' +
        String(cut + 1) +
        ' (' +
        String(invalidError) +
        '); kept ' +
        String(records.length) +
        ' record(s) and quarantined the original as ' +
        path.basename(quarantinedPath ?? filePath)
    );
  }
  return {
    records,
    existed: true,
    ...(quarantinedPath === undefined ? {} : { quarantinedPath }),
    repaired: true,
    droppedTornTail,
    corrupt: !droppedTornTail,
    diagnostics
  };
}

/** Outcome of a tolerant structured-JSON read. */
export interface JsonRecovery<T> {
  readonly value: T | undefined;
  readonly existed: boolean;
  readonly quarantinedPath?: string;
  readonly diagnostics: readonly string[];
}

/**
 * Read a structured JSON snapshot. Parse or schema failures quarantine the file
 * as '<name>.corrupt' and report a diagnostic; a missing file is not an error.
 */
export async function readJsonRecovering<T>(
  filePath: string,
  parse: (value: unknown) => T | undefined
): Promise<JsonRecovery<T>> {
  const text = await readTextIfExists(filePath);
  if (text === undefined) {
    return { value: undefined, existed: false, diagnostics: [] };
  }
  const diagnostics: string[] = [];
  let parsed: unknown;
  let failure: string | null = null;
  if (text.trim().length === 0) {
    failure = 'file was empty (interrupted write)';
  } else {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      failure = errorMessage(error);
    }
  }
  if (failure === null) {
    const value = parse(parsed);
    if (value !== undefined) {
      return { value, existed: true, diagnostics };
    }
    failure = 'snapshot failed schema validation';
  }
  const quarantinedPath = await quarantineFile(filePath);
  diagnostics.push(
    'persistence: ' + path.basename(filePath) + ' was corrupt (' + failure + '); it was quarantined as ' +
      path.basename(quarantinedPath ?? filePath) +
      ' and the default state was used'
  );
  return {
    value: undefined,
    existed: true,
    ...(quarantinedPath === undefined ? {} : { quarantinedPath }),
    diagnostics
  };
}