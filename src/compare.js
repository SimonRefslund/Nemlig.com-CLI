import { mapWithLimit, NEMLIG_STORE } from "./goma.js";

/**
 * Comparing a nemlig.com basket against goma.gg is a fuzzy join: the two
 * catalogues share no product IDs, so lines are matched on name similarity and
 * pack size, and every result carries the confidence it was matched with.
 * Only `high` and `medium` matches count toward the savings estimate.
 */

const BASE_UNITS = {
  g: ["g", "gram", "gr"],
  ml: ["ml", "milliliter"],
  stk: ["stk", "styk", "pcs", "piece", "count", "pk"],
};

// Multipliers into the base unit above.
const UNIT_SCALE = {
  g: 1,
  gram: 1,
  gr: 1,
  kg: 1000,
  kilo: 1000,
  ml: 1,
  cl: 10,
  dl: 100,
  l: 1000,
  ltr: 1000,
  liter: 1000,
  stk: 1,
  styk: 1,
  pk: 1,
};

const STOP_WORDS = new Set([
  "øko", "øko.", "økologisk", "og", "med", "m", "uden", "u", "ca", "stk", "fra",
  "the", "of", "de", "la", "i", "organic",
]);

export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[®™]/g, "")
    .replace(/[^a-z0-9æøåäöüé\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Words that make two otherwise identically-named products a different buy.
 * "Mayonnaise" vs "Mayonnaise Light" scores highly on name similarity, but it
 * is not the same product, so such a pair never reaches high confidence.
 */
const VARIANT_MARKERS = new Set([
  "light", "let", "mini", "grov", "fin", "mild", "stærk", "extra", "ekstra",
  "glutenfri", "laktosefri", "sukkerfri", "vegansk", "frost", "frossen",
  "røget", "salt", "usaltet", "hel", "hakket", "revet",
]);

const ORGANIC_MARKERS = new Set(["øko", "økologisk", "organic"]);

export function extractSemanticAttributes(...values) {
  const tokens = normalizeText(values.filter(Boolean).join(" "))
    .split(" ")
    .filter(Boolean);
  return {
    organic: tokens.some((token) => ORGANIC_MARKERS.has(token)),
    variants: [...new Set(tokens.filter((token) => VARIANT_MARKERS.has(token)))].sort(),
  };
}

export function variantMismatch(a, b) {
  const left = new Set(extractSemanticAttributes(a).variants);
  const right = new Set(extractSemanticAttributes(b).variants);
  for (const token of left) if (!right.has(token)) return true;
  for (const token of right) if (!left.has(token)) return true;
  return false;
}

export function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** Dice coefficient over token sets, in [0, 1]. */
export function similarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function baseUnitOf(unit) {
  const normalized = String(unit ?? "").toLowerCase().replace(/[^a-zæøå]/g, "");
  for (const [base, aliases] of Object.entries(BASE_UNITS)) {
    if (aliases.includes(normalized)) return base;
  }
  if (["kg", "kilo"].includes(normalized)) return "g";
  if (["l", "ltr", "liter", "cl", "dl"].includes(normalized)) return "ml";
  return null;
}

/** Converts an amount+unit pair into the base unit (g, ml, or stk). */
export function toBaseAmount(amount, unit) {
  const value = Number(amount);
  const normalized = String(unit ?? "").toLowerCase().replace(/[^a-zæøå]/g, "");
  const scale = UNIT_SCALE[normalized];
  const base = baseUnitOf(unit);
  if (!Number.isFinite(value) || value <= 0 || !base || !scale) return null;
  return { amount: value * scale, base };
}

/**
 * Reads a pack size out of a nemlig description such as
 * "400 g / hele bønner", "0,50 l / ex. pant" or "6 x 33 cl".
 *
 * Descriptions often carry both a count and a weight ("2 stk. / 300 g").
 * Weight and volume win, because that is the basis goma.gg reports and the
 * only one that compares meaningfully across brands.
 */
function parsePackMeasurements(text) {
  const source = String(text ?? "").toLowerCase().replace(/,/g, ".");
  const units = Object.keys(UNIT_SCALE).sort((a, b) => b.length - a.length).join("|");
  const found = [];

  const multi = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*(${units})\\b`,
    "g",
  );
  for (const match of source.matchAll(multi)) {
    const each = toBaseAmount(match[2], match[3]);
    if (each) found.push({ amount: each.amount * Number(match[1]), base: each.base });
  }

  const single = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${units})\\b`, "g");
  for (const match of source.matchAll(single)) {
    const parsed = toBaseAmount(match[1], match[2]);
    if (parsed) found.push(parsed);
  }

  const preferred = found.some((entry) => entry.base !== "stk")
    ? found.filter((entry) => entry.base !== "stk")
    : found;
  const seen = new Set();
  return preferred.filter((entry) => {
    const key = `${entry.base}:${entry.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parsePackSize(text) {
  return parsePackMeasurements(text)[0] ?? null;
}

/** nemlig's own unit price, e.g. UnitPriceCalc 139.38 with "kr./Kg.". */
function packFromUnitPrice(line, perItemPrice) {
  const rate = Number(line?.UnitPriceCalc);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(perItemPrice)) return null;
  const unit = String(line?.UnitPriceLabel ?? "").split("/").pop();
  const base = baseUnitOf(unit);
  const scale = UNIT_SCALE[String(unit ?? "").toLowerCase().replace(/[^a-zæøå]/g, "")];
  if (!base || !scale) return null;
  // rate is price per whole unit (kg/L/piece); convert to the base unit.
  return { amount: (perItemPrice / rate) * scale, base };
}

function resolvePack(line, perItemPrice) {
  const measurements = parsePackMeasurements(line?.Description);
  const implied = packFromUnitPrice(line, perItemPrice);
  if (!measurements.length) {
    return {
      pack: implied,
      packMeasurements: [],
      packImpliedByUnitPrice: implied,
      packAmbiguity: null,
    };
  }

  const comparable = implied
    ? measurements.filter((measurement) => measurement.base === implied.base)
    : measurements;
  const choices = comparable.length ? comparable : measurements;
  const pack = implied
    ? choices.toSorted((a, b) =>
      Math.abs(a.amount - implied.amount) - Math.abs(b.amount - implied.amount)
    )[0]
    : choices[0];

  const relativeDifference = implied && pack.base === implied.base
    ? Math.abs(pack.amount - implied.amount) / implied.amount
    : null;
  const multipleAmounts = choices.some((choice) =>
    choice.base !== pack.base || choice.amount !== pack.amount);
  const materiallyInconsistent = relativeDifference != null && relativeDifference > 0.1;
  const incompatibleUnit = Boolean(implied && !comparable.length);
  const packAmbiguity = materiallyInconsistent || incompatibleUnit ||
      (!implied && multipleAmounts)
    ? {
      reason: incompatibleUnit
        ? "unit-price-base-mismatch"
        : materiallyInconsistent
        ? "unit-price-amount-mismatch"
        : "multiple-description-amounts",
      measurements,
      implied,
    }
    : null;

  return {
    pack,
    packMeasurements: measurements,
    packImpliedByUnitPrice: implied,
    packAmbiguity,
  };
}

export function describeBasketLine(line) {
  const quantity = Math.max(1, Number(line?.Quantity ?? 1));
  const total = Number(line?.Price);
  const perItem = Number.isFinite(total) && total > 0
    ? total / quantity
    : Number(line?.ItemPrice);
  const packResolution = resolvePack(line, perItem);
  const { pack } = packResolution;
  const semantics = extractSemanticAttributes(line?.Name, line?.Brand, line?.Description);
  return {
    id: String(line?.Id ?? ""),
    name: line?.Name ?? "Product",
    brand: line?.Brand ?? "",
    description: line?.Description ?? "",
    quantity,
    perItem: Number.isFinite(perItem) ? perItem : null,
    pack,
    unitPrice: pack && Number.isFinite(perItem) ? perItem / pack.amount : null,
    semantics,
    ...packResolution,
  };
}

function describeCandidate(product) {
  const price = Number(product?.current_price);
  const pack = toBaseAmount(product?.amount, product?.unit);
  const name = product?.product_name ?? "?";
  const brand = product?.brand ?? "";
  return {
    // Kept so price history can be looked up for whichever candidate wins.
    productId: product?.product_id ?? null,
    store: product?.store_name ?? "?",
    name,
    brand,
    price: Number.isFinite(price) ? price : null,
    pack,
    unitPrice: pack && Number.isFinite(price) && price > 0 ? price / pack.amount : null,
    onSale: product?.is_on_sale === true,
    saleValidTo: product?.sale_valid_to ?? null,
    discountPercentage: Number(product?.discount_percentage) || 0,
    url: product?.product_url ?? null,
    semantics: extractSemanticAttributes(name, brand),
  };
}

/** Rates how confidently a goma.gg product stands in for a basket line. */
export function scoreCandidate(line, candidate) {
  const sourceSemantics = line.semantics ??
    extractSemanticAttributes(line.name, line.brand, line.description);
  const candidateSemantics = candidate.semantics ??
    extractSemanticAttributes(candidate.name, candidate.brand, candidate.description);
  const organicRequirementMet = !sourceSemantics.organic || candidateSemantics.organic;
  const variantsMatch =
    sourceSemantics.variants.length === candidateSemantics.variants.length &&
    sourceSemantics.variants.every((variant, index) =>
      variant === candidateSemantics.variants[index]
    );
  const semanticMismatchReasons = [
    organicRequirementMet ? null : "organic_mismatch",
    variantsMatch ? null : "variant_mismatch",
  ].filter(Boolean);

  const nameScore = Math.max(
    similarity(line.name, candidate.name),
    similarity(`${line.brand} ${line.name}`, `${candidate.brand} ${candidate.name}`),
  );
  const brandMatch = Boolean(line.brand) && Boolean(candidate.brand) &&
    normalizeText(line.brand) === normalizeText(candidate.brand);

  const sameBase = Boolean(line.pack) && Boolean(candidate.pack) &&
    line.pack.base === candidate.pack.base;
  const sizeRatio = sameBase ? candidate.pack.amount / line.pack.amount : null;
  const sizeClose = sizeRatio != null && sizeRatio >= 0.9 && sizeRatio <= 1.1;

  const score = Math.min(1, nameScore + (brandMatch ? 0.15 : 0) + (sizeClose ? 0.1 : 0));

  // Tiers deliberately ignore the size bonus baked into `score`: a generic name
  // ("Mayonnaise") must not reach high confidence just because some unrelated
  // brand happens to ship the same pack size. `score` only ranks candidates.
  const named = nameScore >= 0.6 || (brandMatch && nameScore >= 0.5);
  const variant = !variantsMatch;

  let confidence = "low";
  if (named && sameBase && sizeClose && !variant) confidence = "high";
  else if (nameScore >= 0.4 && sameBase) confidence = "medium";

  return {
    score,
    confidence,
    sameBase,
    sizeClose,
    comparable: sameBase,
    semanticEligible: semanticMismatchReasons.length === 0,
    semanticMismatchReasons,
    rejectionReason: semanticMismatchReasons[0] ?? null,
    sourceSemantics,
    candidateSemantics,
    semanticMatch: {
      organic: organicRequirementMet,
      variants: variantsMatch,
    },
  };
}

const COUNTED = new Set(["high", "medium"]);

function addPurchaseEconomics(line, candidate) {
  const requiredAmount = line.pack.amount * line.quantity;
  const packsNeeded = Math.ceil(requiredAmount / candidate.pack.amount);
  const purchaseAmount = packsNeeded * candidate.pack.amount;
  const surplusAmount = purchaseAmount - requiredAmount;
  const purchaseCost = packsNeeded * candidate.price;
  const normalizedCostForRequiredAmount = candidate.unitPrice * requiredAmount;
  const nemligCashCost = line.perItem * line.quantity;
  const normalizedSaving = nemligCashCost - normalizedCostForRequiredAmount;
  return {
    ...candidate,
    requiredAmount,
    packsNeeded,
    purchaseAmount,
    surplusAmount,
    purchaseCost,
    normalizedCostForRequiredAmount,
    normalizedSaving,
  };
}

const CONFIDENCE_RANK = { high: 0, medium: 1 };

function compareRankText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCandidateRank(left, right) {
  return (CONFIDENCE_RANK[left.confidence] ?? 2) -
      (CONFIDENCE_RANK[right.confidence] ?? 2) ||
    left.purchaseCost - right.purchaseCost ||
    right.score - left.score ||
    left.unitPrice - right.unitPrice ||
    compareRankText(left.store, right.store) ||
    compareRankText(left.name, right.name);
}

export const REJECTION_REASONS = [
  "missing_price",
  "unknown_pack",
  "different_unit",
  "low_similarity",
  "variant_mismatch",
  "organic_mismatch",
  "same_store",
];

function emptyRejectionCounts() {
  return Object.fromEntries(REJECTION_REASONS.map((reason) => [reason, 0]));
}

function rawCandidateKey(product) {
  if (product?.product_id != null) return `id:${product.product_id}`;
  return [
    "fields",
    product?.store_name ?? "",
    product?.product_name ?? "",
    product?.brand ?? "",
    product?.amount ?? "",
    product?.unit ?? "",
  ].join("|");
}

function deduplicateProducts(products) {
  const unique = new Map();
  for (const product of products) {
    const key = rawCandidateKey(product);
    if (!unique.has(key)) unique.set(key, product);
  }
  return [...unique.values()];
}

/**
 * Looks each basket line up on goma.gg and reports the best comparable
 * alternative found outside nemlig.com.
 */
export async function compareBasket(basket, goma, {
  stores = null,
  concurrency = 4,
  candidatesPerLine = 20,
  onProgress = null,
} = {}) {
  const lines = (basket?.Lines ?? []).map(describeBasketLine);
  const targetStores = stores?.length ? stores.filter((store) => store !== NEMLIG_STORE) : null;
  const searchCache = new Map();

  const cachedSearch = (query, options) => {
    const key = JSON.stringify([
      query,
      options.stores,
      options.sort,
      options.limit,
      options.offset ?? 0,
    ]);
    if (!searchCache.has(key)) {
      searchCache.set(key, Promise.resolve().then(() => goma.search(query, options)));
    }
    return searchCache.get(key);
  };

  const retrieveQuery = async (query, options) => {
    const relevance = await cachedSearch(query, { ...options, sort: "relevance" });
    const relevanceProducts = relevance?.products ?? [];
    let total = Number(relevance?.total);
    if (!Number.isFinite(total)) total = relevanceProducts.length;
    const batches = [relevanceProducts];
    let requestCount = 1;

    if (total > relevanceProducts.length) {
      const byPrice = await cachedSearch(query, { ...options, sort: "price-asc" });
      const priceProducts = byPrice?.products ?? [];
      const priceTotal = Number(byPrice?.total);
      if (Number.isFinite(priceTotal)) total = Math.max(total, priceTotal);
      batches.push(priceProducts);
      requestCount += 1;
    }

    const products = deduplicateProducts(batches.flat());
    return {
      products,
      requestCount,
      truncated: total > products.length,
    };
  };

  const assess = (line, products) => {
    const eligible = [];
    const rejectedCounts = emptyRejectionCounts();
    for (const product of products) {
      const candidate = describeCandidate(product);
      let reason = null;
      if (candidate.store === NEMLIG_STORE) reason = "same_store";
      else if (candidate.price == null || candidate.price <= 0) reason = "missing_price";
      else if (!line.pack || !candidate.pack) reason = "unknown_pack";

      const score = reason ? null : scoreCandidate(line, candidate);
      if (!reason && !score.sameBase) reason = "different_unit";
      else if (!reason && !score.semanticEligible) reason = score.rejectionReason;
      else if (!reason && score.confidence === "low") reason = "low_similarity";

      if (reason) {
        rejectedCounts[reason] += 1;
      } else {
        eligible.push(addPurchaseEconomics(line, { ...candidate, ...score }));
      }
    }
    return { eligible, rejectedCounts };
  };

  let done = 0;
  const results = await mapWithLimit(lines, concurrency, async (line) => {
    const options = { stores: targetStores, limit: candidatesPerLine };
    let rated = [];
    let products = [];
    let requestCount = 0;
    let truncated = false;
    let error = null;

    try {
      // The product name alone gives the best recall: prefixing the brand
      // narrows goma.gg's similarity search hard (often to a single hit).
      const byName = await retrieveQuery(line.name, options);
      products = byName.products;
      requestCount += byName.requestCount;
      truncated ||= byName.truncated;
      rated = assess(line, products).eligible;

      // Fall back to brand + name when the name alone found nothing solid;
      // for own-brand staples the brand is what disambiguates.
      if (line.brand && !rated.some((candidate) => candidate.confidence === "high")) {
        const byBrand = await retrieveQuery(`${line.brand} ${line.name}`.trim(), options);
        products = deduplicateProducts([...products, ...byBrand.products]);
        requestCount += byBrand.requestCount;
        truncated ||= byBrand.truncated;
      }
    } catch (cause) {
      error = cause.message;
    }
    onProgress?.(++done, lines.length);

    const diagnostics = assess(line, products);
    rated = diagnostics.eligible;
    rated.sort(compareCandidateRank);
    rated = rated.map((candidate, index) => ({
      ...candidate,
      selectionRank: index + 1,
    }));

    const best = rated[0] ?? null;
    const nemligCashCost = line.perItem * line.quantity;
    const cheaper = Boolean(best && Number.isFinite(nemligCashCost) &&
      best.purchaseCost < nemligCashCost);
    // Cash savings value surplus at zero: every rival pack must be purchased.
    const saving = cheaper
      ? nemligCashCost - best.purchaseCost
      : 0;
    const normalizedSaving = best?.normalizedSaving ?? 0;

    return {
      line,
      best,
      alternatives: rated.slice(0, 3),
      cheaper,
      saving,
      normalizedSaving,
      retrievalCount: products.length,
      requestCount,
      eligibleCount: rated.length,
      rejectedCounts: diagnostics.rejectedCounts,
      truncated,
      selectionReason: best?.confidence === "high"
        ? "high_confidence_preferred"
        : best
        ? "medium_confidence_fallback"
        : null,
      winnerReason: error
        ? "lookup_failed"
        : best?.confidence === "high"
        ? "high_confidence_preferred"
        : best
        ? "medium_confidence_fallback"
        : products.length
        ? "all_candidates_rejected"
        : "no_results",
      error,
    };
  });

  const compared = results.filter((row) => row.best && COUNTED.has(row.best.confidence));
  const savings = compared.reduce((sum, row) => sum + row.saving, 0);
  const confidenceTiers = Object.fromEntries(["high", "medium"].map((confidence) => {
    const tier = compared.filter((row) => row.best.confidence === confidence);
    return [confidence, {
      compared: tier.length,
      cheaperElsewhere: tier.filter((row) => row.cheaper).length,
      estimatedSavings: tier.reduce((sum, row) => sum + row.saving, 0),
    }];
  }));

  return {
    rows: results,
    summary: {
      lines: lines.length,
      compared: compared.length,
      cheaperElsewhere: results.filter((row) => row.cheaper).length,
      uncomparable: results.filter((row) => !row.best).length,
      unmatched: results.filter((row) => !row.best && !row.error).length,
      failed: results.filter((row) => row.error).length,
      truncated: results.filter((row) => row.truncated).length,
      highConfidence: confidenceTiers.high.compared,
      mediumConfidence: confidenceTiers.medium.compared,
      estimatedSavings: savings,
      confidenceTiers,
      basketTotal: Number(basket?.TotalPrice) || null,
      stores: targetStores,
    },
  };
}
