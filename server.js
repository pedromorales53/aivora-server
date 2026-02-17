const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "aivora_verify_token";
const WHATSAPP_TOKEN = "EAAXWkcxTeZBEBQqKf4DrExgrhOFlc7kiQk6wJlYxaK9AP4C2ZBE4CrnKugakZAZBUIGlC56ii9Ek3zIcc2RHzFMTiGwcq3aBq67WYMeZCOFfjued4JZCRaTbVnU3W2vKNGFGFaKuShs8ZBOeTKiw9yPYtoXZBDw4vRFe2ZBZCvoPfDpgVdk7bdTIcVZBda4nHCnGShZBNWGoNc29ZCjJ2VZAhT4DSLZBcdqqOlFUvaT1hVlMfXyasRR9ZCETZBGD5ZBBI1Haq7ACZAW2WbSQHLF5WjMmKYRiWJOBGc0KoBdWkAZD";
const PHONE_NUMBER_ID = "102091342675354";

let userState = {};

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message) return res.sendStatus(200);

  const from = message.from;
  const text = message.text?.body?.toUpperCase();

  if (!userState[from]) {
    userState[from] = { lastCode: null };
  }

  if (text.includes("P0300")) {
    userState[from].lastCode = "P0300";
    await sendMessage(from, "📟 P0300 detected. Reply CHECK for diagnostic steps.");
  } else if (text === "CHECK") {
    const code = userState[from].lastCode;
    await sendMessage(from, `Running CHECK for ${code}`);
  } else if (text === "FIXED") {
    await sendMessage(from, "What was the final cause?");
  } else {
    await sendMessage(from, "Send Make | Model | Year | Fault Code | Mileage");
  }

  res.sendStatus(200);
});

async function sendMessage(to, message) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: to,
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