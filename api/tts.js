// Vercel serverless function: POST /api/tts
// The browser sends { text, lang }. This function calls Sarvam's text-to-speech
// with the SECRET key and returns playable audio (audio/wav).
// If anything fails, the browser falls back to its built-in voice.

import { createRateLimiter, clientIp } from "../lib/ratelimit.js";

const SARVAM_URL = "https://api.sarvam.ai/text-to-speech";
// bulbul:v3 voices work in every language, so "dev" (casual, relatable male)
// sounds like the same person in English and Telugu.
const MODEL = process.env.SARVAM_MODEL || "bulbul:v3";
const SPEAKER = process.env.SARVAM_SPEAKER || "dev";
const LANG_CODES = { en: "en-IN", te: "te-IN" };
const MAX_TEXT_CHARS = 1500; // Sarvam allows 2500; our answers are much shorter
const isRateLimited = createRateLimiter(15, 60_000);

async function callSarvam(apiKey, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(SARVAM_URL, {
      method: "POST",
      headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Voice service not configured" });

  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { text, lang } = req.body || {};
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_CHARS) {
    return res.status(400).json({ error: "Invalid text" });
  }
  const languageCode = LANG_CODES[lang] || LANG_CODES.en;
  const base = { text: text.trim(), model: MODEL, speaker: SPEAKER, pace: 1.0 };

  try {
    // Current docs name the field `language_code`; older versions used
    // `target_language_code`. Try the current one, fall back once on a validation error.
    let sarvamRes = await callSarvam(apiKey, { ...base, language_code: languageCode });
    if (sarvamRes.status === 400 || sarvamRes.status === 422) {
      const detail = await sarvamRes.text();
      console.warn("Sarvam rejected language_code, retrying:", detail.slice(0, 300));
      sarvamRes = await callSarvam(apiKey, { ...base, target_language_code: languageCode });
    }

    if (!sarvamRes.ok) {
      const detail = await sarvamRes.text();
      console.error("Sarvam error", sarvamRes.status, detail.slice(0, 500));
      return res.status(502).json({ error: "Voice generation failed" });
    }

    const data = await sarvamRes.json();
    const b64 = data?.audios?.[0];
    if (!b64) return res.status(502).json({ error: "No audio returned" });

    const audio = Buffer.from(b64, "base64");
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(audio);
  } catch (err) {
    console.error("TTS handler failed:", err);
    return res.status(err.name === "AbortError" ? 504 : 500).json({ error: "Voice generation failed" });
  }
}
