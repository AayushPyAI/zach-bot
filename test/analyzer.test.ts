import { describe, expect, it } from "vitest";

import { clipClean, finalizeAnalysis } from "../src/openai-analyzer.js";

const constraints = { minRelevanceScore: 8, minQuality: 6, minChars: 90, maxChars: 280 };

describe("finalizeAnalysis", () => {
  it("returns no draft when relevance is below threshold", () => {
    const result = finalizeAnalysis(
      { relevance: 5, reason: "tangential", comment: "x".repeat(120) },
      constraints,
    );
    expect(result.relevance).toBe(5);
    expect(result.draftComment).toBeNull();
  });

  it("rejects drafts that are too short", () => {
    const result = finalizeAnalysis(
      { relevance: 9, reason: "good", comment: "too short" },
      constraints,
    );
    expect(result.draftComment).toBeNull();
    expect(result.reason).toContain("too short");
  });

  it("clamps relevance into 0-10 and rounds", () => {
    expect(finalizeAnalysis({ relevance: 42 }, constraints).relevance).toBe(10);
    expect(finalizeAnalysis({ relevance: -3 }, constraints).relevance).toBe(0);
    expect(finalizeAnalysis({ relevance: 8.6, comment: "x".repeat(120) }, constraints).relevance).toBe(9);
  });

  it("truncates overlong drafts to maxChars", () => {
    const long = "a".repeat(500);
    const result = finalizeAnalysis({ relevance: 9, quality: 8, comment: long }, constraints);
    expect(result.draftComment).not.toBeNull();
    expect(result.draftComment!.length).toBeLessThanOrEqual(constraints.maxChars);
  });

  it("filters drafts containing URLs", () => {
    const withUrl = `Check this out https://example.com ${"x".repeat(100)}`;
    const result = finalizeAnalysis({ relevance: 9, quality: 8, comment: withUrl }, constraints);
    expect(result.draftComment).toBeNull();
    expect(result.reason).toContain("safety filter");
  });

  it("filters drafts that admit to being an AI", () => {
    const aiTell = `As an AI language model I think ${"x".repeat(100)}`;
    const result = finalizeAnalysis({ relevance: 9, quality: 8, comment: aiTell }, constraints);
    expect(result.draftComment).toBeNull();
  });

  it("rejects low-quality (filler) drafts even when relevant and long enough", () => {
    const filler = "I totally agree with everything you said here, thanks so much for sharing this with all of us today.";
    const result = finalizeAnalysis({ relevance: 9, quality: 3, comment: filler }, constraints);
    expect(result.draftComment).toBeNull();
    expect(result.reason).toContain("low quality");
  });

  it("parses and clamps intent and quality", () => {
    const good = "Talk to the executor first and request a copy of the will from probate court before signing anything at all.";
    const result = finalizeAnalysis({ relevance: 9, intent: 12, quality: 8, comment: good }, constraints);
    expect(result.intent).toBe(10); // clamped
    expect(result.quality).toBe(8);
  });

  it("accepts a clean, in-range, high-quality draft", () => {
    const good = "Talk to the executor first and request a copy of the will from probate court before signing anything at all.";
    const result = finalizeAnalysis({ relevance: 9, intent: 7, quality: 8, reason: "on topic", comment: good }, constraints);
    expect(result.draftComment).toBe(good);
    expect(result.relevance).toBe(9);
  });

  it("handles missing fields gracefully", () => {
    const result = finalizeAnalysis({}, constraints);
    expect(result.relevance).toBe(0);
    expect(result.intent).toBe(0);
    expect(result.quality).toBe(0);
    expect(result.draftComment).toBeNull();
  });
});

describe("clipClean", () => {
  it("returns text unchanged when within the limit", () => {
    expect(clipClean("short text", 100)).toBe("short text");
  });

  it("cuts at the last sentence boundary, not mid-word", () => {
    const text = "First sentence is here. Second sentence is also here. Third runs over the limit now.";
    const out = clipClean(text, 55);
    expect(out).toBe("First sentence is here. Second sentence is also here.");
    expect(out.length).toBeLessThanOrEqual(55);
  });

  it("falls back to a word boundary when there is no sentence break", () => {
    const text = "this is a very long run on phrase with no punctuation at all anywhere here";
    const out = clipClean(text, 30);
    expect(out.endsWith(".")).toBe(true);
    expect(out).not.toMatch(/\w-?$/); // doesn't end mid-word without punctuation
    expect(out.length).toBeLessThanOrEqual(31);
  });
});
