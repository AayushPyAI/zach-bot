import { logger } from "./logger.js";

const CAPSOLVER_URL = "https://api.capsolver.com";
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 30; // 90 seconds max

/**
 * Solve a reCAPTCHA v2 challenge via CapSolver.
 * Returns the gRecaptchaResponse token, or null on failure.
 * Get an API key at https://www.capsolver.com (costs ~$0.003 per solve).
 */
export async function solveRecaptchaV2(
  apiKey: string,
  pageUrl: string,
  siteKey: string,
): Promise<string | null> {
  let taskId: string;
  try {
    const res = await fetch(`${CAPSOLVER_URL}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "ReCaptchaV2TaskProxyLess",
          websiteURL: pageUrl,
          websiteKey: siteKey,
        },
      }),
    });
    const data = (await res.json()) as { errorId: number; errorDescription?: string; taskId?: string };
    if (data.errorId !== 0 || !data.taskId) {
      logger.warn({ error: data.errorDescription }, "CapSolver: create task failed");
      return null;
    }
    taskId = data.taskId;
    logger.info({ taskId }, "CapSolver: task created, waiting for solution...");
  } catch (err) {
    logger.warn({ err }, "CapSolver: create task request failed");
    return null;
  }

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${CAPSOLVER_URL}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      const data = (await res.json()) as {
        errorId: number;
        errorDescription?: string;
        status?: string;
        solution?: { gRecaptchaResponse?: string };
      };
      if (data.errorId !== 0) {
        logger.warn({ error: data.errorDescription }, "CapSolver: task errored");
        return null;
      }
      if (data.status === "ready") {
        const token = data.solution?.gRecaptchaResponse ?? null;
        if (token) {
          logger.info({ taskId, tokenLen: token.length }, "CapSolver: reCAPTCHA solved");
        } else {
          logger.warn({ taskId }, "CapSolver: ready but no token in response");
        }
        return token;
      }
    } catch (err) {
      logger.warn({ err, poll: i }, "CapSolver: poll request failed");
    }
  }

  logger.warn({ taskId }, "CapSolver: solve timed out after 90s");
  return null;
}
