require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();

// 🔴 CRASH PROTECTION (CRITICAL)
process.on("uncaughtException", (err) => {
  console.error("💥 UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("💥 UNHANDLED REJECTION:", err);
});

// 🔴 META-SAFE BODY PARSING
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔴 ENV VARIABLES
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 🔴 DEBUG ENV (optional but helpful)
console.log("🔑 ENV CHECK:", {
  VERIFY_TOKEN: !!VERIFY_TOKEN,
  WHATSAPP_TOKEN: !!WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: !!PHONE_NUMBER_ID,
});

// 🔹 IN-MEMORY USER STATE
const userState = {};

// 🔹 DIAGNOSTICS
const diagnostics = {
  P0300: {
    name: "Random Misfire",
    questions: [
      { key: "idle", question: "Engine rough at idle? (YES/NO)" },
      { key: "accel", question: "Hesitation on acceleration? (YES/NO)" },
    ],
    logic: (a) => {
      if (a.idle === "YES") {
        return { cause: "Ignition issue", action: "Check spark plugs/coils" };
      }
      if (a.accel === "YES") {
        return { cause: "Fuel issue", action: "Check injectors/fuel pressure" };
      }
      return { cause: "General misfire", action: "Inspect engine systems" };
    },
  },
};

// 🔹 HEALTH CHECK
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// 🔹 WEBHOOK VERIFICATION (Meta)
app.get("/webhook", (req, res) => {
  console.log("🔍 VERIFY HIT");

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ VERIFIED");
    return res.status(200).send(challenge);
  }

  console.log("❌ VERIFY FAILED");
  return res.sendStatus(403);
});

// 🔹 MAIN WEBHOOK (CRITICAL FIX)
app.post("/webhook", (req, res) => {
  console.log("🔥 WEBHOOK HIT");

  // ✅ ALWAYS respond immediately (prevents 502)
  res.status(200).send("EVENT_RECEIVED");

  // ✅ Process AFTER response (non-blocking)
  setImmediate(() => handleWebhook(req.body));
});

// 🔹 CORE LOGIC
async function handleWebhook(body) {
  try {
    console.log("📦 BODY:", JSON.stringify(body));

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      console.log("⚠️ No message in payload");
      return;
    }

    let from = message.from;
    const text = (message.text?.body || "").toUpperCase().trim();

    // 🔴 FIX: normalize phone number
    if (!from.startsWith("+")) {
      from = "+" + from;
    }

    console.log("📩 FROM:", from, "| TEXT:", text);

    // 🔹 START SESSION
    if (text.startsWith("P0")) {
      const diag = diagnostics[text];

      if (!diag) {
        await safeSend(from, "❌ Code not supported yet.");
        return;
      }

      userState[from] = {
        code: text,
        step: 0,
        answers: {},
      };

      await safeSend(from, `🔍 ${text}\n${diag.questions[0].question}`);
      return;
    }

    // 🔹 CONTINUE SESSION
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

    // 🔹 DEFAULT RESPONSE
    await safeSend(from, "Send code like P0300");

  } catch (err) {
    console.error("❌ BACKGROUND ERROR:", err.response?.data || err.message);
  }
}

// 🔹 SAFE SEND (NON-BLOCKING, TIMEOUT PROTECTED)
async function safeSend(to, message) {
  try {
    console.log("📤 Sending to:", to);

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 5000, // prevents hanging → 502
      }
    );

    console.log("✅ Message sent");
  } catch (err) {
    console.error("❌ SEND ERROR:", err.response?.data || err.message);
  }
}

// 🔴 START SERVER (RAILWAY SAFE)
const PORT = process.env.PORT;
console.log("🌐 Binding to PORT:", PORT);
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});