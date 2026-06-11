import OpenAI from "openai";
import { AppConfig } from "./config.js";
import { StateDb } from "./db.js";
import { logger } from "./logger.js";

const AMA_KARMA_TARGET = 2000;
const AMA_AGE_TARGET = 90;
const AMA_APPROACHING_KARMA = 1500;
const AMA_APPROACHING_DAYS = 60;

export interface AmaReadinessStatus {
  ready: boolean;
  daysRemaining: number;
  karmaRemaining: number;
  progressPct: number;
}

export function getAmaReadinessStatus(snapshot: {
  ageDays: number;
  totalKarma: number;
}): AmaReadinessStatus {
  const daysRemaining = Math.max(0, AMA_AGE_TARGET - snapshot.ageDays);
  const karmaRemaining = Math.max(0, AMA_KARMA_TARGET - snapshot.totalKarma);
  const ready = daysRemaining === 0 && karmaRemaining === 0;
  // Progress = average of age progress and karma progress
  const agePct = Math.min(100, (snapshot.ageDays / AMA_AGE_TARGET) * 100);
  const karmaPct = Math.min(100, (snapshot.totalKarma / AMA_KARMA_TARGET) * 100);
  const progressPct = Math.round((agePct + karmaPct) / 2);
  return { ready, daysRemaining, karmaRemaining, progressPct };
}

export async function checkAmaReadiness(
  db: StateDb,
  config: AppConfig,
  openaiApiKey: string,
): Promise<void> {
  const snapshot = db.getLatestAccountSnapshot();
  if (!snapshot) return;

  const status = getAmaReadinessStatus(snapshot);

  if (status.ready) {
    if (!db.amaReadinessLogged()) {
      logger.info({ ...status, stage: snapshot.stage }, "AMA READY — account qualifies for an AMA thread!");
      const draft = await generateAmaDraft(openaiApiKey, config.ai.model);
      if (draft) {
        db.saveKv("ama_draft", draft);
        logger.info({ draftLength: draft.length }, "AMA draft generated and saved. Review via: SELECT value FROM kv_store WHERE key='ama_draft'");
      }
    }
    return;
  }

  // Approaching threshold — log progress update
  if (snapshot.ageDays >= AMA_APPROACHING_DAYS || snapshot.totalKarma >= AMA_APPROACHING_KARMA) {
    logger.info(
      {
        ageDays: Math.round(snapshot.ageDays),
        totalKarma: snapshot.totalKarma,
        daysRemaining: status.daysRemaining,
        karmaRemaining: status.karmaRemaining,
        progressPct: status.progressPct,
      },
      "AMA approaching — keep building karma and account age",
    );
  }
}

async function generateAmaDraft(openaiApiKey: string, model: string): Promise<string | null> {
  try {
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const resp = await openai.chat.completions.create({
      model,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content:
            "Write a compelling Reddit AMA opening post body (200-300 words) for someone who helps everyday Americans create their own estate planning documents (wills, trusts, power of attorney, healthcare proxies) affordably. The tone should be warm, genuine, and community-focused. No URLs. No brand names. Focus on helping families avoid the nightmare of dying without a plan. Start with a brief personal story, explain what you do and why, then invite questions.",
        },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() ?? null;
  } catch (error) {
    logger.warn({ error: String(error) }, "AMA draft generation failed");
    return null;
  }
}
