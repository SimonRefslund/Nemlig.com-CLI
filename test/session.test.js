import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CookieJar, SessionStore, internals } from "../src/session.js";

const onWindows = process.platform === "win32";

test("cookie jar absorbs and removes response cookies", () => {
  const jar = new CookieJar({ Existing: "one" });
  jar.absorb(new Headers({
    "set-cookie": "Session=secret; Path=/; HttpOnly",
  }));
  assert.match(jar.header(), /Existing=one/);
  assert.match(jar.header(), /Session=secret/);

  jar.absorb(new Headers({
    "set-cookie": "Session=; Max-Age=0; Path=/",
  }));
  assert.doesNotMatch(jar.header(), /Session=/);
});

test("session store round-trips cookies and clears cleanly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nemlig-session-"));
  const filePath = path.join(directory, "session.json");
  const store = new SessionStore({ filePath });
  await store.save({ Session: "secret" });

  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")).cookies, {
    Session: "secret",
  });
  await store.clear();
  assert.deepEqual(await store.load(), {});
});

test("session files are written with user-only permissions", { skip: onWindows }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nemlig-session-"));
  const filePath = path.join(directory, "session.json");
  await new SessionStore({ filePath }).save({ Session: "secret" });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test("saving leaves no temporary files behind", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nemlig-session-"));
  const store = new SessionStore({ filePath: path.join(directory, "session.json") });
  await store.save({ A: "1" });
  await store.save({ A: "2" });
  assert.deepEqual(await readdir(directory), ["session.json"]);
  assert.deepEqual(await store.load(), { A: "2" });
});

test("a concurrent save never leaves a half-written session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nemlig-session-"));
  const filePath = path.join(directory, "session.json");
  const store = new SessionStore({ filePath });

  await Promise.all(
    Array.from({ length: 8 }, (_value, index) => store.save({ Session: `v${index}` })),
  );
  // Whichever write landed last, the file must still be valid JSON.
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  assert.match(parsed.cookies.Session, /^v\d$/);
});

test("the config directory follows the platform convention", () => {
  const previous = { ...process.env };
  try {
    delete process.env.NEMLIG_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    const fallback = internals.defaultConfigRoot();
    if (onWindows && process.env.APPDATA) {
      assert.ok(fallback.startsWith(process.env.APPDATA));
    } else {
      assert.ok(fallback.endsWith(path.join(".config", "nemlig-cli")));
    }

    process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "xdg");
    assert.equal(
      internals.defaultConfigRoot(),
      path.join(os.tmpdir(), "xdg", "nemlig-cli"),
    );

    process.env.NEMLIG_CONFIG_DIR = path.join(os.tmpdir(), "explicit");
    assert.equal(internals.defaultConfigRoot(), path.join(os.tmpdir(), "explicit"));
  } finally {
    process.env = previous;
  }
});
