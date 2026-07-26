import assert from "node:assert/strict";
import test from "node:test";

import { isRetryableStatus, withRetry } from "../src/retry.js";

const noWait = async () => {};

test("transient upstream statuses are retryable, client errors are not", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, `${status} should retry`);
  }
  for (const status of [200, 400, 401, 403, 404, 409]) {
    assert.equal(isRetryableStatus(status), false, `${status} should not retry`);
  }
});

test("a 503 is retried until it succeeds", async () => {
  let calls = 0;
  const response = await withRetry(
    async () => {
      calls += 1;
      return calls < 3
        ? new Response("busy", { status: 503 })
        : new Response("ok", { status: 200 });
    },
    { wait: noWait },
  );
  assert.equal(calls, 3);
  assert.equal(response.status, 200);
});

test("the last retryable response is returned once retries run out", async () => {
  let calls = 0;
  const response = await withRetry(
    async () => {
      calls += 1;
      return new Response("busy", { status: 503 });
    },
    { retries: 2, wait: noWait },
  );
  assert.equal(calls, 3);
  assert.equal(response.status, 503);
});

test("a 401 is returned immediately without burning retries", async () => {
  let calls = 0;
  await withRetry(
    async () => {
      calls += 1;
      return new Response("no", { status: 401 });
    },
    { wait: noWait },
  );
  assert.equal(calls, 1);
});

test("network errors are retried but timeouts are not", async () => {
  let calls = 0;
  const response = await withRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response("ok", { status: 200 });
    },
    { wait: noWait },
  );
  assert.equal(calls, 2);
  assert.equal(response.status, 200);

  // A timeout is the user's own cap; retrying would multiply the wait.
  let timeoutCalls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          timeoutCalls += 1;
          const error = new Error("timed out");
          error.name = "TimeoutError";
          throw error;
        },
        { wait: noWait },
      ),
    /timed out/,
  );
  assert.equal(timeoutCalls, 1);
});

test("Retry-After is honoured", async () => {
  const waits = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow", { status: 429, headers: { "retry-after": "2" } })
        : new Response("ok", { status: 200 });
    },
    { wait: async (ms) => waits.push(ms) },
  );
  assert.deepEqual(waits, [2000]);
});
