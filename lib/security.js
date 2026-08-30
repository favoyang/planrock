const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { LIMITS, STORAGE_DIR } = require("./constants");

const IS_POSIX = process.platform !== "win32";
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function diagnostic(code, severity, message, context = {}) {
  return {
    code,
    severity,
    message: truncateUtf8(message, LIMITS.diagnosticBytes).value,
    ...context,
  };
}

function truncateUtf8(value, maxBytes) {
  const input = String(value ?? "");
  if (Buffer.byteLength(input) <= maxBytes) {
    return { value: input, truncated: false, hash: null };
  }
  const buffer = Buffer.from(input);
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: buffer.subarray(0, end).toString("utf8"),
    truncated: true,
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

function ensureOwned(stat, target, expectedType) {
  if (expectedType === "directory" && !stat.isDirectory()) {
    throw new Error(`${target} is not a directory`);
  }
  if (expectedType === "file" && !stat.isFile()) {
    throw new Error(`${target} is not a regular file`);
  }
  if (IS_POSIX && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${target} is not owned by the current user`);
  }
}

function ensureStorage() {
  const parent = path.dirname(STORAGE_DIR);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    const before = fs.lstatSync(STORAGE_DIR);
    if (before.isSymbolicLink()) throw new Error(`${STORAGE_DIR} must not be a symlink`);
    ensureOwned(before, STORAGE_DIR, "directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { fs.mkdirSync(STORAGE_DIR, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
    const created = fs.lstatSync(STORAGE_DIR);
    if (created.isSymbolicLink()) throw new Error(`${STORAGE_DIR} must not be a symlink`);
    ensureOwned(created, STORAGE_DIR, "directory");
  }
  if (IS_POSIX) fs.chmodSync(STORAGE_DIR, 0o700);
  return STORAGE_DIR;
}

function assertManagedFile(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`${target} must not be a symlink`);
    ensureOwned(stat, target, "file");
    if (IS_POSIX) fs.chmodSync(target, 0o600);
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function verifyDirectoryGuards(guards) {
  for (const guard of guards) {
    const stat = fs.lstatSync(guard.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== guard.dev || stat.ino !== guard.ino) throw Object.assign(new Error(`${guard.path} parent directory identity changed`), { code: "PLANROCK_IDENTITY_CHANGED" });
  }
}

function safeReadFile(target, maxBytes, { requireOwned = true, directoryGuards = [] } = {}) {
  verifyDirectoryGuards(directoryGuards);
  const before = fs.lstatSync(target);
  if (before.isSymbolicLink()) throw Object.assign(new Error(`${target} is a symlink`), { code: "PLANROCK_SYMLINK" });
  if (!before.isFile()) throw new Error(`${target} is not a regular file`);
  if (requireOwned && IS_POSIX && typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error(`${target} is not owned by the current user`);
  if (before.size > maxBytes) {
    throw Object.assign(new Error(`${target} exceeds ${maxBytes} bytes`), { code: "PLANROCK_FILE_TOO_LARGE" });
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${target} is not a regular file`);
    if (requireOwned && IS_POSIX && typeof process.getuid === "function" && opened.uid !== process.getuid()) throw new Error(`${target} is not owned by the current user`);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw Object.assign(new Error(`${target} changed during inspection`), { code: "PLANROCK_IDENTITY_CHANGED" });
    }
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const read = fs.readSync(fd, content, offset, opened.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (offset !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw Object.assign(new Error(`${target} changed while being read`), { code: "PLANROCK_IDENTITY_CHANGED" });
    }
    verifyDirectoryGuards(directoryGuards);
    return { buffer: content, stat: opened };
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWriteJson(target, value, maxBytes) {
  ensureStorage();
  assertManagedFile(target);
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (buffer.length >= maxBytes) throw new Error(`Serialized data for ${target} exceeds its write limit`);
  const temporary = path.join(STORAGE_DIR, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (IS_POSIX) fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    if (IS_POSIX) fs.chmodSync(target, 0o600);
    syncDirectory(STORAGE_DIR);
  } finally {
    if (fd !== null && fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function syncDirectory(directory, { platform = process.platform, fsModule = fs } = {}) {
  if (platform === "win32") return;
  const dirFd = fsModule.openSync(directory, fsModule.constants.O_RDONLY);
  try { fsModule.fsyncSync(dirFd); } finally { fsModule.closeSync(dirFd); }
}

function secureRandom(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function withStorageLock(name, callback) {
  ensureStorage();
  const lockPath = path.join(STORAGE_DIR, `${name}.lock`);
  const deadline = Date.now() + 10_000;
  let nonce;
  while (!nonce) {
    const candidate = secureRandom(18);
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      atomicWriteJson(path.join(lockPath, "lock.json"), { nonce: candidate, pid: process.pid, createdAt: new Date().toISOString() }, 64 * 1024);
      nonce = candidate;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try { existing = JSON.parse(safeReadFile(path.join(lockPath, "lock.json"), 64 * 1024).buffer.toString("utf8")); } catch {
        if (Date.now() >= deadline) throw new Error(`Planrock ${name} lock is ambiguous`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      if ((!processAlive(existing.pid) || Date.now() - Date.parse(existing.createdAt) > 5 * 60_000) && existing.nonce) {
        const quarantine = `${lockPath}.stale.${secureRandom(8)}`;
        try { fs.renameSync(lockPath, quarantine); fs.unlinkSync(path.join(quarantine, "lock.json")); fs.rmdirSync(quarantine); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Planrock ${name} lock`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return callback(); } finally {
    const current = JSON.parse(safeReadFile(path.join(lockPath, "lock.json"), 64 * 1024).buffer.toString("utf8"));
    if (current.nonce !== nonce) throw new Error(`Planrock ${name} lock ownership changed`);
    const quarantine = `${lockPath}.done.${secureRandom(8)}`; fs.renameSync(lockPath, quarantine); fs.unlinkSync(path.join(quarantine, "lock.json")); fs.rmdirSync(quarantine);
  }
}

module.exports = {
  IS_POSIX,
  assertManagedFile,
  atomicWriteJson,
  diagnostic,
  ensureStorage,
  safeReadFile,
  secureRandom,
  syncDirectory,
  truncateUtf8,
  withStorageLock,
};
