require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();

// 🔴 CRASH PROTECTION - Prevents the entire bot from dying on a single error
process.on("uncaughtException", (err) => console.error("💥 UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("💥 UNHANDLED REJECTION:", err));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔹 ENV VARIABLES
const { VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID } = process.env;

// 🔹 IN-MEMORY SESSION STORE
const userState = {};

// 🔹 DIAGNOSTIC DATABASE
const diagnostics = {
  P0300: {
    name: "Random/Multiple Cylinder Misfire",
    questions: [
      { key: "idle", question: "Is the engine rough at idle? (YES/NO)" },
      { key: "accel", question: "Does it hesitate during acceleration? (YES/NO)" }
    ],
    logic: (a) => a.idle === "YES" ? 
      { cause: "Faulty spark plugs/coils", action: "Inspect plugs and test coils." } :
      { cause: "Fuel/Air issue", action: "Check injectors and fuel pressure." }
  },
  P0171: {
    name: "System Too Lean (Bank 1)",
    questions: [
      { key: "hiss", question: "Do you hear a hissing sound? (YES/NO)" },
      { key: "idle", question: "Does the engine idle rough? (YES/NO)" }
    ],
    logic: (a) => a.hiss === "YES" ? 
      { cause: "Vacuum leak", action: "Inspect hoses and intake manifold." } :
      { cause: "Dirty MAF sensor", action: "Clean or replace the MAF sensor." }
  },
  P0420: {
    name: "Catalyst System Efficiency",
    questions: [
      { key: "smell", question: "Do you smell sulfur/rotten eggs? (YES/NO)" }
    ],
    logic: (a) => a.smell === "YES" ? 
      { cause: "Failing catalytic converter", action: "Replace catalytic converter." } :
      { cause: "O2 Sensor issue", action: "Check O2 sensor readings before replacing catalyst." }
  }
  // Add P0455, P0128 etc. here following the same structure
};

// 🔹 HEALTH CHECK
app.get("/", (req, res) => res.status(200).send("Aivora Engine: Online"));

// 🔹 WEBHOOK VERIFICATION
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 🔹 MAIN WEBHOOK HANDLER
app.post("/webhook", (req, res) => {
  // Always acknowledge Meta within 2 seconds
  res.status(200).send("EVENT_RECEIVED");
  
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;

  // Background processing to prevent 502/Timeout
  setImmediate(() => handleInteraction(message));
});

async function handleInteraction(message) {
  try {
    let from = message.from;
    const text = (message.text?.body || "").trim();
    const upperText = text.toUpperCase();

    // 1. Check for "Fixed" intent first to break any loop
    if (upperText.includes("FIXED")) {
      console.log(`✅ User ${from} reported a fix.`);
      delete userState[from]; // Wipe session
      await safeSend(from, "That's great news! 🚗💨 I've closed this diagnostic session. Safe driving!");
      return;
    }

    // 2. Start New Session (Fault Code detected)
    if (upperText.startsWith("P0")) {
      const diag = diagnostics[upperText];
      if (!diag) {
        await safeSend(from, "❌ Code not yet supported. Please try P0300, P0171, or P0420.");
        return;
      }

      userState[from] = { code: upperText, step: 0, answers: {} };
      await safeSend(from, `🔍 ${upperText}: ${diag.name}\n\n${diag.questions[0].question}`);
      return;
    }

    // 3. Handle Ongoing Session
    const state = userState[from];
    if (state) {
      const diag = diagnostics[state.code];
      const currentQuestion = diag.questions[state.step];

      // Save answer
      state.answers[currentQuestion.key] = upperText;
      state.step++;

      // Next Question or Result?
      if (state.step < diag.questions.length) {
        await safeSend(from, diag.questions[state.step].question);
      } else {
        const result = diag.logic(state.answers);
        await safeSend(from, `🧠 *Diagnosis:* ${result.cause}\n🛠 *Action:* ${result.action}\n\nType "Fixed" if this resolved it, or send a new code.`);
        
        // We keep the state for a moment so they can say "Fixed", 
        // but it will be overwritten if they send a new P-code.
      }
      return;
    }

    // 4. Default Fallback
    await safeSend(from, "Welcome to Aivora Diagnostics. 🛠\n\nPlease send a fault code (e.g., P0300) to begin.");

  } catch (err) {
    console.error("❌ Logic Error:", err.message);
  }
}

// 🔹 BOILERPLATE SEND FUNCTION
async function safeSend(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      },
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
        timeout: 8000 
      }
    );
  } catch (err) {
    console.error("❌ Send Error:", err.response?.data || err.message);
  }
}

// 🔹 START SERVER
const PORT = process.env.PORT || 8080; // Defaulted to 8080 as requested
app.listen(PORT, () => {
  console.log(`🚀 Aivora Diagnostic Bot active on port ${PORT}`);
});