import assert from "node:assert/strict";
import test from "node:test";

import {
  compareBasket,
  describeBasketLine,
  parsePackSize,
  scoreCandidate,
  similarity,
  toBaseAmount,
  variantMismatch,
} from "../src/compare.js";

test("pack sizes are read from nemlig descriptions", () => {
  assert.deepEqual(parsePackSize("400 g / hele bønner"), { amount: 400, base: "g" });
  assert.deepEqual(parsePackSize("0,50 l / ex. pant"), { amount: 500, base: "ml" });
  assert.deepEqual(parsePackSize("1,50 kg / Rose"), { amount: 1500, base: "g" });
  assert.deepEqual(parsePackSize("6 x 33 cl"), { amount: 1980, base: "ml" });
  assert.equal(parsePackSize("Danmark / Klasse 1"), null);
});

test("weight wins over piece count when a description carries both", () => {
  // "2 stk. / 300 g" must compare as 300 g; goma.gg reports weights, and
  // piece counts are not comparable across brands.
  assert.deepEqual(parsePackSize("2 stk. / 300 g / frost"), { amount: 300, base: "g" });
  assert.deepEqual(parsePackSize("Ca. 20 stk. / 200 g / frost"), { amount: 200, base: "g" });
  assert.deepEqual(parsePackSize("2 stk / Danmark"), { amount: 2, base: "stk" });
});

test("units are normalised to grams, millilitres, or pieces", () => {
  assert.deepEqual(toBaseAmount(1.5, "kg"), { amount: 1500, base: "g" });
  assert.deepEqual(toBaseAmount(250, "ml"), { amount: 250, base: "ml" });
  assert.deepEqual(toBaseAmount(2, "l"), { amount: 2000, base: "ml" });
  assert.equal(toBaseAmount(0, "g"), null);
  assert.equal(toBaseAmount(5, "furlong"), null);
});

test("similarity ignores stop words and punctuation", () => {
  assert.equal(similarity("Hakkede tomater", "hakkede tomater"), 1);
  assert.ok(similarity("Hakkede tomater øko.", "Hakkede tomater") > 0.9);
  assert.ok(similarity("Fusilli", "Combino Fusilli") > 0.5);
  assert.equal(similarity("Kaffe", "Vaskepulver"), 0);
});

const line = describeBasketLine({
  Id: "5062235",
  Name: "Fusilli",
  Brand: "Garofalo",
  Description: "500 g / Garofalo",
  Quantity: 2,
  Price: 34.74,
});

test("a basket line carries its per-unit price", () => {
  assert.deepEqual(line.pack, { amount: 500, base: "g" });
  assert.equal(line.quantity, 2);
  assert.equal(line.perItem.toFixed(2), "17.37");
  assert.equal((line.unitPrice * 1000).toFixed(2), "34.74");
});

test("confidence reflects name, brand, and pack agreement", () => {
  const exact = scoreCandidate(line, {
    name: "Fusilli", brand: "Garofalo", pack: { amount: 500, base: "g" },
  });
  assert.equal(exact.confidence, "high");

  const differentSize = scoreCandidate(line, {
    name: "Fusilli", brand: "Combino", pack: { amount: 1000, base: "g" },
  });
  assert.equal(differentSize.confidence, "medium");

  const unrelated = scoreCandidate(line, {
    name: "Vaskepulver", brand: "Ariel", pack: { amount: 500, base: "g" },
  });
  assert.equal(unrelated.confidence, "low");

  const incomparable = scoreCandidate(line, {
    name: "Fusilli", brand: "Garofalo", pack: { amount: 2, base: "stk" },
  });
  assert.equal(incomparable.comparable, false);
});

test("a variant word keeps a near-identical name out of high confidence", () => {
  const mayonnaise = describeBasketLine({
    Id: "3", Name: "Mayonnaise", Brand: "Graasten", Description: "375 g",
    Quantity: 1, Price: 15.56,
  });

  assert.equal(variantMismatch("Mayonnaise", "Mayonnaise Light"), true);
  assert.equal(variantMismatch("Grov remoulade", "Remoulade"), true);
  assert.equal(variantMismatch("Mayonnaise", "Graasten Mayonnaise"), false);

  // Same size, same core name — but "light" makes it a different product.
  const light = scoreCandidate(mayonnaise, {
    name: "Mayonnaise Light", brand: "Graasten", pack: { amount: 375, base: "g" },
  });
  assert.equal(light.confidence, "medium");

  const plain = scoreCandidate(mayonnaise, {
    name: "Mayonnaise", brand: "Graasten", pack: { amount: 375, base: "g" },
  });
  assert.equal(plain.confidence, "high");
});

function stubGoma(byQuery) {
  const queries = [];
  return {
    queries,
    async search(query) {
      queries.push(query);
      return { products: byQuery[query] ?? [], total: 0, onSale: 0 };
    },
  };
}

const basket = {
  TotalPrice: 100,
  Lines: [{
    Id: "1", Name: "Fusilli", Brand: "Garofalo", Description: "500 g",
    Quantity: 2, Price: 34.74,
  }],
};

test("savings scale to the quantity actually in the basket", async () => {
  const goma = stubGoma({
    Fusilli: [{
      store_name: "Lidl", product_name: "Combino Fusilli", brand: "Combino",
      amount: 500, unit: "g", current_price: 5.95, is_on_sale: false,
    }],
  });

  const { rows, summary } = await compareBasket(basket, goma);
  // 17,37 vs 5,95 per 500 g pack, times 2 packs.
  assert.equal(rows[0].saving.toFixed(2), "22.84");
  assert.equal(summary.estimatedSavings.toFixed(2), "22.84");
  assert.equal(summary.cheaperElsewhere, 1);
  assert.equal(summary.compared, 1);
});

test("nemlig's own goma listing is never offered as an alternative", async () => {
  const goma = stubGoma({
    Fusilli: [{
      store_name: "Nemlig", product_name: "Fusilli", brand: "Garofalo",
      amount: 500, unit: "g", current_price: 1,
    }],
  });

  const { rows, summary } = await compareBasket(basket, goma);
  assert.equal(rows[0].best, null);
  assert.equal(summary.uncomparable, 1);
  assert.equal(summary.estimatedSavings, 0);
});

test("a brand-qualified retry runs only when the name alone found no strong match", async () => {
  const weak = stubGoma({
    Mayonnaise: [{
      store_name: "MENY", product_name: "Hellmann Real Mayonnaise", brand: "Hellmann",
      amount: 400, unit: "g", current_price: 20,
    }],
    "Graasten Mayonnaise": [{
      store_name: "Spar", product_name: "Graasten Mayonnaise", brand: "Graasten",
      amount: 375, unit: "g", current_price: 10,
    }],
  });

  const { rows } = await compareBasket({
    TotalPrice: 20,
    Lines: [{
      Id: "2", Name: "Mayonnaise", Brand: "Graasten", Description: "375 g",
      Quantity: 1, Price: 15.56,
    }],
  }, weak);

  assert.deepEqual(weak.queries, ["Mayonnaise", "Graasten Mayonnaise"]);
  assert.equal(rows[0].best.store, "Spar");
  assert.equal(rows[0].best.confidence, "high");
});

test("an exact first-pass match skips the extra request", async () => {
  const goma = stubGoma({
    Fusilli: [{
      store_name: "Lidl", product_name: "Fusilli", brand: "Garofalo",
      amount: 500, unit: "g", current_price: 5.95,
    }],
  });
  await compareBasket(basket, goma);
  assert.deepEqual(goma.queries, ["Fusilli"]);
});

test("a failed lookup is reported rather than counted as no-saving", async () => {
  const goma = {
    async search() {
      throw new Error("goma.gg returned HTTP 503");
    },
  };
  const { summary } = await compareBasket(basket, goma);
  assert.equal(summary.failed, 1);
  assert.equal(summary.estimatedSavings, 0);
});
