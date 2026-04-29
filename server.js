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

  // ── EXISTING CODES ─────────────────────────────────────────

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
  },

  // ── NUEVOS CÓDIGOS — NISSAN VERSA ESPECÍFICOS ───────────────

  P0507: {
    name: "RPM de ralentí por encima del rango esperado",
    questions: [
      { key: "ac", ask: "1️⃣ ¿Las RPM suben al encender el *aire acondicionado*? (SI / NO)" },
      { key: "cleaned", ask: "2️⃣ ¿El cuerpo de aceleración ha sido *limpiado recientemente*? (SI / NO)" },
      { key: "rough", ask: "3️⃣ ¿El ralentí se siente *irregular o inestable* además de alto? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa, este problema es muy frecuente por el diseño del cuerpo de aceleración electrónico (DBW)." : "";
      if (a.cleaned === "SI")
        return {
          cause: "Cuerpo de aceleración desadaptado tras limpieza",
          action: `Realizar procedimiento de reaprendizaje del cuerpo de aceleración (Throttle Body Relearn): apagar y encender llave sin arrancar, esperar 3 seg, arrancar y dejar en ralentí 10 min sin tocar el acelerador.${versaNote}`
        };
      if (a.ac === "SI" && a.rough === "NO")
        return {
          cause: "Compensación normal del sistema IAC por carga del A/C",
          action: "Verificar que las RPM bajen al mínimo esperado (650–750 RPM) con A/C apagado. Si permanecen altas, limpiar cuerpo de aceleración con spray especializado."
        };
      if (a.rough === "SI")
        return {
          cause: "Válvula IAC sucia o sensor TPS descalibrado",
          action: `Limpiar válvula de control de aire en ralentí (IAC). Verificar lectura de TPS con escáner: debe ser 0.5V en reposo. Si falla, reemplazar TPS.${versaNote}`
        };
      return {
        cause: "Fuga de aire no controlada en admisión",
        action: `Inspeccionar mangueras del múltiple de admisión y empaques. Una fuga mínima puede elevar RPM sin encender otros códigos.${versaNote}`
      };
    }
  },

  P0340: {
    name: "Circuito del sensor de posición del árbol de levas — Sin señal",
    questions: [
      { key: "start", ask: "1️⃣ ¿El vehículo *no enciende* o enciende con mucho esfuerzo? (SI / NO)" },
      { key: "stall", ask: "2️⃣ ¿El motor se ha *apagado solo* mientras conducía? (SI / NO)" },
      { key: "recent", ask: "3️⃣ ¿Se realizó algún trabajo en el motor *recientemente* (distribución, cabeza)? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Nissan Versa, el sensor CMP está ubicado en la parte trasera del motor — revisar conector antes de reemplazar." : "";
      if (a.recent === "SI")
        return {
          cause: "Sensor CMP desconectado o mal posicionado tras intervención",
          action: `Verificar conector del sensor de árbol de levas (CMP) y que el reluctor esté correctamente alineado.${versaNote} Un error de instalación puede generar este código sin que el sensor esté dañado.`
        };
      if (a.start === "SI" && a.stall === "SI")
        return {
          cause: "Sensor CMP defectuoso — falla crítica",
          action: `El sensor de árbol de levas no está enviando señal a la ECU. Esto puede dejar el vehículo varado.${versaNote} Reemplazar sensor CMP. Costo estimado en LATAM: $300–$600 MXN en refacción genérica.`
        };
      if (a.stall === "SI")
        return {
          cause: "Señal intermitente del CMP — posible fallo de cableado",
          action: `Revisar continuidad del cableado del sensor con multímetro. Un cable roto internamente puede causar señal intermitente sin que se vea daño externo.${versaNote}`
        };
      return {
        cause: "Posible fallo del circuito o interferencia eléctrica",
        action: `Medir resistencia del sensor CMP (especificación Nissan: 200–900 Ohms en frío). Si está fuera de rango, reemplazar.${versaNote}`
      };
    }
  },

  P0101: {
    name: "Sensor MAF — Rango o desempeño fuera de especificación",
    questions: [
      { key: "filter", ask: "1️⃣ ¿El *filtro de aire* ha sido cambiado recientemente o está sucio? (SI / NO)" },
      { key: "power", ask: "2️⃣ ¿Nota *falta de potencia* o aceleración lenta? (SI / NO)" },
      { key: "idle", ask: "3️⃣ ¿El motor falla o fluctúa en *ralentí*? (SI / NO)" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa, el MAF es especialmente sensible al aceite de filtros reutilizables — si usas filtro de algodón (K&N tipo), eso puede contaminarlo." : "";
      if (a.filter === "SI")
        return {
          cause: "Filtro de aire contaminando el sensor MAF",
          action: `Limpiar el sensor MAF con spray especializado (no usar limpiador multiusos). Dejar secar 30 min antes de arrancar.${versaNote}`
        };
      if (a.power === "SI" && a.idle === "SI")
        return {
          cause: "Sensor MAF degradado — lectura g/s incorrecta",
          action: `Con ${km.toLocaleString()} km, el sensor MAF puede estar al final de su vida útil. Verificar lectura en escáner: a ralentí debe leer entre 2–7 g/s en la Versa. Si está fuera de rango, reemplazar.`
        };
      if (a.power === "SI" && a.idle === "NO")
        return {
          cause: "MAF leyendo bajo bajo carga — posible obstrucción parcial",
          action: "Limpiar conducto de admisión completo y sensor MAF. Verificar que no haya cuerpos extraños antes del sensor."
        };
      return {
        cause: "Falla intermitente del MAF o conexión eléctrica débil",
        action: `Revisar conector del MAF — los pines pueden oxidarse en climas húmedos. Limpiar con limpiador de contactos eléctricos.${versaNote}`
      };
    }
  },

  P0605: {
    name: "Error interno de la ECU — ROM",
    questions: [
      { key: "multiple", ask: "1️⃣ ¿Aparecen *múltiples códigos al mismo tiempo* además del P0605? (SI / NO)" },
      { key: "battery", ask: "2️⃣ ¿La batería fue desconectada o hubo algún *corto eléctrico* recientemente? (SI / NO)" },
      { key: "start", ask: "3️⃣ ¿El vehículo *enciende y funciona* a pesar del código? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Nissan Versa, antes de reemplazar la ECU verifica que la versión de software sea compatible con tu año exacto de modelo." : "";
      if (a.battery === "SI" && a.multiple === "SI")
        return {
          cause: "Corrupción temporal de memoria tras evento eléctrico",
          action: "Desconectar batería por 15 minutos, reconectar y borrar códigos. Si el P0605 reaparece solo, la ECU tiene daño permanente. Si reaparecen otros, investigar esos primero."
        };
      if (a.start === "SI" && a.multiple === "NO")
        return {
          cause: "Error de checksum en ECU — puede ser transitorio",
          action: `Borrar el código y monitorear. Si regresa en menos de 50 km sin causa aparente, la ECU requiere reprogramación o reemplazo.${versaNote} Buscar opción de ECU remanufacturada antes de comprar nueva.`
        };
      if (a.start === "NO")
        return {
          cause: "Fallo crítico de ECU — vehículo inoperable",
          action: `Este escenario requiere diagnóstico eléctrico presencial urgente. Verificar voltaje de alimentación a la ECU (debe ser 12V estables) y tierras del motor antes de concluir que la ECU está dañada.${versaNote}`
        };
      return {
        cause: "ECU con posible daño interno por humedad o sobretensión",
        action: `Inspeccionar físicamente la ECU buscando signos de humedad, quemaduras o corrosión en el conector. Una ECU dañada por agua puede fallar intermitentemente.${versaNote}`
      };
    }
  },

  P0868: {
    name: "Presión de línea de transmisión CVT baja",
    questions: [
      { key: "slip", ask: "1️⃣ ¿Nota que el motor *acelera pero el carro no avanza* al mismo ritmo (patinamiento)? (SI / NO)" },
      { key: "fluid", ask: "2️⃣ ¿El aceite de transmisión ha sido *revisado o cambiado* recientemente? (SI / NO)" },
      { key: "shudder", ask: "3️⃣ ¿Siente *vibración o temblor* al acelerar entre 40–80 km/h? (SI / NO)" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa
        ? " ⚠️ La CVT de la Nissan Versa es conocida por fallas prematuras. Nissan extendió la garantía en algunos mercados — verificar si tu VIN aplica en nissan.com.mx."
        : "";
      if (a.fluid === "NO" && km > 60000)
        return {
          cause: "Aceite CVT degradado — baja presión hidráulica",
          action: `Con ${km.toLocaleString()} km sin cambio de fluido CVT, la viscosidad baja genera pérdida de presión. Cambiar fluido usando *exclusivamente NS-3 o NS-2* para Nissan CVT. Fluidos incorrectos dañan la transmisión.${versaNote}`
        };
      if (a.slip === "SI" && a.shudder === "SI")
        return {
          cause: "Falla interna de la CVT — banda o polea dañada",
          action: `Los síntomas indican daño mecánico interno. Llevar a revisión especializada en transmisiones CVT antes de que el daño sea total.${versaNote} Evitar uso prolongado del vehículo en este estado.`
        };
      if (a.slip === "SI" && a.shudder === "NO")
        return {
          cause: "Válvula de control de presión CVT sucia o defectuosa",
          action: `Cambiar fluido CVT y limpiar filtro interno si es accesible. La válvula de presión puede responder a fluido limpio. Si el patinamiento persiste, revisar sensor de presión de línea.${versaNote}`
        };
      return {
        cause: "Sensor de presión de línea CVT defectuoso",
        action: `Si no hay síntomas físicos claros, el sensor puede estar reportando baja presión falsamente. Verificar con escáner la presión real vs la reportada. Reemplazar sensor si hay discrepancia.${versaNote}`
      };
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
        `_Ej: Nissan | Versa | 2018 | P0300 | 95000_\n\n` +
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
      `_Ej: Nissan | Versa | 2018 | P0171 | 95000_\n\n` +
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
      `Códigos disponibles:\n` +
      `P0300 · P0171 · P0420 · P0455 · P0128\n` +
      `P0507 · P0340 · P0101 · P0605 · P0868\n\n` +
      `Estamos expandiendo continuamente. ¡Gracias por tu paciencia!`
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
    actual_fix: text
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
      `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
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
app.listen(PORT, () => console.log(`🚀 Aivora V1 active on port ${PORT} — 10 códigos activos`));