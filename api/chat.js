// Vercel serverless function: POST /api/chat
// The browser sends { message, history }. This function adds the persona,
// calls Groq with the SECRET key (from an env var), and returns { reply }.
// The key never leaves the server.

import { SYSTEM_PROMPT } from "../lib/persona.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const MAX_MESSAGE_CHARS = 500;   // one spoken question is never this long
const MAX_HISTORY_TURNS = 10;    // keep context (and cost) small
const RATE_LIMIT = 15;           // requests...
const RATE_WINDOW_MS = 60_000;   // ...per minute, per IP

// Best-effort rate limiter. Serverless instances are short-lived and can run
// in parallel, so this is a speed bump, not a wall. (A real one uses Redis/KV.)
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

// Never trust what the browser sends: keep only well-formed user/assistant turns.
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY is not set");
    return res.status(500).json({ error: "The bot isn't configured yet. Please try again later." });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "You're asking a lot quickly! Please wait a moment and try again." });
  }

  const { message, history } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Please ask a question." });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: "That question is a bit long. Could you shorten it?" });
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...cleanHistory(history),
    { role: "user", content: message.trim() },
  ];

  // Don't let a slow upstream hang the request forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.7,
        // gpt-oss models "think" before answering; low effort keeps voice replies fast,
        // and include_reasoning:false returns only the final answer.
        reasoning_effort: "low",
        include_reasoning: false,
        max_completion_tokens: 1024,
      }),
      signal: controller.signal,
    });

    if (!groqRes.ok) {
      const detail = await groqRes.text();
      console.error("Groq error", groqRes.status, detail.slice(0, 500));
      const msg =
        groqRes.status === 429
          ? "The bot is getting a lot of questions right now. Please try again in a minute."
          : "Sorry, I couldn't think of an answer just now. Please try again.";
      return res.status(502).json({ error: msg });
    }

    const data = await groqRes.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return res.status(502).json({ error: "Sorry, I didn't catch that. Could you ask again?" });
    }

    return res.status(200).json({ reply });
  } catch (err) {
    const timedOut = err.name === "AbortError";
    console.error("Chat handler failed:", err);
    return res.status(timedOut ? 504 : 500).json({
      error: timedOut
        ? "That took too long. Please try again."
        : "Something went wrong. Please try again.",
    });
  } finally {
    clearTimeout(timeout);
  }
}
