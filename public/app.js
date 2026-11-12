// Frontend loop:  🎤 listen (STT) → POST /api/chat → 📝 show text → POST /api/tts → 🔊 play
// Speech-to-text uses the browser's built-in Web Speech API (free, no key).
// The voice comes from Sarvam via our /api/tts; if that fails, we fall back to
// the browser's built-in voice so the bot is never silent.

const micBtn = document.getElementById("micBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const micNote = document.getElementById("micNote");
const chatEl = document.getElementById("chat");
const textForm = document.getElementById("textForm");
const textInput = document.getElementById("textInput");
const chips = document.querySelectorAll(".chip");
const langButtons = document.querySelectorAll(".lang button");
const player = document.getElementById("player");

// en-IN / te-IN tell the browser's speech recognizer which language to expect.
// It can't auto-detect: it must know the language BEFORE you speak.
const STT_LANG = { en: "en-IN", te: "te-IN" };

// The LLM is stateless, so WE keep the conversation and resend it each time.
const history = [];
let busy = false;
let listening = false;
let lang = "en";
try {
  if (localStorage.getItem("lang") === "te") lang = "te";
} catch {
  /* storage blocked: default to English */
}

// ---------- UI helpers ----------
function setStatus(text) {
  statusEl.textContent = text;
}

function setBusy(value) {
  busy = value;
  micBtn.disabled = value || !recognition;
  textForm.querySelector("button").disabled = value;
  textInput.disabled = value;
  chips.forEach((c) => (c.disabled = value));
  langButtons.forEach((b) => (b.disabled = value));
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "bot" && lang === "te") div.lang = "te";
  div.textContent = text; // textContent, not innerHTML: never inject untrusted HTML
  chatEl.appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setLang(value) {
  lang = value;
  langButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
  if (recognition) recognition.lang = STT_LANG[lang];
  textInput.placeholder = lang === "te" ? "Type in Telugu or English..." : "Type a question...";
  try {
    localStorage.setItem("lang", lang);
  } catch {
    /* ignore */
  }
}

// ---------- Audio unlock (mobile) ----------
// iPhones and some Android browsers only allow audio that starts from a user tap.
// Playing a silent clip during the first tap "unlocks" the player for later replies.
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  player.src = SILENT_WAV;
  player.play().catch(() => {});
  if (window.speechSynthesis) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

// ---------- Voice output ----------
let stopCurrent = null; // function that stops whatever is speaking right now

// 1st choice: Sarvam voice via our server.
async function playServerVoice(text) {
  const controller = new AbortController();
  stopCurrent = () => controller.abort();
  let res;
  try {
    res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
      signal: controller.signal,
    });
  } catch (err) {
    return err.name === "AbortError" ? "stopped" : "failed";
  }
  if (!res.ok) return "failed";

  const url = URL.createObjectURL(await res.blob());
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      player.onended = player.onerror = null;
      URL.revokeObjectURL(url);
      resolve(result);
    };
    player.onended = () => done("played");
    player.onerror = () => done("failed");
    stopCurrent = () => {
      player.pause();
      done("stopped");
    };
    player.src = url;
    player.play().catch(() => done("failed"));
  });
}

// 2nd choice: the browser's built-in voice.
const synth = window.speechSynthesis;
function browserVoiceFor(language) {
  if (!synth) return null;
  const voices = synth.getVoices();
  const norm = (v) => v.lang.replace("_", "-");
  if (language === "te") return voices.find((v) => norm(v).startsWith("te")) || null;
  return (
    voices.find((v) => norm(v) === "en-IN") ||
    voices.find((v) => norm(v).startsWith("en") && /google|natural|neural/i.test(v.name)) ||
    voices.find((v) => norm(v).startsWith("en")) ||
    null
  );
}
synth?.getVoices(); // Chrome loads voices lazily; this kicks it off early

function playBrowserVoice(text) {
  return new Promise((resolve) => {
    const voice = browserVoiceFor(lang);
    // No Telugu voice on this device? An English voice reading Telugu script is
    // gibberish, so stay quiet and let the on-screen text do the work.
    if (!synth || (lang === "te" && !voice)) return resolve();

    synth.cancel();
    // Chrome cuts off long utterances after ~15 seconds, so speak sentence by sentence.
    const sentences = text.match(/[^.!?।]+[.!?।]*\s*/g) || [text];
    let remaining = sentences.length;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(safety);
      resolve();
    };
    // Some browsers occasionally never fire onend. Never let the UI get stuck.
    const safety = setTimeout(finish, 5000 + text.length * 90);
    stopCurrent = () => {
      synth.cancel();
      finish();
    };
    sentences.forEach((s) => {
      const u = new SpeechSynthesisUtterance(s.trim());
      if (voice) u.voice = voice;
      u.lang = voice?.lang || STT_LANG[lang];
      u.onend = u.onerror = () => {
        if (--remaining === 0) finish();
      };
      synth.speak(u);
    });
  });
}

async function speak(text) {
  stopBtn.hidden = false;
  const result = await playServerVoice(text);
  if (result === "failed") await playBrowserVoice(text);
  stopCurrent = null;
  stopBtn.hidden = true;
}

stopBtn.addEventListener("click", () => {
  stopCurrent?.();
  stopBtn.hidden = true;
});

// ---------- Ask the backend ----------
async function ask(question) {
  question = question.trim();
  if (!question || busy) return;
  unlockAudio();
  setBusy(true);
  addMessage("user", question);
  setStatus("Thinking...");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, history, lang }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.reply) {
      throw new Error(data.error || "Something went wrong. Please try again.");
    }

    history.push({ role: "user", content: question }, { role: "assistant", content: data.reply });
    addMessage("bot", data.reply);
    setStatus("Speaking...");
    await speak(data.reply);
    setStatus(recognition ? "Tap the mic to ask another question" : "Type another question below");
  } catch (err) {
    addMessage("error", err.message);
    setStatus("Let's try that again");
  } finally {
    setBusy(false);
  }
}

// ---------- Speech-to-text ----------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = STT_LANG[lang];
  recognition.interimResults = true; // show words live while the user speaks
  recognition.continuous = false;    // stop automatically after a pause

  let finalText = "";

  recognition.onstart = () => {
    listening = true;
    finalText = "";
    micBtn.classList.add("listening");
    micBtn.setAttribute("aria-label", "Tap to stop listening");
    langButtons.forEach((b) => (b.disabled = true));
    setStatus(lang === "te" ? "Listening in Telugu... speak now" : "Listening... speak now");
  };

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    setStatus(`"${(finalText + interim).trim()}"`);
  };

  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "Microphone access was blocked. Allow the mic in your browser, or type below.",
      "service-not-allowed": "Microphone access was blocked. Allow the mic in your browser, or type below.",
      "no-speech": "I didn't hear anything. Tap the mic and try again.",
      "audio-capture": "No microphone found. You can type your question below.",
      "language-not-supported": "This browser can't listen in Telugu. Try Chrome, or type below.",
      network: "Voice recognition needs an internet connection. You can type below.",
    };
    setStatus(messages[event.error] || "Voice input had a problem. Try again or type below.");
  };

  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    micBtn.setAttribute("aria-label", "Tap to speak");
    langButtons.forEach((b) => (b.disabled = busy));
    if (finalText.trim()) ask(finalText);
  };

  micBtn.addEventListener("click", () => {
    if (busy) return;
    unlockAudio();
    if (listening) {
      recognition.stop();
    } else {
      try {
        recognition.start();
      } catch {
        /* already started; ignore */
      }
    }
  });
} else {
  // Firefox and some others: no speech recognition. Fall back to typing.
  micBtn.disabled = true;
  micNote.hidden = false;
  setStatus("Type a question or tap one below");
}

// ---------- Language toggle, text fallback, sample questions ----------
langButtons.forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));
setLang(lang);

textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = textInput.value;
  textInput.value = "";
  ask(q);
});

chips.forEach((chip) => chip.addEventListener("click", () => ask(chip.textContent)));
