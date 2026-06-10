import OpenAI from "openai";

import { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { AnalysisResult, RedditPost } from "./types.js";

const styleHints = [
  "Write one compact paragraph.",
  "Lead with the strongest practical advice.",
  "Sound casual, specific, and non-corporate.",
  "Give one concrete next step for this week.",
  "If helpful, ask one short clarifying question first.",
];

export class OpenAiAnalyzer {
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfig) {
    this.client = new OpenAI({
      apiKey: config.openAiApiKey,
      timeout: 90_000,
      maxRetries: 2,
    });
  }

  async analyze(
    post: RedditPost,
    guidance?: string | null,
    research?: string | null,
    promotionLevel?: PromotionLevel,
  ): Promise<AnalysisResult> {
    const minChars = this.config.ai.minCommentChars;
    const maxChars = this.config.ai.maxCommentChars;
    const style = styleHints[Math.floor(Math.random() * styleHints.length)];

    const level = promotionLevel ?? this.config.ai.promotionLevel;
    const guidanceBlock = level !== "off" && guidance ? `\n\n${guidance}\n` : "";
    const researchBlock = research
      ? `\n\nFresh, verified context from a live web search (use only what is relevant and accurate; do not quote URLs):\n${research}\n`
      : "";
    const promotionRule = promotionRuleFor(level, this.config.site?.brandName);

    const system = `${this.config.ai.persona}

You are evaluating a Reddit post for whether it deserves a useful comment.

1. Score relevance from 0-10 (how on-topic the post is for you).
2. Score intent from 0-10: how strongly the author is actively seeking advice,
   help, or recommendations right now (a direct question seeking guidance = high;
   a vent or update with no question = low).
3. If relevance is at least ${this.config.ai.minRelevanceScore}, draft a comment.
4. Score quality from 0-10: how genuinely valuable, specific, and non-generic
   your drafted comment is to THIS post. Be a harsh critic; filler scores low.
${guidanceBlock}${researchBlock}
Rules for the draft:
- ${style}
- Stay between ${minChars} and ${maxChars} characters.
- Sound human and specific to the post.
- ${promotionRule}
- No mention of being an AI.
- No emojis.
- Avoid generic sympathy openers and filler.

Return strict JSON with exactly:
{"relevance": number, "intent": number, "quality": number, "reason": string, "comment": string}
If you should not comment, return an empty string for comment.`;

    const user = [
      `Subreddit: r/${post.subreddit}`,
      `Title: ${post.title}`,
      `Author: ${post.author}`,
      "",
      "Body:",
      post.body.slice(0, 4000),
    ].join("\n");

    const response = await this.client.chat.completions.create({
      model: this.config.ai.model,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const raw = response.choices[0]?.message.content ?? "{}";
    let parsed: ModelDraft;

    try {
      parsed = JSON.parse(raw) as ModelDraft;
    } catch (error) {
      logger.error({ error, raw }, "OpenAI returned invalid JSON");
      return { relevance: 0, intent: 0, quality: 0, reason: "invalid JSON from model", draftComment: null };
    }

    return finalizeAnalysis(parsed, {
      minRelevanceScore: this.config.ai.minRelevanceScore,
      minQuality: this.config.ai.minQuality,
      minChars,
      maxChars,
    });
  }

  /**
   * Optional live web-search step. Uses a search-enabled model to gather
   * current, factual context about the post's topic before drafting, so replies
   * are grounded in real facts rather than the model's stale memory. Returns
   * null when disabled or on any error (drafting then proceeds without it).
   */
  async research(post: RedditPost): Promise<string | null> {
    if (!this.config.ai.liveSearch) {
      return null;
    }
    const prompt = [
      "Research this topic and return 3-6 concise factual bullet points that would help write a genuinely useful, accurate reply.",
      "Focus on concrete specifics (laws, processes, costs, recent changes). No preamble, no URLs, no marketing.",
      "",
      `Subreddit: r/${post.subreddit}`,
      `Title: ${post.title}`,
      `Body: ${post.body.slice(0, 1500)}`,
    ].join("\n");

    try {
      // Search models always browse the web and don't accept temperature/json.
      const response = await this.client.chat.completions.create({
        model: this.config.ai.searchModel,
        web_search_options: {},
        messages: [{ role: "user", content: prompt }],
      } as Parameters<typeof this.client.chat.completions.create>[0]);
      const text = (response as { choices?: Array<{ message?: { content?: string } }> })
        .choices?.[0]?.message?.content?.trim();
      if (text) {
        logger.debug({ postId: post.id, chars: text.length }, "Live search returned context");
      }
      return text || null;
    } catch (error) {
      logger.warn({ postId: post.id, error: String(error) }, "Live search failed; drafting without it");
      return null;
    }
  }
}

function promotionRuleFor(level: "off" | "topical" | "soft_brand", brandName?: string): string {
  switch (level) {
    case "off":
      return "Give only neutral, genuinely helpful advice. Do not steer toward any product or solution category.";
    case "soft_brand":
      return `You may give topical advice and, at most once and only if it feels completely natural, mention ${
        brandName ?? "a relevant service"
      } by name as a casual suggestion. Never include a URL. It must read as genuine help, never an ad.`;
    case "topical":
    default:
      return "You may give topical advice about the subject area, but never name a brand, company, or product, and never include a URL. It must read as genuine help.";
  }
}

export type PromotionLevel = "off" | "topical" | "soft_brand";

export interface ModelDraft {
  relevance?: number;
  intent?: number;
  quality?: number;
  reason?: string;
  comment?: string;
}

export interface DraftConstraints {
  minRelevanceScore: number;
  minQuality: number;
  minChars: number;
  maxChars: number;
}

/**
 * Turn the raw model output into a validated {@link AnalysisResult}. Pure and
 * deterministic so the relevance threshold, intent/quality gates, length
 * clamping, and the no-URL / no-"as an AI" safety filter can be unit-tested
 * without a live API call.
 */
export function finalizeAnalysis(parsed: ModelDraft, constraints: DraftConstraints): AnalysisResult {
  const relevance = clampInt(parsed.relevance ?? 0, 0, 10);
  const intent = clampInt(parsed.intent ?? 0, 0, 10);
  const quality = clampInt(parsed.quality ?? 0, 0, 10);
  const reason = (parsed.reason ?? "").trim().slice(0, 280);
  const comment = (parsed.comment ?? "").trim();
  const base = { relevance, intent, quality };

  if (relevance < constraints.minRelevanceScore) {
    return { ...base, reason, draftComment: null };
  }

  if (comment.length < constraints.minChars) {
    return { ...base, reason: `${reason} | rejected: draft too short`, draftComment: null };
  }

  // Quality gate: a low self-rated draft is filler — don't post it (protects the
  // account's karma and keeps the 9:1 value ratio genuinely valuable).
  if (quality < constraints.minQuality) {
    return { ...base, reason: `${reason} | rejected: low quality (${quality})`, draftComment: null };
  }

  const clipped = comment.length > constraints.maxChars ? clipClean(comment, constraints.maxChars) : comment;
  const lowered = clipped.toLowerCase();
  if (
    lowered.includes("http://") ||
    lowered.includes("https://") ||
    lowered.includes("www.") ||
    lowered.includes("as an ai") ||
    lowered.includes("language model")
  ) {
    return { ...base, reason: `${reason} | rejected: safety filter`, draftComment: null };
  }

  return { ...base, reason, draftComment: clipped };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Trim an over-length comment without the tell-tale mid-word cut. Prefer the
 * last sentence boundary within the limit; otherwise fall back to the last word
 * boundary. Never produces fragments like "responsibili.".
 */
export function clipClean(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const window = text.slice(0, maxChars);
  const lastSentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (lastSentence >= maxChars * 0.5) {
    return window.slice(0, lastSentence + 1).trimEnd();
  }
  const lastSpace = window.lastIndexOf(" ");
  // Leave room for the trailing period so the result never exceeds maxChars.
  const base = (lastSpace > 0 ? window.slice(0, lastSpace) : window.slice(0, maxChars - 1))
    .trimEnd()
    .replace(/[,;:]$/, "");
  return /[.!?]$/.test(base) ? base : `${base}.`;
}
