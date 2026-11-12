// Frontend loop:  🎤 listen (STT) → POST /api/chat → 🔊 speak (TTS)
// Speech-to-text and text-to-speech both use the browser's built-in Web Speech API,
// so they're free and need no API key. Only the "thinking" step hits our server.

const micBtn = document.getElementById("micBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const micNote = document.getElementById("micNote");
const chatEl = document.getElementById("chat");
const textForm = document.getElementById("textForm");
const textInput = document.getElementById("textInput");
const chips = document.querySelectorAll(".chip");

// The LLM is stateless, so WE keep the conversation and resend it each time.
const history = [];
let busy = false;
let listening = false;

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
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text; // textContent, not innerHTML: never inject untrusted HTML
  chatEl.appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- Text-to-speech ----------
const synth = window.speechSynthesis;
let voice = null;

// Voices load asynchronously in Chrome, so pick one when the list is ready.
function pickVoice() {
  if (!synth) return;
  const voices = synth.getVoices();
  voice =
    voices.find((v) => v.lang === "en-IN") ||
    voices.find((v) => v.lang.startsWith("en") && /google|natural|neural/i.test(v.name)) ||
    voices.find((v) => v.lang.startsWith("en")) ||
    null;
}
if (synth) {
  pickVoice();
  synth.addEventListener?.("voiceschanged", pickVoice);
}

// iOS Safari only allows speech that starts from a user tap. Speaking an empty
// utterance during the first tap "unlocks" audio for later replies.
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked || !synth) return;
  synth.speak(new SpeechSynthesisUtterance(""));
  audioUnlocked = true;
}

// Chrome cuts off long utterances after ~15 seconds, so speak sentence by sentence.
function speak(text) {
  return new Promise((resolve) => {
    if (!synth) return resolve();
    synth.cancel();
    const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    let remaining = sentences.length;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      stopBtn.hidden = true;
      resolve();
    };
    // Some browsers occasionally never fire onend. Never let the UI get stuck:
    // give up after roughly how long the text should take to read, plus slack.
    const safety = setTimeout(finish, 5000 + text.length * 90);
    stopBtn.hidden = false;
    sentences.forEach((s) => {
      const u = new SpeechSynthesisUtterance(s.trim());
      if (voice) u.voice = voice;
      u.rate = 1;
      u.onend = u.onerror = () => {
        if (--remaining === 0) finish();
      };
      synth.speak(u);
    });
  });
}

stopBtn.addEventListener("click", () => {
  synth?.cancel(); // fires onend/onerror on queued utterances, which resolves speak()
  stopBtn.hidden = true;
});

// ---------- Ask the backend ----------
async function ask(question) {
  question = question.trim();
  if (!question || busy) return;
  unlockAudio();
  synth?.cancel();
  setBusy(true);
  addMessage("user", question);
  setStatus("Thinking...");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, history }),
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
  recognition.lang = "en-IN";        // Indian English; also understands other English accents
  recognition.interimResults = true; // show words live while the user speaks
  recognition.continuous = false;    // stop automatically after a pause

  let finalText = "";

  recognition.onstart = () => {
    listening = true;
    finalText = "";
    micBtn.classList.add("listening");
    micBtn.setAttribute("aria-label", "Tap to stop listening");
    setStatus("Listening... speak now");
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
      network: "Voice recognition needs an internet connection. You can type below.",
    };
    setStatus(messages[event.error] || "Voice input had a problem. Try again or type below.");
  };

  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    micBtn.setAttribute("aria-label", "Tap to speak");
    if (finalText.trim()) ask(finalText);
  };

  micBtn.addEventListener("click", () => {
    if (busy) return;
    unlockAudio();
    if (listening) {
      recognition.stop();
    } else {
      synth?.cancel();
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

// ---------- Text fallback + sample questions ----------
textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = textInput.value;
  textInput.value = "";
  ask(q);
});

chips.forEach((chip) => chip.addEventListener("click", () => ask(chip.textContent)));
