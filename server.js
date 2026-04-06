require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

process.on("uncaughtException", (err) => console.error("💥 UNCAUGHT:", err));
process.on("unhandledRejection", (err) => console.error("💥 REJECTION:", err));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const { VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID } = process.env;

// ─────────────────────────────────────────────────────────────
// 📁 LEARNING LOG
// Every resolved case appended as newline-delimited JSON.
// This is your real-world training data for Phase 2.
// ─────────────────────────────────────────────────────────────
const LOG_PATH = path.join(__dirname, "resolved_cases.jsonl");

function logResolvedCase(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() });
  fs.appendFileSync(LOG_PATH, line + "\n");
}

// ─────────────────────────────────────────────────────────────
// 🗃️ SESSION STORE
// In-memory for V1. Swap for Redis in Phase 2.
// ─────────────────────────────────────────────────────────────
const userState = {};

// ─────────────────────────────────────────────────────────────
// 🔧 DIAGNOSTIC DATABASE
// logic(answers, vehicle) → { cause, action }
// Vehicle context is used NOW — not deferred.
// ─────────────────────────────────────────────────────────────
const diagnostics = {
  P0300: {
    name: "Falla aleatoria en múltiples cilindros",
    questions: [
      { key: "idle", ask: "1️⃣ ¿El motor vibra o falla en *ralentí/mínimo*? (SI / NO)" },
      { key: "accel", ask: "2️⃣ ¿Siente *jalones o titubeo* al acelerar? (SI / NO)" },
      { key: "plugs", ask: "3️⃣ ¿Cuándo fue el último cambio de *bujías*?\n A) Reciente B) Más de 1 año C) No sé" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      const old = km > 80000;
      if (a.idle === "SI" && a.plugs !== "A")
        return { cause: "Bujías o bobinas defectuosas", action: `Con ${km.toLocaleString()} km en un ${v.year} ${v.make} ${v.model}, revisar bujías y probar bobinas de encendido individualmente.` };
      if (a.accel === "SI")
        return { cause: "Problema de combustible o inyectores", action: "Verificar presión de combustible y flujo de inyectores. Considerar limpieza en ultrasonido." };
      if (old)
        return { cause: "Desgaste acumulado por alto kilometraje", action: `A ${km.toLocaleString()} km conviene hacer prueba de compresión y revisar estado de anillos.` };
      return { cause: "Falla intermitente — requiere escaneo en tiempo real", action: "Revisar datos de RPM, TPS y MAF con escáner mientras el fallo ocurre." };
    }
  },

  P0171: {
    name: "Mezcla pobre — Banco 1",
    questions: [
      { key: "hiss", ask: "1️⃣ ¿Escucha algún *silbido* cerca del motor encendido? (SI / NO)" },
      { key: "idle", ask: "2️⃣ ¿El motor *falla en mínimo* o se apaga solo? (SI / NO)" },
      { key: "maf", ask: "3️⃣ ¿El sensor MAF ha sido limpiado o cambiado?\n A) Sí, recientemente B) No C) No sé" }
    ],
    logic: (a, v) => {
      if (a.hiss === "SI")
        return { cause: "Fuga de vacío", action: `Inspeccionar mangueras y múltiple de admisión del ${v.make} ${v.model}. Las fugas de vacío son frecuentes con el calor de CDMX.` };
      if (a.maf === "B" || a.maf === "C")
        return { cause: "Sensor MAF sucio o degradado", action: "Limpiar con spray para MAF. Si persiste, comparar lectura g/s vs especificación de fábrica." };
      return { cause: "Inyector sucio o baja presión de combustible", action: "Medir presión de combustible en riel. Si es correcta, limpiar inyectores con servicio ultrasónico." };
    }
  },

  P0420: {
    name: "Eficiencia baja del catalizador — Banco 1",
    questions: [
      { key: "smell", ask: "1️⃣ ¿Detecta *olor a huevo podrido* en el escape? (SI / NO)" },
      { key: "power", ask: "2️⃣ ¿Nota *pérdida de potencia* o aceleración lenta? (SI / NO)" }
    ],
    logic: (a, v) => {
      const age = new Date().getFullYear() - (parseInt(v.year) || 2010);
      if (a.smell === "SI" && age > 8)
        return { cause: "Catalizador deteriorado por antigüedad", action: `Con ${age} años de uso, el catalizador del ${v.make} ${v.model} probablemente necesita reemplazo. Cotizar antes de cambiar sensores O2.` };
      if (a.smell === "NO")
        return { cause: "Sensor O2 trasero dando falsos positivos", action: "Verificar voltaje del O2 trasero con osciloscopio antes de reemplazar catalizador." };
      return { cause: "Catalizador contaminado por mezcla rica prolongada", action: "Inspeccionar visualmente. Verificar si hubo fallas de inyectores previas que lo saturaron." };
    }
  },

  P0455: {
    name: "Fuga grande en sistema EVAP",
    questions: [
      { key: "cap", ask: "1️⃣ ¿Revisó que la *tapa del tanque* esté bien cerrada? (SI / NO)" },
      { key: "smell", ask: "2️⃣ ¿Huele *gasolina* cerca del vehículo estacionado? (SI / NO)" }
    ],
    logic: (a) => {
      if (a.cap === "NO")
        return { cause: "Tapa de tanque floja o dañada", action: "Apretar o reemplazar tapa. Limpiar código y monitorear — es la causa #1 del P0455." };
      if (a.smell === "SI")
        return { cause: "Fuga física en líneas EVAP", action: "Realizar prueba de humo en sistema EVAP para localizar fuga. Revisar purge valve y mangueras." };
      return { cause: "Válvula de purga o sensor de presión EVAP defectuoso", action: "Probar válvula de purga con multímetro (12V al activar). Verificar sensor de presión del tanque." };
    }
  },

  P0128: {
    name: "Temperatura del motor bajo umbral del termostato",
    questions: [
      { key: "warmup", ask: "1️⃣ ¿El motor *tarda mucho en llegar a temperatura normal*? (SI / NO)" },
      { key: "heat", ask: "2️⃣ ¿La *calefacción* del habitáculo funciona bien? (SI / NO)" }
    ],
    logic: (a, v) => {
      if (a.warmup === "SI" && a.heat === "NO")
        return { cause: "Termostato atascado en posición abierta", action: `Reemplazar termostato del ${v.make} ${v.model} — es la reparación más probable y accesible para este código.` };
      if (a.warmup === "SI" && a.heat === "SI")
        return { cause: "Sensor ECT (temperatura) descalibrado", action: "Comparar lectura real vs escáner con termómetro infrarrojo. El sensor puede estar reportando bajo." };
      return { cause: "Falla intermitente del termostato", action: "Monitorear temperatura en tiempo real durante recorrido completo. Puede fallar solo bajo cierta carga." };
    }
  }
};

// ─────────────────────────────────────────────────────────────
// 🔹 INPUT PARSERS
// ─────────────────────────────────────────────────────────────

/**
 * Pipe format: Make | Model | Year | Code | Mileage
 * Returns { vehicle, code } or null
 */
function parsePipeInput(text) {
  if (!text.includes("|")) return null;
  const parts = text.split("|").map(x => x.trim());
  if (parts.length < 4) return null;

  const [make, model, year, rawCode, mileage = "0"] = parts;
  const code = rawCode.toUpperCase().match(/P[0-9]{4}/)?.[0];
  if (!code) return null;

  return {
    vehicle: { make, model, year, mileage: mileage.replace(/[^0-9]/g, "") },
    code
  };
}

/** Extract standalone fault code from text */
function extractCode(text) {
  return text.toUpperCase().match(/P[0-9]{4}/)?.[0] || null;
}

// ─────────────────────────────────────────────────────────────
// 🔹 HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.status(200).send("Aivora Engine: Online ✅"));

// ─────────────────────────────────────────────────────────────
// 🔹 WEBHOOK VERIFICATION
// ─────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ─────────────────────────────────────────────────────────────
// 🔹 WEBHOOK RECEIVER
// ─────────────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  res.status(200).send("EVENT_RECEIVED");
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;
  setImmediate(() => handleInteraction(message));
});

// ─────────────────────────────────────────────────────────────
// 🔹 MAIN INTERACTION ENGINE
// ─────────────────────────────────────────────────────────────
async function handleInteraction(message) {
  try {
    const from = message.from;
    const text = (message.text?.body || "").trim();
    const upper = text.toUpperCase();
    const state = userState[from] || {};

    // ── GLOBAL: RESET ────────────────────────────────────────
    if (["RESET", "REINICIAR", "NUEVO"].some(c => upper.includes(c))) {
      delete userState[from];
      return safeSend(from,
        `🔄 Sesión reiniciada.\n\n` +
        `Envíame el diagnóstico en este formato:\n\n` +
        `*Marca | Modelo | Año | Código | Kilometraje*\n` +
        `_Ej: Chevrolet | Aveo | 2015 | P0300 | 120000_\n\n` +
        `O solo el código si no tienes datos del vehículo:\n_Ej: P0300_`
      );
    }

    // ── STAGE: Awaiting FIXED / NOT FIXED ────────────────────
    if (state.stage === "awaiting_feedback") {
      return handleFeedback(from, upper, state);
    }

    // ── STAGE: Awaiting actual fix description ────────────────
    if (state.stage === "awaiting_fix_description") {
      return handleFixDescription(from, text, state);
    }

    // ── STAGE: Q&A in progress ────────────────────────────────
    if (state.stage === "questioning") {
      return handleAnswer(from, upper, state);
    }

    // ── NEW INPUT: pipe format ────────────────────────────────
    const parsed = parsePipeInput(text);
    if (parsed) {
      return startDiagnostic(from, parsed.code, parsed.vehicle);
    }

    // ── NEW INPUT: code only ──────────────────────────────────
    const code = extractCode(text);
    if (code) {
      const vehicle = state.vehicle || { make: "", model: "", year: "", mileage: "0" };
      return startDiagnostic(from, code, vehicle);
    }

    // ── FALLBACK ──────────────────────────────────────────────
    return safeSend(from,
      `👋 Bienvenido a *Aivora Diagnostics* 🔧\n\n` +
      `Envíame el diagnóstico así:\n\n` +
      `*Marca | Modelo | Año | Código | Kilometraje*\n` +
      `_Ej: Nissan | Sentra | 2016 | P0171 | 95000_\n\n` +
      `O solo el código de falla:\n` +
      `_Ej: P0171_`
    );

  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 🔹 START DIAGNOSTIC
// ─────────────────────────────────────────────────────────────
async function startDiagnostic(from, code, vehicle) {
  const diag = diagnostics[code];

  if (!diag) {
    return safeSend(from,
      `⚠️ Código *${code}* no está en mi base aún.\n\n` +
      `Códigos disponibles: P0300, P0171, P0420, P0455, P0128\n\n` +
      `Estamos expandiendo continuamente. ¡Gracias!`
    );
  }

  userState[from] = { stage: "questioning", code, vehicle, step: 0, answers: {} };

  const hasVehicle = vehicle.make && vehicle.make.length > 0;
  const label = hasVehicle
    ? `🚗 ${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.mileage > 0 ? ` · ${Number(vehicle.mileage).toLocaleString()} km` : ""}\n`
    : "";

  return safeSend(from,
    `🔍 *${code} — ${diag.name}*\n` +
    label +
    `\nVamos a identificar la causa 👇\n\n` +
    diag.questions[0].ask
  );
}

// ─────────────────────────────────────────────────────────────
// 🔹 HANDLE Q&A ANSWERS
// ─────────────────────────────────────────────────────────────
async function handleAnswer(from, upper, state) {
  const diag = diagnostics[state.code];
  const current = diag.questions[state.step];

  state.answers[current.key] = upper;
  state.step++;

  if (state.step < diag.questions.length) {
    return safeSend(from, diag.questions[state.step].ask);
  }

  // All answered → run logic engine
  const result = diag.logic(state.answers, state.vehicle);
  const v = state.vehicle;
  const hasV = v.make && v.make.length > 0;

  state.lastResult = result;
  state.stage = "awaiting_feedback";

  return safeSend(from,
    `🧠 *Diagnóstico Aivora*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    (hasV ? `🚗 ${v.year} ${v.make} ${v.model} · ${Number(v.mileage).toLocaleString()} km\n` : "") +
    `🔎 ${state.code}\n\n` +
    `*Causa probable:*\n${result.cause}\n\n` +
    `*Acción recomendada:*\n${result.action}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `¿Esto resolvió el problema?\n\n` +
    `✅ *FIXED* — Sí, resuelto\n` +
    `❌ *NO* — Sigue fallando`
  );
}

// ─────────────────────────────────────────────────────────────
// 🔹 HANDLE FEEDBACK
// ─────────────────────────────────────────────────────────────
async function handleFeedback(from, upper, state) {
  const resolved = upper.includes("FIXED") || upper.includes("LISTO") || upper.includes("SI");

  if (resolved) {
    state.stage = "awaiting_fix_description";
    return safeSend(from,
      `✅ *¡Excelente trabajo!* 🚗💨\n\n` +
      `Una última cosa — ¿cuál fue la reparación final?\n` +
      `_(Ej: "Cambié las bujías y la bobina del cilindro 3")_\n\n` +
      `Esto mejora Aivora para todos los técnicos. 🙏`
    );
  }

  // NOT FIXED → escalate gracefully
  state.stage = "escalated";
  return safeSend(from,
    `⚠️ *Diagnóstico no resuelto — Profundizando*\n\n` +
    `El código *${state.code}* puede tener una causa más profunda.\n\n` +
    `Pasos adicionales recomendados:\n` +
    `• Escanear datos en tiempo real: RPM, TPS, MAF, O2\n` +
    `• Verificar tierra del motor y voltaje de batería en ralentí\n` +
    `• Revisar actualizaciones de calibración (TSB) para este modelo\n` +
    `• Si persiste, considerar inspección física especializada\n\n` +
    `Envía un nuevo código o escribe *RESET* para nuevo vehículo.`
  );
}

// ─────────────────────────────────────────────────────────────
// 🔹 HANDLE FIX DESCRIPTION — THE LEARNING LOOP 🎯
// Real-world repair outcomes = your Phase 2 training data
// ─────────────────────────────────────────────────────────────
async function handleFixDescription(from, text, state) {
  logResolvedCase({
    phone: from,
    vehicle: state.vehicle,
    code: state.code,
    answers: state.answers,
    aivora_diagnosis: state.lastResult,
    actual_fix: text // ← the gold
  });

  delete userState[from];

  return safeSend(from,
    `✅ *¡Registrado, gracias!*\n\n` +
    `Cada caso confirmado hace a Aivora más preciso para todos los talleres. 🧠\n\n` +
    `Envía un nuevo código cuando lo necesites. ¡Éxito! 🔧`
  );
}

// ─────────────────────────────────────────────────────────────
// 🔹 SEND HELPER
// ─────────────────────────────────────────────────────────────
async function safeSend(to, body) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, timeout: 8000 }
    );
  } catch (err) {
    console.error("❌ Send Error:", err.response?.data || err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 🔹 START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Aivora V1 active on port ${PORT}`));