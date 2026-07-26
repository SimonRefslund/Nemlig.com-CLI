import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let writeCounter = 0;

function defaultConfigRoot() {
  if (process.env.NEMLIG_CONFIG_DIR) return process.env.NEMLIG_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "nemlig-cli");
  }
  // Windows has no XDG convention; APPDATA is the roaming per-user store.
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "nemlig-cli");
  }
  return path.join(os.homedir(), ".config", "nemlig-cli");
}

function defaultSessionPath() {
  return path.join(defaultConfigRoot(), "session.json");
}

function setCookieValues(headers) {
  if (typeof headers?.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers?.get?.("set-cookie");
  return value ? [value] : [];
}

export class CookieJar {
  constructor(cookies = {}) {
    this.cookies = new Map(Object.entries(cookies));
  }

  absorb(headers) {
    let changed = false;
    for (const value of setCookieValues(headers)) {
      const [pair, ...attributes] = value.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;

      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => {
        const normalized = attribute.trim().toLowerCase();
        if (normalized === "max-age=0") return true;
        if (!normalized.startsWith("expires=")) return false;
        const expiresAt = Date.parse(attribute.trim().slice(8));
        return Number.isFinite(expiresAt) && expiresAt <= Date.now();
      });

      if (expired || cookieValue === "") {
        changed = this.cookies.delete(name) || changed;
      } else if (this.cookies.get(name) !== cookieValue) {
        this.cookies.set(name, cookieValue);
        changed = true;
      }
    }
    return changed;
  }

  header() {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  clear() {
    this.cookies.clear();
  }

  toJSON() {
    return Object.fromEntries(this.cookies);
  }

  get size() {
    return this.cookies.size;
  }
}

export class SessionStore {
  constructor({ filePath = defaultSessionPath() } = {}) {
    this.filePath = filePath;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      return parsed?.cookies && typeof parsed.cookies === "object"
        ? parsed.cookies
        : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid session file: ${this.filePath}`);
      }
      throw error;
    }
  }

  /**
   * Writes through a temporary file so a crash or a second CLI process cannot
   * leave a half-written session behind. File modes are a no-op on Windows.
   */
  async save(cookies) {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // The counter matters: two saves in the same millisecond would otherwise
    // pick the same temporary name and race each other's rename.
    const temporary = path.join(
      directory,
      `.session.${process.pid}.${(writeCounter += 1).toString(36)}.tmp`,
    );
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, cookies }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    if (process.platform !== "win32") await chmod(this.filePath, 0o600);
  }

  async clear() {
    try {
      await unlink(this.filePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export const internals = { defaultConfigRoot, defaultSessionPath, setCookieValues };
