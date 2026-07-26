import assert from "node:assert/strict";
import test from "node:test";

import {
  EXIT,
  browserCandidates,
  exitCodeFor,
  internals,
  openInBrowser,
  parseArgs,
  run,
} from "../src/cli.js";
import { GomaApiError } from "../src/goma.js";
import { NemligApiError } from "../src/api.js";

function outputBuffer(columns = 100) {
  return {
    columns,
    value: "",
    write(chunk) {
      this.value += chunk;
    },
  };
}

test("parseArgs supports multi-word searches and pagination", () => {
  assert.deepEqual(
    parseArgs(["search", "økologisk", "mælk", "--limit", "5", "--offset", "10"]),
    {
      command: "search",
      options: {
        json: false,
        limit: 5,
        offset: 10,
        days: null,
        start: null,
        yes: false,
        all: false,
        sale: false,
        sort: "relevance",
        store: [],
        orders: 10,
        "min-orders": 2,
        from: null,
        history: false,
      },
      positional: ["økologisk", "mælk"],
    },
  );
});

test("options accept both --name value and --name=value", () => {
  const spaced = parseArgs(["search", "kaffe", "--limit", "5", "--start", "2026-07-27"]);
  const inline = parseArgs(["search", "kaffe", "--limit=5", "--start=2026-07-27"]);
  assert.deepEqual(spaced, inline);
  assert.equal(inline.options.limit, 5);
  assert.equal(inline.options.start, "2026-07-27");
});

test("-- ends option parsing so queries may start with a dash", () => {
  const parsed = parseArgs(["search", "--", "--rabat"]);
  assert.deepEqual(parsed.positional, ["--rabat"]);
});

test("impossible calendar dates are rejected", () => {
  assert.throws(
    () => parseArgs(["delivery", "slots", "--start", "2026-99-99"]),
    /not a real date/,
  );
  assert.throws(
    () => parseArgs(["delivery", "slots", "--start", "2026-02-30"]),
    /not a real date/,
  );
  assert.doesNotThrow(() => parseArgs(["delivery", "slots", "--start", "2028-02-29"]));
});

test("boolean flags reject inline values", () => {
  assert.throws(() => parseArgs(["basket", "clear", "--yes=please"]), /does not take a value/);
});

test("search renders products", async () => {
  const stdout = outputBuffer();
  const api = {
    async search(query, options) {
      assert.equal(query, "kaffe");
      assert.equal(options.limit, 20);
      return {
        SearchQuery: query,
        Products: {
          NumFound: 1,
          Start: 0,
          Products: [{
            Id: "5035178",
            Name: "Kaffe øko.",
            Brand: "nemlig basic",
            Price: 55.75,
            UnitPriceCalc: 139.38,
            UnitPriceLabel: "kr/kg",
          }],
        },
      };
    },
  };

  assert.equal(await run(["search", "kaffe"], { api, stdout }), 0);
  assert.match(stdout.value, /Kaffe øko\./);
  assert.match(stdout.value, /Showing 1–1 of 1 products/);
});

test("JSON mode emits machine-readable product search results", async () => {
  const stdout = outputBuffer();
  const api = {
    async search() {
      return {
        SearchQuery: "kaffe",
        Products: { NumFound: 1, Start: 0, Products: [{ Id: "1" }] },
      };
    },
  };

  await run(["search", "kaffe", "--json"], { api, stdout });
  assert.deepEqual(JSON.parse(stdout.value), {
    query: "kaffe",
    total: 1,
    offset: 0,
    products: [{ Id: "1" }],
  });
});

test("invalid limits are rejected", () => {
  assert.throws(
    () => parseArgs(["search", "kaffe", "--limit", "101"]),
    /between 1 and 100/,
  );
});

test("basket mutations require explicit confirmation", async () => {
  const stdout = outputBuffer();
  let mutated = false;
  const api = {
    async setBasketItem() {
      mutated = true;
      return {};
    },
  };

  await assert.rejects(
    () => run(["basket", "set", "5035178", "2"], { api, stdout }),
    /repeat with --yes/,
  );
  assert.equal(mutated, false);
});

test("basket set sends an absolute quantity", async () => {
  const stdout = outputBuffer();
  const api = {
    async setBasketItem(productId, quantity) {
      assert.equal(productId, "5035178");
      assert.equal(quantity, 2);
      return {
        Lines: [{ Id: productId, Name: "Kaffe", Quantity: quantity, Price: 100 }],
        TotalPrice: 100,
      };
    },
  };

  await run(["basket", "set", "5035178", "2", "--yes"], { api, stdout });
  assert.match(stdout.value, /2 × Kaffe/);
});

test("basket commands accept the slug form printed by search", async () => {
  const stdout = outputBuffer();
  let received;
  const api = {
    async setBasketItem(productId, quantity) {
      received = { productId, quantity };
      return { Lines: [] };
    },
  };

  await run(["basket", "remove", "kaffe-oeko-5035178", "--yes"], { api, stdout });
  assert.deepEqual(received, { productId: "5035178", quantity: 0 });
});

test("orders show renders a readable order instead of raw JSON", async () => {
  const stdout = outputBuffer();
  const api = {
    async getOrder(orderNumber) {
      assert.equal(orderNumber, "1000000001");
      return {
        OrderNumber: "1000000001",
        Total: 691.13,
        SubTotal: 636.33,
        NumberOfProducts: 41,
        ShippingPrice: 27,
        TotalProductDiscountPrice: 121.41,
        DeliveryTime: { Start: "2026-07-18T17:00:00", End: "2026-07-18T19:00:00" },
        Lines: [{ Id: "5604576", Name: "Miami Vice Pale Ale", Quantity: 4, Price: 40 }],
      };
    },
  };

  await run(["orders", "show", "1000000001"], { api, stdout });
  assert.match(stdout.value, /Order 1000000001/);
  assert.match(stdout.value, /4 × Miami Vice Pale Ale/);
  assert.match(stdout.value, /Sat, 18 Jul 2026 17:00–19:00/);
  assert.match(stdout.value, /Total:\s+691,13/);
  assert.doesNotMatch(stdout.value, /"OrderNumber"/);
});

test("checkout open delegates to the browser without placing an order", async () => {
  const stdout = outputBuffer();
  let opened;
  const api = {
    async websiteSettings() {
      return { BasketPageUrl: "/basket" };
    },
  };

  await run(["checkout", "open"], {
    api,
    stdout,
    openUrl: async (url) => {
      opened = url;
      return "your browser";
    },
  });
  assert.equal(opened, "https://www.nemlig.com/basket");
  assert.match(stdout.value, /Opened your browser/);
});

test("each platform gets its default-browser opener, not a named browser", () => {
  const url = "https://www.nemlig.com/basket";
  assert.deepEqual(browserCandidates(url, "darwin"), [["open", [url]]]);
  assert.deepEqual(browserCandidates(url, "win32"), [
    ["cmd.exe", ["/c", "start", "", url]],
  ]);
  assert.deepEqual(browserCandidates(url, "linux")[0], ["xdg-open", [url]]);

  // No opener may hard-code a browser; the system default is the whole point.
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const [file] of browserCandidates(url, platform)) {
      assert.doesNotMatch(file, /firefox|chrome|safari|edge/i);
    }
  }
});

test("Linux falls through its openers until one works", async () => {
  const tried = [];
  const browser = await openInBrowser("https://example.com", {
    platform: "linux",
    run: async ([file]) => {
      tried.push(file);
      if (file !== "wslview") throw new Error(`${file}: not found`);
    },
  });
  assert.deepEqual(tried, ["xdg-open", "wslview"]);
  assert.equal(browser, "your browser");
});

test("when no browser can be opened the URL is printed for the user", async () => {
  await assert.rejects(
    () =>
      openInBrowser("https://www.nemlig.com/basket", {
        platform: "linux",
        run: async () => {
          throw new Error("not found");
        },
      }),
    /Open this URL yourself: https:\/\/www\.nemlig\.com\/basket/,
  );
});

test("checkout place is intentionally unavailable", async () => {
  await assert.rejects(
    () => run(["checkout", "place"], { api: {}, stdout: outputBuffer() }),
    /completed in your browser/,
  );
});

test("goma search passes filters through and renders offers", async () => {
  const stdout = outputBuffer();
  let received;
  const goma = {
    async search(query, options) {
      received = { query, options };
      return {
        products: [{
          store_name: "Netto", product_name: "Kaffe", current_price: 39,
          normal_price: 75.95, is_on_sale: true, amount: 400, unit: "g",
          sale_valid_to: "2026-08-01T23:59:59+00:00",
        }],
        total: 206,
        onSale: 206,
      };
    },
  };

  await run(
    ["goma", "search", "kaffe", "--store", "Netto", "--sale", "--sort", "discount"],
    { api: {}, goma, stdout },
  );
  assert.equal(received.query, "kaffe");
  assert.deepEqual(received.options.stores, ["Netto"]);
  assert.equal(received.options.saleOnly, true);
  assert.equal(received.options.sort, "discount");
  assert.match(stdout.value, /Netto\s+Kaffe\s+39,00/);
  assert.match(stdout.value, /206 on sale/);
});

test("--store repeats to build a multi-store filter", () => {
  const { options } = parseArgs(["goma", "search", "mælk", "--store", "Netto", "--store=Lidl"]);
  assert.deepEqual(options.store, ["Netto", "Lidl"]);
});

test("an unknown sort key is rejected with the valid keys", () => {
  assert.throws(
    () => parseArgs(["goma", "search", "kaffe", "--sort", "cheapest"]),
    /--sort must be one of: relevance, price-asc/,
  );
});

test("compare rejects an unknown store before touching the basket", async () => {
  let fetchedBasket = false;
  const api = {
    async getBasket() {
      fetchedBasket = true;
      return { Lines: [] };
    },
  };
  await assert.rejects(
    () => run(["compare", "--store", "Aldi"], { api, goma: {}, stdout: outputBuffer() }),
    /Unknown store "Aldi"/,
  );
  assert.equal(fetchedBasket, false);
});

test("compare reports the cheaper alternative and the saving", async () => {
  const stdout = outputBuffer();
  const api = {
    async getBasket() {
      return {
        TotalPrice: 34.74,
        Lines: [{
          Id: "1", Name: "Fusilli", Brand: "Garofalo", Description: "500 g",
          Quantity: 1, Price: 17.37,
        }],
      };
    },
  };
  const goma = {
    async search() {
      return {
        products: [{
          store_name: "Lidl", product_name: "Fusilli", brand: "Garofalo",
          amount: 500, unit: "g", current_price: 5.95,
        }],
        total: 1,
        onSale: 0,
      };
    },
  };

  await run(["compare"], { api, goma, stdout, stderr: { write() {} } });
  assert.match(stdout.value, /Fusilli/);
  assert.match(stdout.value, /Lidl/);
  assert.match(stdout.value, /Estimated saving:\s+11,42/);
});

function historyApi(basketLines = []) {
  const written = [];
  return {
    written,
    async getOrders() {
      return { Orders: [{ OrderNumber: "1" }, { OrderNumber: "2" }] };
    },
    async getOrder(number) {
      return {
        OrderNumber: number,
        DeliveryTime: {
          Start: number === "1" ? "2026-05-16T17:00:00" : "2026-06-20T17:00:00",
        },
        Lines: [{ Id: "5001", Name: "Sødmælk øko.", Quantity: 3, ItemPrice: 15 }],
      };
    },
    async getBasket() {
      return { Lines: basketLines };
    },
    async setBasketItem(productId, quantity) {
      written.push({ productId, quantity });
      return {};
    },
  };
}

test("habits reports the cadence it inferred from past orders", async () => {
  const stdout = outputBuffer();
  await run(["habits"], { api: historyApi(), goma: {}, stdout, stderr: { write() {} } });
  assert.match(stdout.value, /Sødmælk øko\./);
  assert.match(stdout.value, /2\/2/);
  assert.match(stdout.value, /35 d/);
});

test("reorder proposes but writes nothing without --yes", async () => {
  const stdout = outputBuffer();
  const api = historyApi();
  await run(["reorder"], { api, goma: {}, stdout, stderr: { write() {} } });

  assert.deepEqual(api.written, [], "a dry run must not touch the basket");
  assert.match(stdout.value, /Would add/);
  assert.match(stdout.value, /Repeat with --yes/);
});

test("reorder --yes adds the typical quantity", async () => {
  const stdout = outputBuffer();
  const api = historyApi();
  await run(["reorder", "--yes"], { api, goma: {}, stdout, stderr: { write() {} } });

  assert.deepEqual(api.written, [{ productId: "5001", quantity: 3 }]);
  assert.match(stdout.value, /Added/);
});

test("reorder is idempotent: what is already in the basket is left alone", async () => {
  const stdout = outputBuffer();
  const api = historyApi([{ Id: "5001", Quantity: 1 }]);
  await run(["reorder", "--yes"], { api, goma: {}, stdout, stderr: { write() {} } });

  assert.deepEqual(api.written, [], "running twice must not double a line");
  assert.match(stdout.value, /already in the basket/);
});

test("reorder --from repeats one order exactly", async () => {
  const stdout = outputBuffer();
  const api = historyApi();
  await run(["reorder", "--from", "1063490166", "--yes"], {
    api,
    goma: {},
    stdout,
    stderr: { write() {} },
  });
  assert.deepEqual(api.written, [{ productId: "5001", quantity: 3 }]);
});

test("--from requires an order number", () => {
  assert.throws(() => parseArgs(["reorder", "--from", "last"]), /requires an order number/);
});

test("exit codes distinguish usage, auth, and upstream failures", () => {
  assert.equal(exitCodeFor(new Error("quantity must be a non-negative integer")), EXIT.usage);
  assert.equal(exitCodeFor(new NemligApiError("nope", { status: 401 })), EXIT.auth);
  assert.equal(exitCodeFor(new NemligApiError("boom", { status: 500 })), EXIT.upstream);
  assert.equal(exitCodeFor(new GomaApiError("boom", { status: 503 })), EXIT.upstream);
  assert.equal(exitCodeFor(new NemligApiError("offline")), EXIT.upstream);
  // A bad --store or --sort is the caller's typo, not an upstream failure.
  assert.equal(exitCodeFor(new GomaApiError("bad store", { usage: true })), EXIT.usage);
});

test("an unsupported Node.js release is reported clearly", () => {
  assert.throws(() => internals.checkRuntime("18.20.4"), /needs Node\.js 20 or newer/);
  assert.doesNotThrow(() => internals.checkRuntime("20.11.0"));
  assert.doesNotThrow(() => internals.checkRuntime("24.0.0"));
});
