import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveNemligPrice,
  minimumShortfall,
  renderBasket,
  renderCheckoutStatus,
  renderComparison,
  renderDeliveryDays,
  renderOrders,
  renderProduct,
  renderProducts,
} from "../src/format.js";

// Field names below mirror live GetBasket / GetBasicOrderHistory /
// GetDeliveryDays responses.

const percentageCampaignProduct = {
  Id: "fixture-campaign-percentage",
  Name: "Kaffe",
  Brand: "Morgenstund",
  Description: "500 g",
  Price: 41.95,
  UnitPriceCalc: 83.9,
  UnitPriceLabel: "kr/kg",
  Url: "fixture-campaign-percentage",
  Availability: { IsDeliveryAvailable: true, IsAvailableInStock: true },
  CampaignAttribute: "Procenttilbud",
  Campaign: {
    Type: "Percentage",
    CampaignPrice: 37.76,
    CampaignUnitPrice: 75.52,
  },
};

test("percentage campaigns use effective price and retain base price context", () => {
  assert.deepEqual(effectiveNemligPrice(percentageCampaignProduct), {
    price: 37.76,
    unitPrice: 75.52,
    basePrice: 41.95,
    baseUnitPrice: 83.9,
    campaignPrice: 37.76,
    campaignUnitPrice: 75.52,
    campaignApplied: true,
    quantityOffer: null,
  });

  for (const output of [
    renderProducts([percentageCampaignProduct]),
    renderProduct(percentageCampaignProduct),
  ]) {
    assert.match(output, /37,76\s*kr\./);
    assert.match(output, /base 41,95\s*kr\./);
    assert.match(output, /75,52 kr\/kg/);
    assert.match(output, /base 83,9 kr\/kg/);
  }
});

test("quantity campaigns are not applied below their threshold", () => {
  const product = {
    ...percentageCampaignProduct,
    Id: "fixture-campaign-quantity",
    Price: 20,
    UnitPriceCalc: 40,
    Campaign: {
      Type: "Quantity",
      CampaignPrice: 15,
      CampaignUnitPrice: 30,
      MinQuantity: 2,
      TotalPrice: 30,
    },
  };

  assert.deepEqual(effectiveNemligPrice(product), {
    price: 20,
    unitPrice: 40,
    basePrice: 20,
    baseUnitPrice: 40,
    campaignPrice: 15,
    campaignUnitPrice: 30,
    campaignApplied: false,
    quantityOffer: { minQuantity: 2, totalPrice: 30 },
  });
  assert.equal(effectiveNemligPrice(product, { quantity: 2 }).price, 15);

  for (const output of [renderProducts([product]), renderProduct(product)]) {
    assert.match(output, /20,00\s*kr\. \(2 for 30,00\s*kr\.\)/);
    assert.doesNotMatch(output, /Price:\s+15,00\s*kr\./);
  }
});

test("truncated comparisons qualify best-found claims and split outcomes", () => {
  const output = renderComparison({
    rows: [{
      line: {
        name: "Fusilli",
        unitPrice: 0.04,
        pack: { amount: 500, base: "g" },
      },
      best: {
        store: "Fixture",
        name: "Fusilli",
        unitPrice: 0.02,
        pack: { amount: 500, base: "g" },
        confidence: "high",
      },
      cheaper: true,
      saving: 10,
      truncated: true,
    }],
    summary: {
      lines: 5,
      compared: 2,
      highConfidence: 1,
      mediumConfidence: 1,
      unmatched: 2,
      failed: 1,
      truncated: 1,
      basketTotal: 100,
      estimatedSavings: 10,
    },
  });

  assert.match(output, /BEST FOUND/);
  assert.match(output, /1 high confidence/);
  assert.match(output, /1 medium confidence/);
  assert.match(output, /2 unmatched/);
  assert.match(output, /1 lookup failed/);
  assert.match(output, /1 truncated/);
  assert.match(output, /best found.+not a global cheapest claim/);
});

const basket = {
  Lines: [
    { Id: "5058497", Name: "Brooklyn Pulp Art Hazy IPA", Quantity: 5, Price: 100 },
    { Id: "5602284", Name: "Entrecote", Quantity: 1, Price: 49, DiscountSavings: 12 },
  ],
  MealBoxes: [],
  Recipes: [],
  NumberOfProducts: 24,
  NumberOfBags: 4,
  NumberOfDeposits: 5,
  TotalProductsPrice: 498.67,
  TotalBagsPrice: 23.8,
  TotalDepositsPrice: 5,
  DeliveryPrice: 20,
  TotalProductDiscountPrice: 201.85,
  TotalPrice: 547.47,
  IsMinTotalValid: false,
  MinimumOrderTotal: 500,
  IsMaxTotalValid: true,
  FormattedDeliveryTime: "søn. 26/07 kl. 14-18",
  ValidationFailures: [],
};

test("basket reports the product count, not the line count", () => {
  const output = renderBasket(basket);
  assert.match(output, /Products:\s+24 in 2 lines/);
});

test("basket surfaces discounts and the fee breakdown", () => {
  const output = renderBasket(basket);
  assert.match(output, /Saved:\s+201,85/);
  assert.match(output, /Bags:\s+23,80\skr\. \(4\)/);
  assert.match(output, /Deposit:\s+5,00\skr\. \(5\)/);
  assert.match(output, /Delivery fee:\s+20,00/);
  assert.match(output, /Total:\s+547,47/);
  assert.match(output, /−12,00\skr\./);
});

test("the minimum-order check is measured against the products subtotal", () => {
  // TotalPrice (547,47) clears 500, but the products subtotal (498,67) does not.
  assert.equal(minimumShortfall(basket).toFixed(2), "1.33");
  assert.match(renderBasket(basket), /1,33\skr\. below the 500,00\skr\. minimum order/);
  assert.equal(minimumShortfall({ ...basket, IsMinTotalValid: true }), null);
});

test("order history shows totals and delivery windows", () => {
  const output = renderOrders({
    Orders: [{
      OrderNumber: "1000000001",
      Total: 691.13,
      Status: 3,
      DeliveryTime: { Start: "2026-07-18T17:00:00", End: "2026-07-18T19:00:00" },
      IsEditable: false,
      IsCancellable: false,
    }],
    NumberOfPages: 4,
  });

  assert.match(output, /1000000001/);
  assert.match(output, /Sat, 18 Jul 2026 17:00–19:00/);
  assert.match(output, /691,13/);
  // The numeric Status enum is undocumented, so it must not be shown as a label.
  assert.doesNotMatch(output, /\b3\b\s*$/m);
  assert.match(output, /Page 1 of 4/);
});

const deliveryDays = {
  SelectedTimeSlotId: 2341121,
  SelectedDeliveryTime: "2026-07-26T14:00:00",
  DayRangeHours: [
    {
      Date: "2026-07-26T00:00:00",
      DayHours: [
        {
          Id: 2340979, StartHour: 6, EndHour: 8, DeliveryPrice: 22, Availability: 1,
          IsSelected: false, IsCheapHour: false, IsFreeHour: false, Type: 0,
        },
        {
          Id: 2341132, StartHour: 7, EndHour: 11, DeliveryPrice: 0, Availability: 1,
          IsSelected: false, IsCheapHour: true, IsFreeHour: true, Type: 0,
        },
        {
          Id: 2341121, StartHour: 14, EndHour: 18, DeliveryPrice: 20, Availability: 0,
          IsSelected: true, IsCheapHour: false, IsFreeHour: false, Type: 0,
        },
        {
          Id: 2341005, StartHour: 19, EndHour: 22, DeliveryPrice: 19, Availability: 0,
          IsSelected: false, IsCheapHour: false, IsFreeHour: false, Type: 0,
        },
      ],
    },
    { Date: "2026-07-27T00:00:00", DayHours: [
      {
        Id: 2341300, StartHour: 8, EndHour: 12, DeliveryPrice: 25, Availability: 0,
        IsSelected: false, IsCheapHour: false, IsFreeHour: false, Type: 0,
      },
    ] },
  ],
};

test("delivery slots are read out of DayRangeHours[].DayHours[]", () => {
  const output = renderDeliveryDays(deliveryDays);
  assert.match(output, /Sun, 26 Jul 2026/);
  assert.match(output, /2340979\s+06:00–08:00\s+22,00\skr\./);
  assert.match(output, /2341132\s+07:00–11:00\s+free\s+free/);
});

test("sold-out slots are hidden unless --all is given", () => {
  const filtered = renderDeliveryDays(deliveryDays);
  assert.doesNotMatch(filtered, /2341005/);
  assert.match(filtered, /Mon, 27 Jul 2026 — sold out/);
  assert.match(filtered, /2 sold out \(use --all to show\)/);

  const all = renderDeliveryDays(deliveryDays, { all: true });
  assert.match(all, /2341005/);
  assert.match(all, /2341300/);
});

test("the already-reserved slot stays visible even though it is unbookable", () => {
  const output = renderDeliveryDays(deliveryDays);
  assert.match(output, /2341121\s+14:00–18:00\s+20,00\skr\.\s+reserved/);
  assert.match(output, /reserved: 2341121 \(Sun, 26 Jul 2026 14:00\)/);
});

test("empty delivery responses say so rather than looking like a parse failure", () => {
  assert.match(renderDeliveryDays({ DayRangeHours: [] }), /No delivery days returned/);
});

test("delivery output has no run of blank lines", () => {
  for (const output of [
    renderDeliveryDays(deliveryDays),
    renderDeliveryDays(deliveryDays, { all: true }),
  ]) {
    assert.doesNotMatch(output, /\n{3,}/, "sections must be separated by one blank line");
    assert.doesNotMatch(output, /\n\s+$/);
  }
});

test("checkout status explains why a check failed", () => {
  const output = renderCheckoutStatus({
    checkoutUrl: "https://www.nemlig.com/basket",
    readiness: {
      hasItems: true,
      minimumTotalValid: false,
      maximumTotalValid: true,
      hasDeliveryAddress: true,
      hasReservedTimeslot: true,
      validationFailures: [],
    },
    basket,
  });

  assert.match(output, /✗ Minimum total — 1,33\skr\. short of 500,00\skr\./);
  assert.match(output, /✓ Reserved timeslot — søn\. 26\/07 kl\. 14-18/);
  assert.match(output, /Delivery fee:\s+20,00/);
});

test("a failed check never shows a detail that contradicts it", () => {
  // Clearing a basket drops the reservation but leaves FormattedDeliveryTime
  // populated, which previously printed "✗ Reserved timeslot — søn. 26/07".
  const output = renderCheckoutStatus({
    checkoutUrl: "https://www.nemlig.com/basket",
    readiness: {
      hasItems: false,
      minimumTotalValid: false,
      maximumTotalValid: true,
      hasDeliveryAddress: false,
      hasReservedTimeslot: false,
      validationFailures: [],
    },
    basket: { ...basket, FormattedDeliveryTime: "søn. 26/07 kl. 14-18" },
  });

  assert.match(output, /✗ Reserved timeslot — no slot reserved/);
  assert.doesNotMatch(output, /✗ Reserved timeslot — søn/);
  assert.match(output, /✗ Delivery address — no address on the basket/);
  assert.doesNotMatch(output, /✗ Delivery address — Testvej/);
});
