require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

let userState = {};

// 🔹 Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// 🔹 Webhook events (POST)
app.post("/webhook", async (req, res) => {
  try {
    console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));

    // ✅ Always acknowledge first
    res.sendStatus(200);

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const text = message.text?.body?.toUpperCase();

    if (!userState[from]) {
      userState[from] = { lastCode: null };
    }

    if (text?.includes("P0300")) {
      userState[from].lastCode = "P0300";
      await sendMessage(from, "📟 P0300 detected. Reply CHECK for diagnostic steps.");
    } 
    else if (text === "CHECK") {
      const code = userState[from].lastCode;
      await sendMessage(from, `Running CHECK for ${code}`);
    } 
    else if (text === "FIXED") {
      await sendMessage(from, "What was the final cause?");
    } 
    else {
      await sendMessage(from, "Send Make | Model | Year | Fault Code | Mileage");
    }

  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
  }
});

// 🔹 Send message function
async function sendMessage(to, message) {
  await axios.post(
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
}

app.listen(3000, () => {
  console.log("Server running on port 3000");
});