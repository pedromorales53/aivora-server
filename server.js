require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();

// 🔴 Meta-safe parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const userState = {};

// 🔹 Diagnostics
const diagnostics = {
  P0300: {
    name: "Random Misfire",
    questions: [
      { key: "idle", question: "Engine rough at idle? (YES/NO)" },
      { key: "accel", question: "Hesitation on acceleration? (YES/NO)" }
    ],
    logic: (a) => {
      if (a.idle === "YES") {
        return { cause: "Ignition issue", action: "Check spark plugs/coils" };
      }
      if (a.accel === "YES") {
        return { cause: "Fuel issue", action: "Check injectors/fuel pressure" };
      }
      return { cause: "General misfire", action: "Inspect engine systems" };
    }
  }
};

// 🔹 HEALTH CHECK
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// 🔹 WEBHOOK VERIFICATION (Meta required)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔍 VERIFY HIT");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ VERIFIED");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// 🔹 SINGLE WEBHOOK (FIXED)
app.post("/webhook", (req, res) => {
  console.log("🔥 WEBHOOK HIT");

  // ✅ ALWAYS respond immediately (prevents 502)
  res.status(200).send("EVENT_RECEIVED");

  // ✅ Process AFTER response
  setImmediate(() => handleWebhook(req.body));
});

// 🔹 CORE LOGIC
async function handleWebhook(body) {
  try {
    console.log("📦 BODY:", JSON.stringify(body));

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    let from = message.from;
    const text = (message.text?.body || "").toUpperCase().trim();

    // 🔥 Normalize number (CRITICAL)
    if (!from.startsWith("+")) {
      from = "+" + from;
    }

    console.log("📩 FROM:", from, "TEXT:", text);

    // 🔹 Start session
    if (text.startsWith("P0")) {
      const diag = diagnostics[text];

      if (!diag) {
        await safeSend(from, "❌ Code not supported yet.");
        return;
      }

      userState[from] = {
        code: text,
        step: 0,
        answers: {}
      };

      await safeSend(from, `🔍 ${text}\n${diag.questions[0].question}`);
      return;
    }

    // 🔹 Continue session
    const state = userState[from];

    if (state) {
      const diag = diagnostics[state.code];
      const currentQ = diag.questions[state.step];

      if (!currentQ) {
        delete userState[from];
        await safeSend(from, "⚠️ Restart. Send code again.");
        return;
      }

      state.answers[currentQ.key] = text;
      state.step++;

      if (state.step < diag.questions.length) {
        await safeSend(from, diag.questions[state.step].question);
      } else {
        const result = diag.logic(state.answers);

        await safeSend(
          from,
          `🧠 Cause: ${result.cause}\nAction: ${result.action}`
        );

        delete userState[from];
      }

      return;
    }

    await safeSend(from, "Send code like P0300");

  } catch (err) {
    console.error("❌ Background error:", err.response?.data || err.message);
  }
}

// 🔹 SAFE SEND
async function safeSend(to, message) {
  try {
    console.log("📤 Sending to:", to);

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 5000
      }
    );

    console.log("✅ Sent");
  } catch (err) {
    console.error("❌ Send fail:", err.response?.data || err.message);
  }
}

// 🔹 START SERVER
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Running on port ${PORT}`);
});