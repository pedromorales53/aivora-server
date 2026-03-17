require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// 🔹 ENV VARIABLES
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 🔹 In-memory user state
let userState = {};

// 🔹 Diagnostic Engine (MVP - high value codes only)
const diagnostics = {
  P0300: {
    name: "Random/Multiple Cylinder Misfire",
    questions: [
      { key: "idle", question: "Is the engine rough at idle? (YES/NO)" },
      { key: "accel", question: "Does it hesitate during acceleration? (YES/NO)" }
    ],
    logic: (answers) => {
      if (answers.idle === "YES") {
        return {
          cause: "Faulty spark plugs or ignition coils",
          action: "Inspect and replace spark plugs. Test ignition coils."
        };
      }
      if (answers.accel === "YES") {
        return {
          cause: "Fuel delivery issue",
          action: "Check fuel injectors and fuel pressure."
        };
      }
      return {
        cause: "General misfire condition",
        action: "Inspect ignition, fuel, and intake systems."
      };
    }
  },

  P0171: {
    name: "System Too Lean (Bank 1)",
    questions: [
      { key: "idle", question: "Does the engine idle rough? (YES/NO)" },
      { key: "hiss", question: "Do you hear a hissing sound? (YES/NO)" }
    ],
    logic: (answers) => {
      if (answers.hiss === "YES") {
        return {
          cause: "Vacuum leak",
          action: "Inspect hoses and intake manifold for leaks."
        };
      }
      if (answers.idle === "YES") {
        return {
          cause: "Dirty or faulty MAF sensor",
          action: "Clean or replace the MAF sensor."
        };
      }
      return {
        cause: "Fuel/air imbalance",
        action: "Check fuel pressure and air intake system."
      };
    }
  },

  P0420: {
    name: "Catalyst System Efficiency Below Threshold",
    questions: [
      { key: "power", question: "Has the vehicle lost power? (YES/NO)" },
      { key: "smell", question: "Do you smell sulfur/rotten eggs? (YES/NO)" }
    ],
    logic: (answers) => {
      if (answers.smell === "YES") {
        return {
          cause: "Failing catalytic converter",
          action: "Replace catalytic converter."
        };
      }
      if (answers.power === "YES") {
        return {
          cause: "Exhaust restriction",
          action: "Inspect catalytic converter and exhaust system."
        };
      }
      return {
        cause: "Sensor or catalyst issue",
        action: "Check O2 sensors before replacing catalyst."
      };
    }
  },

  P0455: {
    name: "EVAP System Large Leak",
    questions: [
      { key: "gascap", question: "Was the gas cap recently opened? (YES/NO)" },
      { key: "smell", question: "Do you smell fuel? (YES/NO)" }
    ],
    logic: (answers) => {
      if (answers.gascap === "YES") {
        return {
          cause: "Loose or faulty gas cap",
          action: "Tighten or replace gas cap."
        };
      }
      if (answers.smell === "YES") {
        return {
          cause: "Fuel vapor leak",
          action: "Inspect EVAP lines and canister."
        };
      }
      return {
        cause: "EVAP system leak",
        action: "Perform smoke test on EVAP system."
      };
    }
  },

  P0128: {
    name: "Coolant Temperature Below Thermostat Regulating Temp",
    questions: [
      { key: "warmup", question: "Does the engine take long to warm up? (YES/NO)" },
      { key: "heat", question: "Is cabin heat weak? (YES/NO)" }
    ],
    logic: (answers) => {
      if (answers.warmup === "YES") {
        return {
          cause: "Stuck open thermostat",
          action: "Replace thermostat."
        };
      }
      if (answers.heat === "YES") {
        return {
          cause: "Low coolant or thermostat issue",
          action: "Check coolant level and thermostat."
        };
      }
      return {
        cause: "Cooling system inefficiency",
        action: "Inspect temperature sensor and thermostat."
      };
    }
  }
};

// 🔹 Health check
app.get("/", (req, res) => {
  res.send("Aivora Diagnostics is running");
});

// 🔹 Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// 🔹 Webhook handler
app.post("/webhook", async (req, res) => {
  console.log("🔥 WEBHOOK HIT");

  try {
    console.log("📦 BODY:", JSON.stringify(req.body, null, 2));

    res.sendStatus(200);

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const text = message.text?.body?.toUpperCase().trim() || "";

    console.log("📩 FROM:", from);
    console.log("💬 TEXT:", text);

    // 🔹 If user sends a fault code
    if (text.startsWith("P0")) {
      if (!diagnostics[text]) {
        await sendMessage(from, "❌ Code not supported yet.");
        return;
      }

      userState[from] = {
        code: text,
        step: 0,
        answers: {}
      };

      const firstQ = diagnostics[text].questions[0].question;

      await sendMessage(
        from,
        `🔍 ${text} - ${diagnostics[text].name}\n\n${firstQ}`
      );

      return;
    }

    // 🔹 Handle ongoing diagnostic session
    const state = userState[from];

    if (state && diagnostics[state.code]) {
      const diag = diagnostics[state.code];
      const currentQ = diag.questions[state.step];

      state.answers[currentQ.key] = text;

      state.step++;

      if (state.step < diag.questions.length) {
        const nextQ = diag.questions[state.step].question;
        await sendMessage(from, nextQ);
      } else {
        const result = diag.logic(state.answers);

        await sendMessage(
          from,
          `🧠 Diagnosis for ${state.code}:\n\nCause: ${result.cause}\n\nAction: ${result.action}`
        );

        delete userState[from];
      }

      return;
    }

    // 🔹 Default fallback
    await sendMessage(
      from,
      "Send a fault code (e.g., P0300) to start diagnosis."
    );

  } catch (error) {
    console.error("❌ Webhook error:", error.response?.data || error.message);
  }
});

// 🔹 Send message helper
async function sendMessage(to, message) {
  console.log("📤 Sending message to:", to);

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Message sent:", response.data);

  } catch (err) {
    console.error("❌ Send error:", err.response?.data || err.message);
  }
}

// 🔹 Start server (Railway compatible)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});