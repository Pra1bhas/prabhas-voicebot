# Talk to Prabhas: AI Voice Bot

A voice bot that answers interview questions the way Prabhas would.
Tap the mic (or a sample question, or type) and it answers out loud.

## How it works
1. **Speech-to-text:** the browser's Web Speech API turns your voice into text (free, no key).
2. **Thinking:** the page sends the text to `/api/chat`, a Vercel serverless function.
   It adds Prabhas's persona (`lib/persona.js`) and calls Groq (`openai/gpt-oss-120b`).
   The API key lives only on the server as an environment variable.
3. **Text-to-speech:** `/api/tts` sends the reply to Sarvam AI (`bulbul:v3`, voice `dev`) and streams back
   natural Indian English / Telugu audio. If that fails, the browser's built-in voice takes over.

English / తెలుగు toggle: switches the speech recognizer (en-IN / te-IN), the reply language
(casual Telugu-English mix), and the voice language.

## Project layout
- `public/`: the web page (HTML, CSS, JS)
- `api/chat.js`: the backend proxy (validation, rate limiting, Groq call)
- `api/tts.js`: the voice proxy (Sarvam text-to-speech)
- `lib/persona.js`: the system prompt that defines "Prabhas" (facts, sarcasm, movies and memes, language rules)
- `lib/ratelimit.js`: shared per-IP rate limiter

## Deploy
1. Push this repo to GitHub.
2. Import it in Vercel.
3. Add environment variables: `GROQ_API_KEY` and `SARVAM_API_KEY`
   (optional: `GROQ_MODEL`, `SARVAM_MODEL`, `SARVAM_SPEAKER`).
4. Deploy.

 or Edge (voice input). Other browsers can use the text box.
