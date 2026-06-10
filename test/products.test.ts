import { describe, expect, it } from "vitest";

import type { AudienceGroup } from "../src/config.js";
import { ProductKnowledge } from "../src/products.js";
import type { ProductCatalog } from "../src/types.js";

const catalog: ProductCatalog = {
  source: "https://example.com",
  generatedAt: "2026-06-10T00:00:00Z",
  products: [
    {
      name: "Power of Attorney Forms",
      description: "POA forms",
      audience: "caring for aging parents",
      topics: ["poa"],
      talkingPoints: ["A POA ends at death", "Pick a trustworthy agent"],
    },
    {
      name: "Last Will & Testament",
      description: "Will forms",
      audience: "estate planning",
      topics: ["wills"],
      talkingPoints: ["Witnesses must sign in the testator's presence"],
    },
  ],
  blogTopics: ["wills 101"],
};

const agingGroup: AudienceGroup = {
  label: "caring for aging parents",
  subreddits: ["AgingParents"],
  keywords: [],
};

describe("ProductKnowledge", () => {
  it("reports empty when there is no catalog", () => {
    const empty = new ProductKnowledge(null);
    expect(empty.isEmpty).toBe(true);
    expect(empty.guidanceFor(agingGroup)).toBeNull();
  });

  it("matches a product by the audience label", () => {
    const k = new ProductKnowledge(catalog);
    const product = k.forAudience(agingGroup);
    expect(product?.name).toBe("Power of Attorney Forms");
  });

  it("honors an explicit product override on the group", () => {
    const k = new ProductKnowledge(catalog);
    const group: AudienceGroup = { ...agingGroup, product: "Last Will & Testament" };
    expect(k.forAudience(group)?.name).toBe("Last Will & Testament");
  });

  it("builds topical guidance containing the talking points but no brand/URL", () => {
    const k = new ProductKnowledge(catalog);
    const guidance = k.guidanceFor(agingGroup)!;
    expect(guidance).toContain("A POA ends at death");
    expect(guidance.toLowerCase()).not.toContain("http");
    expect(guidance.toLowerCase()).not.toContain("www.");
  });

  it("returns null guidance for an unknown audience", () => {
    const k = new ProductKnowledge(catalog);
    const group: AudienceGroup = { label: "unknown audience", subreddits: ["x"], keywords: [] };
    expect(k.guidanceFor(group)).toBeNull();
  });

  it("returns null guidance when no group is given", () => {
    const k = new ProductKnowledge(catalog);
    expect(k.guidanceFor(undefined)).toBeNull();
  });
});
