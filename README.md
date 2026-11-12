# Talk to Prabhas: AI Voice Bot

A voice bot that answers interview questions the way Prabhas would.
Tap the mic (or a sample question, or type) and it answers out loud.

## How it works
1. **Speech-to-text:** the browser's Web Speech API turns your voice into text (free, no key).
2. **Thinking:** the page sends the text to `/api/chat`, a Vercel serverless function.
   It adds Prabhas's persona (`lib/persona.js`) and calls Groq (`openai/gpt-oss-120b`).
   The API key lives only on the server as an environment variable.
3. **Text-to-speech:** the browser reads the reply aloud.

## Project layout
- `public/`: the web page (HTML, CSS, JS)
- `api/chat.js`: the backend proxy (validation, rate limiting, Groq call)
- `lib/persona.js`: the system prompt that defines "Prabhas"

## Deploy
1. Push this repo to GitHub.
2. Import it in Vercel.
3. Add the environment variable `GROQ_API_KEY` (optionally `GROQ_MODEL`).
4. Deploy.

Best experience: Chrome or Edge (voice input). Other browsers can use the text box.
