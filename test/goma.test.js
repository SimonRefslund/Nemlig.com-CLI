import assert from "node:assert/strict";
import test from "node:test";

import { GOMA_STORES, GomaApi, GomaApiError, mapWithLimit, resolveStore } from "../src/goma.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch that only ever settles when its signal aborts. AbortSignal.timeout
 * uses an unref'd timer, so without a ref'd handle of its own the event loop
 * drains before the timeout fires and the promise never settles at all — which
 * on Node 20 and 22 wedges every test that follows.
 */
function neverSettles(_url, options) {
  return new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(
      () => reject(new Error("signal never aborted")),
      5_000,
    );
    options.signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(options.signal.reason);
    });
  });
}

test("store names are resolved case- and punctuation-insensitively", () => {
  assert.equal(resolveStore("rema 1000"), "REMA 1000");
  assert.equal(resolveStore("rema1000"), "REMA 1000");
  assert.equal(resolveStore("FØTEX"), "Føtex");
  assert.equal(resolveStore("min købmand"), "Min Købmand");
  assert.throws(() => resolveStore("Aldi"), /Unknown store "Aldi"/);
  assert.ok(GOMA_STORES.includes("Nemlig"));
});

test("search posts the RPC payload the goma.gg web client uses", async () => {
  let call;
  const api = new GomaApi({
    fetchImpl: async (url, options) => {
      call = { url, options };
      return jsonResponse({ products: [{ product_name: "Kaffe" }], total_count: 7, total_on_sale_count: 2 });
    },
  });

  const result = await api.search("kaffe", {
    stores: ["netto"],
    saleOnly: true,
    sort: "discount",
    limit: 5,
    offset: 10,
  });

  assert.equal(call.url, "https://api.goma.gg/rest/v1/rpc/search_products_public_v1");
  assert.equal(call.options.method, "POST");
  assert.ok(call.options.headers.apikey);
  assert.equal(call.options.headers.authorization, `Bearer ${call.options.headers.apikey}`);

  const body = JSON.parse(call.options.body);
  assert.equal(body.p_search_term, "kaffe");
  assert.equal(body.p_on_sale_only, true);
  assert.deepEqual(body.p_store_filter, ["Netto"]);
  assert.equal(body.p_limit_val, 5);
  assert.equal(body.p_offset_val, 10);
  assert.match(body.p_order_by_clause, /discount_percentage DESC/);
  // The CLI stays out of goma.gg's search analytics.
  assert.equal(body.p_log_search, false);
  assert.equal(body.p_session_id, null);

  assert.deepEqual(result.products, [{ product_name: "Kaffe" }]);
  assert.equal(result.total, 7);
  assert.equal(result.onSale, 2);
});

test("an unknown sort key is rejected before any request", async () => {
  const api = new GomaApi({
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  await assert.rejects(() => api.search("kaffe", { sort: "cheapest" }), /Unknown sort/);
});

test("a rejected key points at the GOMA_API_KEY override", async () => {
  const api = new GomaApi({
    fetchImpl: async () => new Response("no", { status: 401 }),
  });
  await assert.rejects(
    () => api.search("kaffe"),
    (error) => error instanceof GomaApiError && /GOMA_API_KEY/.test(error.message),
  );
});

test("a stalled goma.gg request times out", async () => {
  const api = new GomaApi({ fetchImpl: neverSettles });
  process.env.NEMLIG_TIMEOUT_MS = "50";
  try {
    await assert.rejects(() => api.search("kaffe"), /did not respond within/);
  } finally {
    delete process.env.NEMLIG_TIMEOUT_MS;
  }
});

test("mapWithLimit preserves order and caps concurrency", async () => {
  let running = 0;
  let peak = 0;
  const results = await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});
