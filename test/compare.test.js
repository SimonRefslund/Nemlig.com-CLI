import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const { cases: compareCases } = JSON.parse(
  readFileSync(new URL("./fixtures/compare-cases.json", import.meta.url), "utf8"),
);

const expectedFamilies = [
  "exact same-product/same-pack",
  "unrelated products",
  "organic source versus organic candidate",
  "organic source versus conventional candidate",
  "400 g / 240 g canned product",
  "950 g demand versus 700 g rival",
  "same name in two pack sizes",
  "high-confidence plus cheaper medium-confidence candidates",
];

function fixtureCandidateForScoring(candidate) {
  return {
    name: candidate.product_name,
    brand: candidate.brand,
    pack: toBaseAmount(candidate.amount, candidate.unit),
  };
}

function fixtureGoma(products) {
  return {
    async search() {
      return { products, total: products.length, onSale: 0 };
    },
  };
}

test("grocery decision fixtures cover the eight unique case families", () => {
  assert.deepEqual(compareCases.map(({ family }) => family), expectedFamilies);
  assert.equal(new Set(compareCases.map(({ id }) => id)).size, compareCases.length);

  for (const fixture of compareCases) {
    assert.match(fixture.id, /^[a-z0-9-]+$/);
    assert.ok(Number.isFinite(fixture.source.Price), `${fixture.id}: finite source price`);
    assert.ok(Number.isFinite(fixture.source.Quantity), `${fixture.id}: finite source quantity`);
    assert.equal(
      fixture.candidates.length,
      fixture.expectedCurrent.confidences.length,
      `${fixture.id}: one confidence per candidate`,
    );

    for (const [index, candidate] of fixture.candidates.entries()) {
      assert.match(candidate.product_id, /^fixture-candidate-/);
      assert.ok(Number.isFinite(candidate.current_price), `${fixture.id}: finite candidate price`);
      assert.ok(Number.isFinite(candidate.quantity), `${fixture.id}: finite candidate quantity`);
      assert.ok(
        ["low", "medium", "high"].includes(fixture.expectedCurrent.confidences[index]),
        `${fixture.id}: explicit candidate confidence`,
      );
    }
  }
});

test("fixture descriptions characterize current pack parsing", () => {
  for (const fixture of compareCases) {
    assert.deepEqual(
      describeBasketLine(fixture.source).pack,
      fixture.expectedCurrent.parsedPack,
      fixture.id,
    );
  }
});

test("fixture names characterize current similarity", () => {
  for (const fixture of compareCases) {
    const actual = fixture.candidates.map((candidate) =>
      similarity(fixture.source.Name, candidate.product_name));
    assert.deepEqual(actual, fixture.expectedCurrent.similarities, fixture.id);
  }
});

test("fixture candidates characterize current confidence scoring", () => {
  for (const fixture of compareCases) {
    const line = describeBasketLine(fixture.source);
    const scores = fixture.candidates.map((candidate) =>
      scoreCandidate(line, fixtureCandidateForScoring(candidate)));
    assert.deepEqual(
      scores.map(({ confidence }) => confidence),
      fixture.expectedCurrent.confidences,
      `${fixture.id}: confidence`,
    );
    assert.deepEqual(
      scores.map(({ comparable }) => comparable),
      fixture.expectedCurrent.comparables,
      `${fixture.id}: comparable`,
    );
  }
});

test("fixture cases characterize current basket comparisons", async () => {
  for (const fixture of compareCases) {
    const { rows } = await compareBasket({
      TotalPrice: fixture.source.Price,
      Lines: [fixture.source],
    }, fixtureGoma(fixture.candidates));
    const [row] = rows;

    assert.equal(row.best?.productId ?? null, fixture.expectedCurrent.bestProductId, fixture.id);
    assert.equal(row.best?.confidence ?? null, fixture.expectedCurrent.bestConfidence, fixture.id);
    assert.equal(row.cheaper, fixture.expectedCurrent.cheaper, fixture.id);
    assert.equal(
      row.saving.toFixed(2),
      fixture.expectedCurrent.saving.toFixed(2),
      fixture.id,
    );
    for (const candidate of row.alternatives) {
      for (const field of [
        "requiredAmount",
        "packsNeeded",
        "purchaseAmount",
        "surplusAmount",
        "purchaseCost",
        "normalizedCostForRequiredAmount",
        "normalizedSaving",
      ]) {
        assert.ok(Number.isFinite(candidate[field]), `${fixture.id}: finite ${field}`);
      }
    }
    if (fixture.expectedCurrent.bestEconomics) {
      for (const [field, value] of Object.entries(fixture.expectedCurrent.bestEconomics)) {
        assert.ok(
          Math.abs(row.best[field] - value) < 1e-9,
          `${fixture.id}: ${field}`,
        );
      }
    }
  }
});

test("current behavior: organic words are stop words during matching", () => {
  const organic = compareCases.find(({ id }) => id === "organic-source-organic-candidate");
  const conventional = compareCases.find(
    ({ id }) => id === "organic-source-conventional-candidate",
  );

  assert.equal(similarity(organic.source.Name, organic.candidates[0].product_name), 1);
  assert.equal(similarity(conventional.source.Name, conventional.candidates[0].product_name), 1);
  assert.equal(
    scoreCandidate(
      describeBasketLine(conventional.source),
      fixtureCandidateForScoring(conventional.candidates[0]),
    ).confidence,
    "high",
  );
});

test("cash savings require whole rival packs and value surplus at zero", async () => {
  const fixture = compareCases.find(({ id }) => id === "demand-950g-rival-700g");
  const { rows } = await compareBasket({
    TotalPrice: fixture.source.Price,
    Lines: [fixture.source],
  }, fixtureGoma(fixture.candidates));

  assert.equal(rows[0].best.packsNeeded, 2);
  assert.equal(rows[0].best.purchaseAmount, 1400);
  assert.equal(rows[0].best.surplusAmount, 450);
  assert.equal(rows[0].best.purchaseCost, 51);
  assert.equal(rows[0].normalizedSaving.toFixed(2), "3.15");
  assert.equal(rows[0].cheaper, false);
  assert.equal(rows[0].saving, 0);
});

test("official unit price disambiguates gross and drained weights", () => {
  const fixture = compareCases.find(
    ({ id }) => id === "canned-product-gross-and-drained-weight",
  );
  const line = describeBasketLine(fixture.source);
  assert.deepEqual(line.packMeasurements, [
    { amount: 400, base: "g" },
    { amount: 240, base: "g" },
  ]);
  assert.deepEqual(line.pack, { amount: 240, base: "g" });
  assert.equal(line.packAmbiguity, null);
});

test("multipack totals are preserved when the official unit price agrees", () => {
  const line = describeBasketLine({
    Id: "multipack",
    Name: "Dåsetomater",
    Brand: "Solmark",
    Description: "12 x 400 g",
    Quantity: 1,
    Price: 120,
    UnitPriceCalc: 25,
    UnitPriceLabel: "kr/kg",
  });

  assert.deepEqual(line.packMeasurements, [
    { amount: 4800, base: "g" },
    { amount: 400, base: "g" },
  ]);
  assert.deepEqual(line.pack, { amount: 4800, base: "g" });
  assert.equal(line.packAmbiguity, null);
});

test("materially inconsistent pack evidence is exposed", () => {
  const line = describeBasketLine({
    Id: "ambiguous",
    Name: "Dåsetomater",
    Brand: "Solmark",
    Description: "400 g / 240 g drænet",
    Quantity: 1,
    Price: 18,
    UnitPriceCalc: 60,
    UnitPriceLabel: "kr/kg",
  });

  assert.deepEqual(line.packImpliedByUnitPrice, { amount: 300, base: "g" });
  assert.deepEqual(line.pack, { amount: 240, base: "g" });
  assert.equal(line.packAmbiguity.reason, "unit-price-amount-mismatch");
});

test("whole-pack economics cover smaller and larger rival packs", async () => {
  const cases = [
    {
      name: "Ærter",
      sourceAmount: 500,
      sourcePrice: 20,
      rivalAmount: 400,
      rivalPrice: 6,
      packsNeeded: 2,
      purchaseAmount: 800,
      surplusAmount: 300,
      purchaseCost: 12,
    },
    {
      name: "Mozzarella",
      sourceAmount: 200,
      sourcePrice: 15,
      rivalAmount: 500,
      rivalPrice: 12,
      packsNeeded: 1,
      purchaseAmount: 500,
      surplusAmount: 300,
      purchaseCost: 12,
    },
  ];

  for (const fixture of cases) {
    const source = {
      Id: fixture.name,
      Name: fixture.name,
      Brand: "Fixture",
      Description: `${fixture.sourceAmount} g`,
      Quantity: 1,
      Price: fixture.sourcePrice,
    };
    const candidate = {
      product_id: `fixture-${fixture.name}`,
      store_name: "Fixture Market",
      product_name: fixture.name,
      brand: "Fixture",
      amount: fixture.rivalAmount,
      unit: "g",
      current_price: fixture.rivalPrice,
    };
    const { rows } = await compareBasket(
      { TotalPrice: source.Price, Lines: [source] },
      fixtureGoma([candidate]),
    );

    assert.equal(rows[0].best.requiredAmount, fixture.sourceAmount, fixture.name);
    assert.equal(rows[0].best.packsNeeded, fixture.packsNeeded, fixture.name);
    assert.equal(rows[0].best.purchaseAmount, fixture.purchaseAmount, fixture.name);
    assert.equal(rows[0].best.surplusAmount, fixture.surplusAmount, fixture.name);
    assert.equal(rows[0].best.purchaseCost, fixture.purchaseCost, fixture.name);
  }
});

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
