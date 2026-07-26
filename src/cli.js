#!/usr/bin/env node

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

import { NemligApi, todayIso } from "./api.js";
import { compareBasket } from "./compare.js";
import {
  renderAccount,
  renderBasket,
  renderCheckoutStatus,
  renderComparison,
  renderDeliveryDays,
  renderGomaProducts,
  renderOrder,
  renderOrders,
  renderProduct,
  renderProducts,
  renderSuggestions,
} from "./format.js";
import { GOMA_SORTS, GOMA_STORES, GomaApi, resolveStore } from "./goma.js";
import { VERSION } from "./version.js";

const HELP = `nemlig — use nemlig.com from the command line

Usage:
  nemlig search <query> [--limit <n>] [--offset <n>] [--json]
  nemlig suggest <query> [--json]
  nemlig product <id-slug-or-url> [--json]
  nemlig account login <email>
  nemlig account status [--json]
  nemlig account logout
  nemlig basket [show] [--json]
  nemlig basket add <product-id> [quantity] --yes
  nemlig basket set <product-id> <quantity> --yes
  nemlig basket remove <product-id> --yes
  nemlig basket clear --yes
  nemlig orders [list] [--limit <n>] [--offset <n>] [--json]
  nemlig orders show <order-number> [--json]
  nemlig delivery slots [--days <n>] [--start <yyyy-mm-dd>] [--all] [--json]
  nemlig delivery select <timeslot-id> --yes
  nemlig checkout status [--json]
  nemlig checkout open
  nemlig goma search <query> [--store <name>]... [--sale] [--sort <key>]
                             [--limit <n>] [--offset <n>] [--json]
  nemlig goma stores
  nemlig compare [--store <name>]... [--json]
  nemlig --help
  nemlig --version

Options accept both "--limit 5" and "--limit=5". Use "--" to end option
parsing when a search term starts with a dash.

Examples:
  nemlig search kaffe
  nemlig search "økologisk mælk" --limit 5
  nemlig search kaffe --offset 20 --json
  nemlig suggest kaff
  nemlig product 5035178
  nemlig product kaffe-oeko-5035178
  nemlig account login you@example.com
  nemlig basket add 5035178 2 --yes
  nemlig delivery slots --days 5 --all
  nemlig checkout status
  nemlig checkout open
  nemlig goma search kaffe --sale --sort discount
  nemlig goma search "hakkede tomater" --store Netto --store Lidl
  nemlig compare
  nemlig compare --store "REMA 1000" --json

Price checking uses goma.gg, which tracks offers across Danish chains. "compare"
matches your nemlig.com basket to goma.gg products by name and pack size and
reports the cheapest comparable alternative — it is a guide, not a quote.

Passwords are prompted without echo and are never stored. Session cookies are
stored with user-only permissions. Orders are always placed in Firefox; this
CLI never submits the final purchase request.

Environment:
  NEMLIG_CONFIG_DIR   directory for session.json (default ~/.config/nemlig-cli)
  NEMLIG_TIMEOUT_MS   per-request timeout in milliseconds (default 20000)
  NEMLIG_DEBUG        print stack traces on failure
  GOMA_API_KEY        override the public goma.gg key if it rotates
  GOMA_API_ORIGIN     override the goma.gg API origin`;

const FLAGS = { "--json": "json", "--yes": "yes", "--all": "all", "--sale": "sale" };
const NUMBERS = new Set(["--limit", "--offset", "--days"]);

/** Rejects well-formed but impossible dates such as 2026-99-99. */
function parseIsoDate(raw) {
  if (raw == null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("--start requires a date in YYYY-MM-DD format");
  }
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`--start is not a real date: ${raw}`);
  }
  return raw;
}

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = {
    json: false,
    limit: 20,
    offset: 0,
    days: 7,
    start: null,
    yes: false,
    all: false,
    sale: false,
    sort: "relevance",
    store: [],
  };
  const positional = [];
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (optionsEnded || !arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }

    // Accept both "--limit 5" and "--limit=5".
    const separator = arg.indexOf("=");
    const name = separator === -1 ? arg : arg.slice(0, separator);
    const inline = separator === -1 ? null : arg.slice(separator + 1);
    const takeValue = () => (inline === null ? args[++index] : inline);

    if (FLAGS[name]) {
      if (inline !== null) throw new Error(`${name} does not take a value`);
      options[FLAGS[name]] = true;
    } else if (NUMBERS.has(name)) {
      const raw = takeValue();
      if (raw == null || !/^\d+$/.test(raw)) {
        throw new Error(`${name} requires a non-negative integer`);
      }
      options[name.slice(2)] = Number(raw);
    } else if (name === "--start") {
      options.start = parseIsoDate(takeValue());
    } else if (name === "--store") {
      const raw = takeValue();
      if (!raw) throw new Error("--store requires a store name");
      options.store.push(raw);
    } else if (name === "--sort") {
      const raw = takeValue();
      if (!GOMA_SORTS[raw]) {
        throw new Error(
          `--sort must be one of: ${Object.keys(GOMA_SORTS).join(", ")}`,
        );
      }
      options.sort = raw;
    } else {
      throw new Error(`Unknown option: ${name}`);
    }
  }

  if (options.limit < 1 || options.limit > 100) {
    throw new Error("--limit must be between 1 and 100");
  }
  if (options.days < 1 || options.days > 31) {
    throw new Error("--days must be between 1 and 31");
  }
  return { command, options, positional };
}

export function readSecret(
  prompt = "Password: ",
  { stdin = process.stdin, stderr = process.stderr } = {},
) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Password input requires an interactive terminal");
  }
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk) => {
      const text = String(chunk);
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Login cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function spawn([file, args]) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function openInFirefox(url) {
  const [preferred, fallback] = process.platform === "darwin"
    ? [["open", ["-a", "Firefox", url]], ["open", [url]]]
    : process.platform === "win32"
    ? [["cmd.exe", ["/c", "start", "", url]], null]
    : [["firefox", [url]], ["xdg-open", [url]]];

  try {
    await spawn(preferred);
    return "Firefox";
  } catch (error) {
    if (!fallback) throw error;
    await spawn(fallback);
    return "your default browser";
  }
}

function requireYes(options, action) {
  if (!options.yes) {
    throw new Error(`${action} changes your nemlig.com account; repeat with --yes`);
  }
}

/** Accepts a bare ID or the slug form printed by `search`/`product`. */
function parseProductId(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return text;
  const fromSlug = /(?:^|-)(\d{4,})$/.exec(text);
  if (fromSlug) return fromSlug[1];
  throw new Error(`Not a product ID or slug: ${value ?? "(none)"}`);
}

function parseQuantity(value, { allowZero = true } = {}) {
  if (!/^\d+$/.test(value ?? "")) {
    throw new Error("quantity must be a non-negative integer");
  }
  const quantity = Number(value);
  if (!allowZero && quantity === 0) throw new Error("quantity must be at least 1");
  return quantity;
}

export async function run(
  argv,
  {
    api = new NemligApi(),
    goma = new GomaApi(),
    stdout = process.stdout,
    stderr = process.stderr,
    readPassword = readSecret,
    openUrl = openInFirefox,
  } = {},
) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  const { command, options, positional } = parseArgs(argv);
  const query = positional.join(" ").trim();
  let output;

  if (command === "search") {
    if (!query) throw new Error("search requires a query");
    const result = await api.search(query, options);
    const products = result.Products?.Products ?? [];
    output = options.json
      ? JSON.stringify({
          query: result.SearchQuery ?? query,
          total: result.Products?.NumFound ?? result.ProductsNumFound ?? products.length,
          offset: result.Products?.Start ?? options.offset,
          products,
        }, null, 2)
      : renderProducts(products, {
          total: result.Products?.NumFound ?? result.ProductsNumFound,
          offset: result.Products?.Start ?? options.offset,
          columns: stdout.columns ?? 100,
        });
  } else if (command === "suggest") {
    if (!query) throw new Error("suggest requires a query");
    const result = await api.suggest(query);
    output = options.json
      ? JSON.stringify(result, null, 2)
      : renderSuggestions(result);
  } else if (command === "product") {
    if (!query) throw new Error("product requires an ID, slug, or nemlig.com URL");
    if (positional.length !== 1) {
      throw new Error("product accepts one ID, slug, or URL");
    }
    const product = await api.product(query);
    output = options.json
      ? JSON.stringify(product, null, 2)
      : renderProduct(product);
  } else if (command === "account") {
    const [subcommand = "status", ...values] = positional;
    if (subcommand === "login") {
      if (values.length !== 1 || !values[0].includes("@")) {
        throw new Error("account login requires an email address");
      }
      const password = await readPassword("nemlig.com password: ");
      const user = await api.login(values[0], password);
      output = options.json ? JSON.stringify(user, null, 2) : renderAccount(user);
    } else if (subcommand === "status") {
      if (values.length) throw new Error("account status accepts no arguments");
      const user = await api.currentUser();
      output = options.json ? JSON.stringify(user, null, 2) : renderAccount(user);
    } else if (subcommand === "logout") {
      if (values.length) throw new Error("account logout accepts no arguments");
      await api.logout();
      output = "Logged out; the local session was removed.";
    } else {
      throw new Error(`Unknown account command: ${subcommand}`);
    }
  } else if (command === "basket") {
    const [subcommand = "show", ...values] = positional;
    if (subcommand === "show") {
      if (values.length) throw new Error("basket show accepts no arguments");
      const basket = await api.getBasket();
      output = options.json
        ? JSON.stringify(basket, null, 2)
        : renderBasket(basket);
    } else if (subcommand === "add") {
      if (values.length < 1 || values.length > 2) {
        throw new Error("basket add requires a product-id and optional quantity");
      }
      requireYes(options, "Adding to the basket");
      const productId = parseProductId(values[0]);
      const increment = parseQuantity(values[1] ?? "1", { allowZero: false });
      const current = await api.getBasket();
      const quantity = (current.Lines ?? [])
        .filter((line) => String(line.Id) === productId)
        .reduce((sum, line) => sum + Number(line.Quantity || 0), 0) + increment;
      const basket = await api.setBasketItem(productId, quantity);
      output = options.json
        ? JSON.stringify(basket, null, 2)
        : renderBasket(basket);
    } else if (subcommand === "set") {
      if (values.length !== 2) {
        throw new Error("basket set requires a product-id and quantity");
      }
      requireYes(options, "Changing the basket");
      const basket = await api.setBasketItem(
        parseProductId(values[0]),
        parseQuantity(values[1]),
      );
      output = options.json
        ? JSON.stringify(basket, null, 2)
        : renderBasket(basket);
    } else if (subcommand === "remove") {
      if (values.length !== 1) {
        throw new Error("basket remove requires a product-id");
      }
      requireYes(options, "Removing from the basket");
      const basket = await api.setBasketItem(parseProductId(values[0]), 0);
      output = options.json
        ? JSON.stringify(basket, null, 2)
        : renderBasket(basket);
    } else if (subcommand === "clear") {
      if (values.length) throw new Error("basket clear accepts no arguments");
      requireYes(options, "Clearing the basket");
      const basket = await api.clearBasket();
      output = options.json
        ? JSON.stringify(basket, null, 2)
        : renderBasket(basket);
    } else {
      throw new Error(`Unknown basket command: ${subcommand}`);
    }
  } else if (command === "orders") {
    const [subcommand = "list", ...values] = positional;
    if (subcommand === "list") {
      if (values.length) throw new Error("orders list accepts no arguments");
      const orders = await api.getOrders(options);
      output = options.json
        ? JSON.stringify(orders, null, 2)
        : renderOrders(orders);
    } else if (subcommand === "show") {
      if (values.length !== 1) {
        throw new Error("orders show requires an order number");
      }
      const order = await api.getOrder(values[0]);
      output = options.json
        ? JSON.stringify(order, null, 2)
        : renderOrder(order);
    } else {
      throw new Error(`Unknown orders command: ${subcommand}`);
    }
  } else if (command === "delivery") {
    const [subcommand = "slots", ...values] = positional;
    if (subcommand === "slots") {
      if (values.length) throw new Error("delivery slots accepts no arguments");
      const result = await api.getDeliveryDays({
        days: options.days,
        startDate: options.start || todayIso(),
      });
      output = options.json
        ? JSON.stringify(result, null, 2)
        : renderDeliveryDays(result, { all: options.all });
    } else if (subcommand === "select") {
      if (values.length !== 1 || !/^\d+$/.test(values[0])) {
        throw new Error("delivery select requires a numeric timeslot-id");
      }
      requireYes(options, "Selecting a delivery time");
      const result = await api.selectDeliveryTime(values[0]);
      output = options.json
        ? JSON.stringify(result, null, 2)
        : "Delivery time reserved. Run `nemlig checkout status` to verify it.";
    } else {
      throw new Error(`Unknown delivery command: ${subcommand}`);
    }
  } else if (command === "checkout") {
    const [subcommand = "status", ...values] = positional;
    if (values.length) throw new Error(`checkout ${subcommand} accepts no arguments`);
    if (subcommand === "status") {
      const status = await api.checkoutStatus();
      output = options.json
        ? JSON.stringify(status, null, 2)
        : renderCheckoutStatus(status);
    } else if (subcommand === "open") {
      const settings = await api.websiteSettings();
      const url = new URL(
        settings.BasketPageUrl || "/",
        "https://www.nemlig.com",
      ).href;
      const browser = (await openUrl(url)) || "Firefox";
      output = `Opened ${browser}: ${url}`;
    } else if (subcommand === "place") {
      throw new Error(
        "Final order placement is intentionally completed in Firefox (run: nemlig checkout open)",
      );
    } else {
      throw new Error(`Unknown checkout command: ${subcommand}`);
    }
  } else if (command === "goma") {
    const [subcommand = "search", ...values] = positional;
    if (subcommand === "stores") {
      if (values.length) throw new Error("goma stores accepts no arguments");
      output = options.json
        ? JSON.stringify(GOMA_STORES, null, 2)
        : GOMA_STORES.join("\n");
    } else if (subcommand === "search") {
      const gomaQuery = values.join(" ").trim();
      if (!gomaQuery && !options.sale && !options.store.length) {
        throw new Error("goma search requires a query, --sale, or --store");
      }
      const result = await goma.search(gomaQuery, {
        stores: options.store,
        saleOnly: options.sale,
        sort: options.sort,
        limit: options.limit,
        offset: options.offset,
      });
      output = options.json
        ? JSON.stringify(result, null, 2)
        : renderGomaProducts(result, { columns: stdout.columns ?? 100 });
    } else {
      throw new Error(`Unknown goma command: ${subcommand}`);
    }
  } else if (command === "compare") {
    if (positional.length) throw new Error("compare accepts no arguments");
    // Validate up front; a typo would otherwise fail once per basket line.
    options.store.forEach(resolveStore);
    const basket = await api.getBasket();
    const lineCount = basket?.Lines?.length ?? 0;
    const showProgress = !options.json && stderr?.isTTY && lineCount > 0;
    const result = await compareBasket(basket, goma, {
      stores: options.store.length ? options.store : null,
      onProgress: showProgress
        ? (done, total) => stderr.write(`\rChecking goma.gg… ${done}/${total}`)
        : null,
    });
    if (showProgress) stderr.write("\r\u001b[2K");
    output = options.json
      ? JSON.stringify(result, null, 2)
      : renderComparison(result, { columns: stdout.columns ?? 100 });
  } else {
    throw new Error(`Unknown command: ${command ?? "(none)"}`);
  }

  stdout.write(`${output}\n`);
  return 0;
}

export const EXIT = {
  ok: 0,
  failure: 1,
  auth: 2,
  upstream: 3,
  usage: 64,
};

/** Maps a thrown error onto a stable exit code scripts can branch on. */
export function exitCodeFor(error) {
  const isApiError = error?.name === "NemligApiError" || error?.name === "GomaApiError";
  if (!isApiError) return EXIT.usage;
  if (error.status === 401 || error.status === 403) return EXIT.auth;
  return EXIT.upstream;
}

const MINIMUM_NODE_MAJOR = 20;

function checkRuntime(version = process.versions.node) {
  const major = Number.parseInt(version, 10);
  if (Number.isFinite(major) && major < MINIMUM_NODE_MAJOR) {
    throw new Error(
      `nemlig-cli needs Node.js ${MINIMUM_NODE_MAJOR} or newer; this is ${version}`,
    );
  }
}

// pathToFileURL, not a string template: Windows paths are not valid URL paths.
const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const fail = (error, code) => {
    process.stderr.write(`Error: ${error.message}\n`);
    if (process.env.NEMLIG_DEBUG) process.stderr.write(`${error.stack}\n`);
    process.exitCode = code ?? exitCodeFor(error);
  };

  try {
    checkRuntime();
    run(process.argv.slice(2)).catch((error) => fail(error));
  } catch (error) {
    fail(error, EXIT.failure);
  }
}

export const internals = { checkRuntime };
