import OpenAI from "openai";

import { AppConfig } from "./config.js";
import { logger } from "./logger.js";

export type PostType = "story" | "educational" | "discussion" | "checklist";

export interface GeneratedPost {
  title: string;
  body: string;
  postType: PostType;
}

const TYPE_INSTRUCTIONS: Record<PostType, string> = {
  story: `Write a first-person story post. The narrator recently went through something involving estate planning, wills, POA, probate, elder care, or end-of-life planning.

Structure: brief situation setup (1-2 sentences) → what happened / what they discovered (2-3 paragraphs) → key takeaway → question for the community.

Examples of opening lines:
- "My dad passed away two months ago without a will, and honestly the past eight weeks have been..."
- "I finally bit the bullet and did our estate planning last week at 34, and I was surprised by..."
- "My mom was just diagnosed with dementia and I had no idea how complicated things would get without proper..."
- "After 18 months of probate, I can tell you exactly what NOT to do..."

Length: 180–400 words.`,

  educational: `Write a helpful educational post sharing practical knowledge. Frame it as something the writer researched or discovered.

Structure: hook (1 sentence on what you're sharing and why) → main content (organized clearly, can use a short numbered list or short paragraphs) → brief wrap-up → question.

Examples of angles:
- What documents every adult actually needs and why
- How probate works and what it costs
- The difference between common estate documents
- What happens to assets with no beneficiary designated
- When an online will is enough vs. when you need an attorney

Length: 180–400 words. Keep lists short (4-6 items max) and each point to 1-2 sentences.`,

  discussion: `Write a conversational discussion-starter. Ask the community about their personal experience with estate planning, wills, POA for aging parents, or planning for the future.

Keep it genuine and light — the point is to start a conversation and hear other people's experiences.

Examples:
- "At what age did you finally set up your will?"
- "For those of you who've helped aging parents get their paperwork in order — how did you bring it up?"
- "Has anyone used an online service for their basic estate documents? Was it worth it vs. a lawyer?"

Length: 50–150 words. Short and open-ended.`,

  checklist: `Write a practical checklist post. Give people a concrete list of things to do, documents to have, or questions to ask.

Structure: 1-sentence intro explaining what the checklist covers → numbered or bulleted list (5-8 items, each with a short explanation) → closing note → question.

Examples:
- Checklist: what to do when a parent starts needing help
- Documents every family should have before a medical emergency
- Questions to ask when meeting with an estate attorney for the first time

Length: 200–400 words.`,
};

const STYLE_VARIANTS = [
  "Write in a slightly informal tone — contractions, direct language, like a knowledgeable friend.",
  "Write in a calm, measured tone — experienced and practical, like someone who's been through it.",
  "Write with some emotional weight — this affected the writer personally and they're sharing to help others.",
  "Write in a matter-of-fact, slightly dry tone — straightforward and to the point.",
];

export class PostGenerator {
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfig) {
    this.client = new OpenAI({
      apiKey: config.openAiApiKey,
      timeout: 90_000,
      maxRetries: 2,
    });
  }

  async generate(
    subreddit: string,
    audience: string,
    postType: PostType,
    topicalGuidance?: string,
  ): Promise<GeneratedPost | null> {
    const typeInstructions = TYPE_INSTRUCTIONS[postType];
    const style = STYLE_VARIANTS[Math.floor(Math.random() * STYLE_VARIANTS.length)];
    const guidanceBlock = topicalGuidance
      ? `\nTopical context (draw from these naturally; never name a brand, never a URL):\n${topicalGuidance}\n`
      : "";

    const system = `You are a knowledgeable Reddit user writing an original post for r/${subreddit}. Your readers are ${audience}.

Style: ${style}

Post type instructions:
${typeInstructions}
${guidanceBlock}
Hard rules:
- Sound like a real human Reddit user. Not an AI, not a marketer.
- No brand names, no company names, no URLs — ever.
- No "as an AI", no mention of being artificial.
- No emojis.
- Include at least one specific concrete detail (a state, a dollar range, a time period, a relationship) to make it authentic.
- End with a genuine question that invites people to share their own experience.
- The title must be specific and interesting — not vague or generic.

Return strict JSON: {"title": "...", "body": "..."}`;

    const user = `Subreddit: r/${subreddit}
Audience: ${audience}
Post type: ${postType}

Generate the post.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.config.ai.model,
        temperature: 0.88,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });

      const raw = response.choices[0]?.message.content ?? "{}";
      let parsed: { title?: string; body?: string };
      try {
        parsed = JSON.parse(raw) as { title?: string; body?: string };
      } catch {
        logger.warn({ subreddit, postType, raw }, "Post generator returned invalid JSON");
        return null;
      }

      const title = parsed.title?.trim() ?? "";
      const body = parsed.body?.trim() ?? "";

      if (title.length < 10 || body.length < 50) {
        logger.warn({ subreddit, postType, titleLen: title.length, bodyLen: body.length }, "Post generator returned too-short content");
        return null;
      }

      // Safety filter: no URLs, no brand name slipping through
      const combined = (title + " " + body).toLowerCase();
      if (
        combined.includes("http://") ||
        combined.includes("https://") ||
        combined.includes("www.") ||
        combined.includes("planningforms") ||
        combined.includes("as an ai") ||
        combined.includes("language model")
      ) {
        logger.warn({ subreddit, postType }, "Generated post failed safety filter");
        return null;
      }

      return { title, body, postType };
    } catch (error) {
      logger.error({ subreddit, postType, error: String(error) }, "Post generation error");
      return null;
    }
  }
}
