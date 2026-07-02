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
// 📁 DATA DIR — PERSISTENCIA
// Si existe la variable DATA_DIR (ej. /data con un Volume de
// Railway montado ahí), los logs sobreviven redeploys/restarts.
// Sin la variable, cae al comportamiento anterior (efímero).
// ─────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error("mkdir DATA_DIR:", e.message); }
const IS_PERSISTENT = DATA_DIR !== __dirname;

const LOG_PATH          = path.join(DATA_DIR, "resolved_cases.jsonl");  // diagnósticos completados + fix real
const MISS_PATH         = path.join(DATA_DIR, "missed_codes.jsonl");    // códigos que pidieron y no tenemos
const INTERACTIONS_PATH = path.join(DATA_DIR, "interactions.jsonl");    // cada mensaje entrante
const SYMPTOM_PATH      = path.join(DATA_DIR, "symptom_backlog.jsonl"); // síntomas sin código
const EVENTS_PATH       = path.join(DATA_DIR, "events.jsonl");          // funnel: diag_start, diag_result, offer_shown...
const INTEREST_PATH     = path.join(DATA_DIR, "pack_interest.jsonl");   // 🎯 leads del smoke test de monetización

const SERVER_STARTED = new Date().toISOString();

function appendLine(p, obj) {
  try { fs.appendFileSync(p, JSON.stringify({ ...obj, ts: new Date().toISOString() }) + "\n"); }
  catch (e) { console.error("log error:", e.message); }
}
const logResolvedCase = (entry)            => appendLine(LOG_PATH, entry);
const logMissedCode   = (from, code, raw)  => appendLine(MISS_PATH, { from, code, rawText: raw });
const logInteraction  = (from, text)       => appendLine(INTERACTIONS_PATH, { from, text });
const logSymptom      = (from, tag, raw)   => appendLine(SYMPTOM_PATH, { from, tag, rawText: raw });
const logEvent        = (from, event, meta = {}) => appendLine(EVENTS_PATH, { from, event, ...meta });
const logInterest     = (from, level, raw) => appendLine(INTEREST_PATH, { from, level, rawText: raw });

// ─────────────────────────────────────────────────────────────
// 💰 SMOKE TEST DE MONETIZACIÓN — "AIVORA PRO" (pack prepagado)
// NO hay paywall: Aivora sigue gratis. Esto SOLO mide señal de
// disposición a pagar. Pedro cierra los leads manualmente.
// Edita precio/copy aquí; OFFER_ENABLED=false lo apaga sin deploy
// de código (via variable de entorno en Railway).
// ─────────────────────────────────────────────────────────────
const OFFER_ENABLED = (process.env.OFFER_ENABLED || "true").toLowerCase() !== "false";
const OFFER_PRICE   = process.env.OFFER_PRICE || "$99 MXN";

const OFFER_FOOTER = `\n\n💡 ¿Quieres diagnósticos *prioritarios* con seguimiento personal? Manda *INFO*`;

const OFFER_FULL =
  `🚀 *Aivora Pro* — lanzamiento\n\n` +
  `Estamos armando el primer paquete de pago:\n\n` +
  `🔧 10 diagnósticos prioritarios\n` +
  `📸 Puedes mandar fotos y audios del problema\n` +
  `👨‍🔧 Seguimiento personal hasta que quede resuelto\n` +
  `💰 ${OFFER_PRICE} (precio de lanzamiento — primeros 20 lugares)\n\n` +
  `Aivora normal sigue *gratis*, esto es para quien quiere ir más a fondo.\n\n` +
  `¿Te apartamos un lugar? Responde *ME INTERESA* 👇`;

const OFFER_CONFIRMED =
  `🙌 *¡Listo, quedaste apuntado!*\n\n` +
  `Pedro (el creador de Aivora) te escribe personalmente por aquí para apartarte tu lugar y ver la forma de pago.\n\n` +
  `Mientras tanto puedes seguir usando Aivora gratis como siempre. 🔧`;

// ─────────────────────────────────────────────────────────────
// 🗃️ SESSION STORE (in-memory para V1; Redis es Phase 2)
// ─────────────────────────────────────────────────────────────
const userState = {};
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6h: sesión abandonada → empezar de cero

// ─────────────────────────────────────────────────────────────
// 🔧 DIAGNOSTIC DATABASE
// logic(answers, vehicle) → { cause, action }
// ─────────────────────────────────────────────────────────────
const diagnostics = {

  // ── ORIGINALES ─────────────────────────────────────────────

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

  // ── VERSA — PRIMERA TANDA ───────────────────────────────────

  P0507: {
    name: "RPM de ralentí por encima del rango esperado",
    questions: [
      { key: "ac", ask: "1️⃣ ¿Las RPM suben al encender el *aire acondicionado*? (SI / NO)" },
      { key: "cleaned", ask: "2️⃣ ¿El cuerpo de aceleración ha sido *limpiado recientemente*? (SI / NO)" },
      { key: "rough", ask: "3️⃣ ¿El ralentí se siente *irregular o inestable* además de alto? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa este problema es muy frecuente por el cuerpo de aceleración electrónico (DBW)." : "";
      if (a.cleaned === "SI")
        return { cause: "Cuerpo de aceleración desadaptado tras limpieza", action: `Hacer reaprendizaje (Throttle Body Relearn): llave en ON sin arrancar 3 seg, apagar, repetir 3 veces, arrancar y dejar en ralentí 10 min sin tocar el acelerador.${versaNote}` };
      if (a.ac === "SI" && a.rough === "NO")
        return { cause: "Compensación normal del IAC por carga del A/C", action: "Verificar que las RPM bajen a 650–750 con A/C apagado. Si siguen altas, limpiar cuerpo de aceleración." };
      if (a.rough === "SI")
        return { cause: "Válvula IAC sucia o TPS descalibrado", action: `Limpiar IAC. Verificar TPS con escáner: 0.5V en reposo. Si falla, reemplazar TPS.${versaNote}` };
      return { cause: "Fuga de aire no controlada en admisión", action: `Inspeccionar mangueras del múltiple y empaques. Una fuga mínima eleva RPM sin otros códigos.${versaNote}` };
    }
  },

  P0340: {
    name: "Sensor de posición del árbol de levas (CMP) — Sin señal",
    questions: [
      { key: "start", ask: "1️⃣ ¿El vehículo *no enciende* o enciende con esfuerzo? (SI / NO)" },
      { key: "stall", ask: "2️⃣ ¿Se ha *apagado solo* mientras conducía? (SI / NO)" },
      { key: "recent", ask: "3️⃣ ¿Hubo trabajo en el motor *reciente* (distribución, cabeza)? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa el CMP está en la parte trasera del motor — revisar conector antes de reemplazar." : "";
      if (a.recent === "SI")
        return { cause: "CMP desconectado o mal posicionado tras intervención", action: `Verificar conector del CMP y alineación del reluctor.${versaNote}` };
      if (a.start === "SI" && a.stall === "SI")
        return { cause: "Sensor CMP defectuoso — falla crítica", action: `No envía señal a la ECU; puede dejar el carro varado. Reemplazar CMP ($300–600 MXN genérico).${versaNote}` };
      if (a.stall === "SI")
        return { cause: "Señal intermitente del CMP — cableado", action: `Revisar continuidad con multímetro. Un cable roto internamente da señal intermitente sin daño visible.${versaNote}` };
      return { cause: "Fallo del circuito o interferencia eléctrica", action: `Medir resistencia del CMP (200–900 Ω en frío). Fuera de rango, reemplazar.${versaNote}` };
    }
  },

  P0101: {
    name: "Sensor MAF — fuera de especificación",
    questions: [
      { key: "filter", ask: "1️⃣ ¿El *filtro de aire* está sucio o se cambió recién? (SI / NO)" },
      { key: "power", ask: "2️⃣ ¿Nota *falta de potencia*? (SI / NO)" },
      { key: "idle", ask: "3️⃣ ¿El motor fluctúa en *ralentí*? (SI / NO)" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa el MAF es sensible al aceite de filtros tipo K&N." : "";
      if (a.filter === "SI")
        return { cause: "Filtro contaminando el MAF", action: `Limpiar el MAF con spray especializado (no multiusos). Secar 30 min antes de arrancar.${versaNote}` };
      if (a.power === "SI" && a.idle === "SI")
        return { cause: "MAF degradado — lectura g/s incorrecta", action: `Con ${km.toLocaleString()} km el MAF puede estar al final de su vida. A ralentí debe leer 2–7 g/s. Fuera de rango, reemplazar.` };
      if (a.power === "SI" && a.idle === "NO")
        return { cause: "MAF leyendo bajo bajo carga", action: "Limpiar conducto de admisión y MAF. Verificar que no haya cuerpos extraños." };
      return { cause: "Falla intermitente del MAF o conexión débil", action: `Revisar conector del MAF — los pines se oxidan en clima húmedo. Limpiar con limpiador de contactos.${versaNote}` };
    }
  },

  P0605: {
    name: "Error interno de la ECU (ROM)",
    questions: [
      { key: "multiple", ask: "1️⃣ ¿Hay *múltiples códigos* además del P0605? (SI / NO)" },
      { key: "battery", ask: "2️⃣ ¿Hubo *corto eléctrico* o batería desconectada reciente? (SI / NO)" },
      { key: "start", ask: "3️⃣ ¿El carro *enciende y funciona* a pesar del código? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa, verifica compatibilidad de software con tu año exacto antes de reemplazar la ECU." : "";
      if (a.battery === "SI" && a.multiple === "SI")
        return { cause: "Corrupción temporal de memoria tras evento eléctrico", action: "Desconectar batería 15 min, reconectar y borrar. Si el P0605 vuelve solo, ECU dañada; si vuelven otros, investigar esos." };
      if (a.start === "SI" && a.multiple === "NO")
        return { cause: "Error de checksum — puede ser transitorio", action: `Borrar y monitorear. Si vuelve en <50 km, ECU requiere reprogramación o reemplazo. Buscar ECU remanufacturada.${versaNote}` };
      if (a.start === "NO")
        return { cause: "Fallo crítico de ECU — inoperable", action: `Diagnóstico eléctrico presencial urgente. Verificar 12V de alimentación y tierras antes de condenar la ECU.${versaNote}` };
      return { cause: "Posible daño interno por humedad/sobretensión", action: `Inspeccionar la ECU por humedad, quemaduras o corrosión en el conector.${versaNote}` };
    }
  },

  P0868: {
    name: "Presión de línea de transmisión CVT baja",
    questions: [
      { key: "slip", ask: "1️⃣ ¿El motor *acelera pero el carro no avanza* igual (patina)? (SI / NO)" },
      { key: "fluid", ask: "2️⃣ ¿El aceite CVT se *revisó/cambió* reciente? (SI / NO)" },
      { key: "shudder", ask: "3️⃣ ¿Siente *temblor* al acelerar entre 40–80 km/h? (SI / NO)" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " ⚠️ La CVT de la Versa falla seguido. Verifica si tu VIN aplica a garantía extendida en nissan.com.mx." : "";
      if (a.fluid === "NO" && km > 60000)
        return { cause: "Aceite CVT degradado — baja presión", action: `Con ${km.toLocaleString()} km sin cambio, cambiar fluido SOLO con NS-3 (o NS-2). Fluidos incorrectos dañan la CVT.${versaNote}` };
      if (a.slip === "SI" && a.shudder === "SI")
        return { cause: "Falla interna de la CVT (banda o polea)", action: `Daño mecánico interno. Revisión especializada en CVT antes de que sea total.${versaNote} Evitar uso prolongado.` };
      if (a.slip === "SI" && a.shudder === "NO")
        return { cause: "Válvula de control de presión CVT sucia", action: `Cambiar fluido CVT y limpiar filtro interno. Si persiste, revisar sensor de presión de línea.${versaNote}` };
      return { cause: "Sensor de presión de línea CVT defectuoso", action: `Sin síntomas físicos, verificar presión real vs reportada con escáner. Reemplazar sensor si hay discrepancia.${versaNote}` };
    }
  },

  // ── VERSA — SEGUNDA TANDA ───────────────────────────────────

  P2135: {
    name: "Correlación de sensores del acelerador (TPS A/B)",
    questions: [
      { key: "limp", ask: "1️⃣ ¿El carro entra en *modo de emergencia* (no acelera)? (SI / NO)" },
      { key: "intermittent", ask: "2️⃣ ¿La falla es *intermitente*? (SI / NO)" },
      { key: "cleaned", ask: "3️⃣ ¿Se *limpió o desconectó* el cuerpo de aceleración reciente? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa el P2135 casi siempre es el cuerpo de aceleración electrónico (TPS integrado)." : "";
      if (a.cleaned === "SI")
        return { cause: "Cuerpo de aceleración mal conectado o sin reaprendizaje", action: `Reasentar el conector y hacer reaprendizaje: llave ON sin arrancar 3 seg, apagar, repetir 3 veces, arrancar y ralentí 10 min.${versaNote}` };
      if (a.limp === "SI")
        return { cause: "Falla del TPS dentro del cuerpo de aceleración", action: `Las señales TPS1/TPS2 no coinciden; la ECU corta potencia. Revisar voltajes con escáner. Suele reemplazarse el cuerpo de aceleración completo.${versaNote}` };
      if (a.intermittent === "SI")
        return { cause: "Conector/cableado del TPS intermitente", action: `Revisar arnés y conector por pines flojos o corrosión. Mover el arnés con el motor encendido para ubicar la falla.${versaNote}` };
      return { cause: "Cuerpo de aceleración sucio o desgastado", action: `Limpiar y hacer reaprendizaje. Si vuelve, reemplazar la unidad.${versaNote}` };
    }
  },

  P0335: {
    name: "Sensor de posición del cigüeñal (CKP)",
    questions: [
      { key: "nostart", ask: "1️⃣ ¿El motor *no enciende* o arranca y se apaga? (SI / NO)" },
      { key: "hot", ask: "2️⃣ ¿*Empeora con el motor caliente*? (SI / NO)" },
      { key: "stall", ask: "3️⃣ ¿Se ha *apagado solo* mientras conduce? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa el CKP es causa frecuente de fallas de arranque en caliente." : "";
      if (a.nostart === "SI")
        return { cause: "Sensor CKP defectuoso — sin señal de RPM", action: `Sin señal de cigüeñal no hay inyección ni chispa. Reemplazar CKP ($400–900 MXN).${versaNote}` };
      if (a.hot === "SI")
        return { cause: "CKP que falla por temperatura", action: `Patrón clásico: funciona en frío, falla en caliente. Reemplazar aunque la lectura en frío sea normal.${versaNote}` };
      if (a.stall === "SI")
        return { cause: "Señal intermitente del CKP o cableado", action: `Revisar conector y cableado. Verificar señal con osciloscopio durante la falla.${versaNote}` };
      return { cause: "Fallo de circuito o rueda fónica dañada", action: `Medir resistencia del CKP y revisar la rueda dentada del cigüeñal.${versaNote}` };
    }
  },

  P0011: {
    name: "Sincronización de levas muy adelantada (VVT — Banco 1)",
    questions: [
      { key: "oil", ask: "1️⃣ ¿Último *cambio de aceite*?\n A) Reciente B) +6 meses C) No sé" },
      { key: "rattle", ask: "2️⃣ ¿*Cascabeleo* al arrancar en frío? (SI / NO)" },
      { key: "rough", ask: "3️⃣ ¿El motor se siente *áspero o sin fuerza*? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa el P0011 suele venir de aceite degradado o nivel bajo afectando el VVT." : "";
      if (a.oil === "B" || a.oil === "C")
        return { cause: "Aceite degradado afectando el VVT", action: `Cambiar aceite y filtro con la viscosidad exacta de Nissan. A veces el código desaparece tras el cambio.${versaNote}` };
      if (a.rattle === "SI")
        return { cause: "Solenoide/actuador VVT desgastado", action: `El cascabeleo en frío indica desgaste del actuador. Revisar/reemplazar solenoide VVT (OCV).${versaNote}` };
      if (a.rough === "SI")
        return { cause: "Válvula de control de aceite (OCV) atascada", action: `Limpiar o reemplazar la OCV y su malla filtrante.${versaNote}` };
      return { cause: "VVT fuera de rango — verificar con escáner", action: `Comparar ángulo real vs comandado. Verificar presión de aceite antes de reemplazar.${versaNote}` };
    }
  },

  P0744: {
    name: "Convertidor de par / CVT — circuito intermitente",
    questions: [
      { key: "shudder", ask: "1️⃣ ¿*Temblor* al acelerar a velocidad constante (40–80 km/h)? (SI / NO)" },
      { key: "fluid", ask: "2️⃣ ¿El aceite CVT se *cambió* reciente? (SI / NO)" },
      { key: "slip", ask: "3️⃣ ¿*Sube de RPM pero no acelera igual* (patina)? (SI / NO)" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " ⚠️ CVT de Versa: usar SOLO fluido NS-3." : "";
      if (a.fluid === "NO" && km > 60000)
        return { cause: "Fluido CVT degradado", action: `Con ${km.toLocaleString()} km sin cambio, cambiar fluido CVT con NS-3 y reiniciar contador de degradación con escáner.${versaNote}` };
      if (a.shudder === "SI")
        return { cause: "Embrague del convertidor con desgaste (judder)", action: `Empezar con cambio de fluido NS-3; si persiste, revisión especializada de CVT.${versaNote}` };
      if (a.slip === "SI")
        return { cause: "Patinamiento interno de la CVT", action: `Desgaste interno. Llevar a especialista en CVT antes de que sea mayor. Evitar acelerones.${versaNote}` };
      return { cause: "Falla intermitente del circuito del convertidor", action: `Revisar conector y arnés de la transmisión. Verificar datos de deslizamiento con escáner.${versaNote}` };
    }
  },

  P0443: {
    name: "Circuito de la válvula de purga EVAP",
    questions: [
      { key: "idle", ask: "1️⃣ ¿El motor *falla en ralentí*? (SI / NO)" },
      { key: "smell", ask: "2️⃣ ¿Huele a *gasolina* a veces? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa la válvula de purga es de acceso y costo accesibles." : "";
      if (a.idle === "SI")
        return { cause: "Válvula de purga pegada abierta", action: `Mete vapores al motor y descontrola el ralentí. Probar con multímetro (abre/cierra a 12V) y reemplazar si falla.${versaNote}` };
      if (a.smell === "SI")
        return { cause: "Válvula o manguera de purga con fuga", action: `Revisar válvula y mangueras por grietas. Prueba de humo EVAP si es necesario.${versaNote}` };
      return { cause: "Falla eléctrica del circuito de purga", action: `Revisar conector y continuidad hacia la ECU. Reemplazar válvula si el circuito está bien.${versaNote}` };
    }
  },

  // ── VERSA — TERCERA TANDA (de uso real en grupos) ───────────

  P0123: {
    name: "Circuito alto del sensor de posición del acelerador (TPS A)",
    questions: [
      { key: "cleaned", ask: "1️⃣ ¿Se *lavó/limpió el cuerpo de aceleración* hace poco? (SI / NO)" },
      { key: "limp", ask: "2️⃣ ¿El carro *dejó de acelerar* o entró en modo de emergencia? (SI / NO)" },
      { key: "wet", ask: "3️⃣ ¿Pudo *entrar agua* al conector del sensor al lavar? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa este código aparece muy seguido justo después de lavar el cuerpo de aceleración sin recalibrar." : "";
      if (a.cleaned === "SI")
        return { cause: "Cuerpo de aceleración sin reaprendizaje tras limpieza", action: `Hacer reaprendizaje (gratis): llave ON sin arrancar 3 seg, apagar, repetir 3 veces, arrancar y ralentí 10 min sin tocar acelerador ni A/C. Muchas veces el código se va solo con esto.${versaNote}` };
      if (a.wet === "SI")
        return { cause: "Humedad en el conector del TPS", action: `Desconectar, secar bien y aplicar limpiador de contactos al conector del TPS. Reconectar firme.${versaNote}` };
      if (a.limp === "SI")
        return { cause: "TPS leyendo voltaje alto — falla del sensor", action: `La ECU corta potencia por seguridad. Revisar voltaje del TPS con escáner (debe ser bajo en reposo). Si está alto, reemplazar el cuerpo de aceleración.${versaNote}` };
      return { cause: "Conector o cableado del TPS con falla", action: `Revisar conector por corrosión o pines doblados. Verificar continuidad hacia la ECU.${versaNote}` };
    }
  },

  P2096: {
    name: "Mezcla pobre post-catalizador — Banco 1",
    questions: [
      { key: "symptom", ask: "1️⃣ ¿Tiene *jalones, falta de fuerza o más consumo*? (SI / NO)" },
      { key: "exhaust", ask: "2️⃣ ¿Escucha *ruido de fuga de escape* o huele a gases? (SI / NO)" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      if (a.exhaust === "SI")
        return { cause: "Fuga de escape metiendo aire falso", action: "Una fuga entre el motor y el catalizador mete aire y el O2 trasero lee mezcla pobre. Revisar empaques y soldaduras del escape antes de tocar sensores." };
      if (a.symptom === "SI")
        return { cause: "Inyectores deficientes o baja presión de combustible", action: "Si hay síntomas físicos, medir presión de combustible y considerar limpieza de inyectores en ultrasonido." };
      return { cause: "Sensor O2 trasero degradado (lo más probable)", action: `Sin síntomas físicos, el O2 trasero suele estar viejo y leer mal. Con ${km.toLocaleString()} km es candidato a reemplazo ($400–800 MXN) antes que el catalizador.` };
    }
  },

  P0705: {
    name: "Sensor de rango de transmisión (inhibidor / PNP)",
    questions: [
      { key: "start", ask: "1️⃣ ¿A veces *no arranca* en P o N, o arranca en posiciones raras? (SI / NO)" },
      { key: "swap", ask: "2️⃣ ¿Le hicieron *swap de transmisión* (CVT a automática o viceversa)? (SI / NO)" },
      { key: "speedo", ask: "3️⃣ ¿El *velocímetro o los testigos* se comportan raro? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa CVT este sensor está integrado en la transmisión." : "";
      if (a.swap === "SI")
        return { cause: "Incompatibilidad ECU/transmisión tras swap", action: "Si cambiaron el tipo de transmisión, la ECU sigue esperando la original. Requiere reprogramar o cambiar la ECU por una compatible con la transmisión instalada, y verificar que el arnés sea el correcto." };
      if (a.start === "SI")
        return { cause: "Switch inhibidor / sensor de rango desajustado o sucio", action: `El sensor no registra bien la posición de la palanca. Primero limpiar el conector y revisar ajuste. Si persiste, reemplazar el sensor.${versaNote}` };
      if (a.speedo === "SI")
        return { cause: "Señal de rango errática hacia el tablero/ECU", action: `Revisar conector del sensor de rango y continuidad. Una señal sucia afecta velocímetro y testigos.${versaNote}` };
      return { cause: "Sensor de rango defectuoso", action: `Revisar conector primero (corrosión/pines). Si está bien, reemplazar sensor ($600–1,500 MXN genérico).${versaNote}` };
    }
  },

  P0850: {
    name: "Circuito del switch Park/Neutral (PNP)",
    questions: [
      { key: "start", ask: "1️⃣ ¿Tiene problemas para *arrancar en Park o Neutral*? (SI / NO)" },
      { key: "shift", ask: "2️⃣ ¿La transmisión *no cambia suave* o se siente rara? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa CVT el PNP está integrado en la transmisión." : "";
      if (a.start === "SI")
        return { cause: "Switch Park/Neutral sucio o desajustado", action: `El switch no confirma que estás en P/N y la ECU bloquea el arranque por seguridad. Limpiar conector y revisar ajuste antes de reemplazar.${versaNote}` };
      if (a.shift === "SI")
        return { cause: "Señal PNP incorrecta afectando los cambios", action: `La ECU no sabe la posición real de la palanca. Verificar la señal del switch con escáner en cada posición.${versaNote}` };
      return { cause: "Falla eléctrica del circuito PNP", action: `Revisar conector y cableado del switch. Reemplazar si el circuito está bien pero el código persiste ($600–1,200 MXN).${versaNote}` };
    }
  }

};

// ── MISFIRES POR CILINDRO (P0301–P0304) generados de plantilla ──
[1, 2, 3, 4].forEach((cyl) => {
  diagnostics["P030" + cyl] = {
    name: `Falla de encendido en cilindro ${cyl}`,
    questions: [
      { key: "idle", ask: "1️⃣ ¿El motor *vibra en ralentí*? (SI / NO)" },
      { key: "plugs", ask: "2️⃣ ¿Último cambio de *bujías*?\n A) Reciente B) +1 año C) No sé" },
      { key: "accel", ask: "3️⃣ ¿*Falla o titubea al acelerar*? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const swap = isVersa ? ` Truco gratis: intercambia la bobina del cilindro ${cyl} con otra y borra el código — si la falla se mueve de cilindro, es la bobina.` : "";
      if (a.plugs === "B" || a.plugs === "C")
        return { cause: `Bujía o bobina del cilindro ${cyl}`, action: `Empezar por la bujía del cilindro ${cyl} (compárala con las demás). Bujía NGK/Denso $80–150 MXN.${swap}` };
      if (a.accel === "SI")
        return { cause: `Inyector del cilindro ${cyl} sucio o deficiente`, action: `Si bujía y bobina están bien, limpiar inyectores en ultrasonido ($300–500 MXN) antes de reemplazar.${swap}` };
      if (a.idle === "SI")
        return { cause: `Bobina del cilindro ${cyl}`, action: `Probar la bobina del cilindro ${cyl}.${swap}` };
      return { cause: `Falla intermitente en cilindro ${cyl}`, action: `Si bujía, bobina e inyector están bien, hacer prueba de compresión del cilindro ${cyl} para descartar desgaste interno.` };
    }
  };
});

const AVAILABLE_CODES = Object.keys(diagnostics);

// ─────────────────────────────────────────────────────────────
// 🔹 SYMPTOM HINTS (LIGHTWEIGHT — no es motor de diagnóstico)
// ─────────────────────────────────────────────────────────────
const SYMPTOM_HINTS = [
  { tag: "rpm_cap", kw: ["no pasa de 2000", "no pasa de las 2000", "no revoluciona", "se queda en 2000", "no sube de rpm"],
    hint: "Cuando un carro no pasa de cierto RPM y el escáner no marca nada, lo más común es el MAF sucio, el TPS, o falta de reaprendizaje del cuerpo de aceleración." },
  { tag: "turn_signal_jerk", kw: ["direccionales", "intermitentes"],
    hint: "Si el carro se jalonea al prender las direccionales, casi siempre es el alternador (diodo malo) o una tierra deficiente. Mide el voltaje de batería con el motor encendido: debe estar 13.8–14.5V estable." },
  { tag: "cooling_fan", kw: ["ventilador", "abanico"],
    hint: "Si el ventilador del radiador se queda encendido con el carro apagado, lo más común es el relé del ventilador pegado o el sensor de temperatura (ECT)." },
  { tag: "cruise", kw: ["crucero", "velocidad crucero"],
    hint: "Si el crucero prende pero no mantiene la velocidad, casi siempre es el switch del pedal de freno mal ajustado." },
  { tag: "rear_camera", kw: ["camara de reversa", "cámara de reversa"],
    hint: "Si la cámara prende pero no da imagen, casi siempre es el cable de video (RCA) suelto o la configuración de la pantalla, no la cámara." },
  { tag: "door_locks", kw: ["seguros", "candados"],
    hint: "Si los seguros se ponen y quitan solos, lo más común es el actuador de la puerta del conductor o el arnés de la bisagra con un cable roto." },
  { tag: "no_drive", kw: ["no agarra la d", "no entra en drive", "no agarra d"],
    hint: "Si la transmisión automática no agarra la D al primer intento, revisa primero nivel y color del aceite de transmisión, y el switch inhibidor (PNP)." }
];

function detectSymptom(text) {
  const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const s of SYMPTOM_HINTS) {
    if (s.kw.some(k => t.includes(k.normalize("NFD").replace(/[\u0300-\u036f]/g, "")))) return s;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 🔹 INPUT PARSER (pipes, espacios, natural, solo código)
// ─────────────────────────────────────────────────────────────
const KNOWN_MAKES = {
  NISSAN: "Nissan", CHEVROLET: "Chevrolet", CHEVY: "Chevrolet",
  VOLKSWAGEN: "Volkswagen", VW: "Volkswagen", TOYOTA: "Toyota",
  HONDA: "Honda", FORD: "Ford", MAZDA: "Mazda", KIA: "Kia",
  HYUNDAI: "Hyundai", SEAT: "Seat", RENAULT: "Renault", DODGE: "Dodge"
};
const KNOWN_MODELS = {
  VERSA: "Versa", TSURU: "Tsuru", SENTRA: "Sentra", MARCH: "March",
  AVEO: "Aveo", JETTA: "Jetta", TIIDA: "Tiida", TIDA: "Tiida",
  NP300: "NP300", SPARK: "Spark", GOL: "Gol", VENTO: "Vento", FIGO: "Figo",
  FRONTIER: "Frontier", KICKS: "Kicks", ALTIMA: "Altima", XTRAIL: "X-Trail"
};

function parseInput(text) {
  const code = text.toUpperCase().match(/P[0-9]{4}/)?.[0];
  if (!code) return null;

  if (text.includes("|")) {
    const parts = text.split("|").map(x => x.trim());
    const [make = "", model = "", year = "", , mileageRaw = "0"] = parts;
    return {
      code,
      vehicle: {
        make, model,
        year: (year.match(/\d{4}/) || [""])[0],
        mileage: (mileageRaw.replace(/[^0-9]/g, "") || "0")
      }
    };
  }

  const cleaned = text.replace(/P[0-9]{4}/i, " ");
  const upper = cleaned.toUpperCase();

  let make = "";
  for (const key in KNOWN_MAKES) { if (upper.includes(key)) { make = KNOWN_MAKES[key]; break; } }
  let model = "";
  for (const key in KNOWN_MODELS) { if (upper.includes(key)) { model = KNOWN_MODELS[key]; break; } }

  const year = (cleaned.match(/\b(199\d|20[0-2]\d)\b/) || [""])[0];
  const nums = (cleaned.match(/\d[\d,]{2,}/g) || [])
    .map(n => n.replace(/[^0-9]/g, "")).filter(n => n && n !== year);
  const mileage = nums.length
    ? nums.sort((a, b) => b.length - a.length || Number(b) - Number(a))[0]
    : "0";

  return { code, vehicle: { make, model, year, mileage } };
}

function normalizeAnswer(text) {
  let t = (text || "").toUpperCase().trim();
  t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (["SI", "S", "YES", "CLARO", "SIMON", "SIP", "AJA", "AFIRMATIVO"].includes(t)) return "SI";
  if (["NO", "N", "NEL", "NOP", "NUNCA", "NEGATIVO"].includes(t)) return "NO";
  return t;
}

// ─────────────────────────────────────────────────────────────
// 🔹 HELPERS DE LECTURA (para /stats y /logs)
// ─────────────────────────────────────────────────────────────
function readJsonl(p) {
  try {
    return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────
// 🔹 HEALTH CHECK + STATS + LOGS
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.status(200).send("Aivora Engine: Online ✅"));

// /stats?token=VERIFY_TOKEN → tablero de decisión completo
app.get("/stats", (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.sendStatus(403);

  const interactions = readJsonl(INTERACTIONS_PATH);
  const events       = readJsonl(EVENTS_PATH);
  const resolved     = readJsonl(LOG_PATH);
  const missed       = readJsonl(MISS_PATH);
  const symptoms     = readJsonl(SYMPTOM_PATH);
  const interest     = readJsonl(INTEREST_PATH);

  // Usuarios únicos y returning (2+ días distintos) — LA métrica del sprint
  const byUser = {};
  interactions.forEach(i => {
    const day = (i.ts || "").slice(0, 10);
    (byUser[i.from] = byUser[i.from] || new Set()).add(day);
  });
  const uniqueUsers = Object.keys(byUser).length;
  const returning = Object.values(byUser).filter(days => days.size >= 2).length;

  // Actividad por día (para ver tendencia, no solo acumulado)
  const daily = {};
  interactions.forEach(i => {
    const day = (i.ts || "").slice(0, 10);
    daily[day] = (daily[day] || 0) + 1;
  });

  // Funnel: iniciados → resultado entregado → fix confirmado
  const starts  = events.filter(e => e.event === "diag_start");
  const results = events.filter(e => e.event === "diag_result");

  // Top códigos pedidos (de los que sí tenemos)
  const codeCounts = {};
  starts.forEach(e => { if (e.code) codeCounts[e.code] = (codeCounts[e.code] || 0) + 1; });

  // Top códigos que NO tenemos (backlog data-driven)
  const missedCounts = {};
  missed.forEach(m => { if (m.code) missedCounts[m.code] = (missedCounts[m.code] || 0) + 1; });

  res.json({
    window: {
      server_started: SERVER_STARTED,
      first_interaction: interactions[0]?.ts || null,
      last_interaction: interactions[interactions.length - 1]?.ts || null
    },
    persistence: {
      persistent: IS_PERSISTENT,
      data_dir: DATA_DIR,
      note: IS_PERSISTENT
        ? "✅ Volumen persistente activo: los datos sobreviven redeploys."
        : "⚠️ FS efímero: configura un Volume en Railway + variable DATA_DIR."
    },
    usage: {
      total_messages: interactions.length,
      unique_users: uniqueUsers,
      returning_users: returning,
      daily_messages: daily
    },
    funnel: {
      diagnostics_started: starts.length,
      results_delivered: results.length,
      fixes_confirmed: resolved.length,
      drop_before_result: Math.max(starts.length - results.length, 0)
    },
    demand: {
      top_codes_requested: codeCounts,
      missed_codes_total: missed.length,
      top_missed_codes: missedCounts,
      symptom_messages: symptoms.length
    },
    monetization: {
      offer_enabled: OFFER_ENABLED,
      offer_price: OFFER_PRICE,
      offers_shown: events.filter(e => e.event === "offer_shown").length,
      info_requests: interest.filter(i => i.level === "info").length,
      hot_leads: interest.filter(i => i.level === "hot").length
    },
    codes_live: AVAILABLE_CODES.length
  });
});

// /logs?token=...&file=missed|symptoms|resolved|interactions|events|interest&limit=100
// → lee los .jsonl directo desde el navegador, sin entrar a Railway
const LOG_FILES = {
  missed: MISS_PATH,
  symptoms: SYMPTOM_PATH,
  resolved: LOG_PATH,
  interactions: INTERACTIONS_PATH,
  events: EVENTS_PATH,
  interest: INTEREST_PATH
};
app.get("/logs", (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.sendStatus(403);
  const file = LOG_FILES[req.query.file];
  if (!file) return res.status(400).json({ error: "file debe ser: " + Object.keys(LOG_FILES).join(", ") });
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const lines = readJsonl(file);
  res.json({ file: req.query.file, total: lines.length, showing: Math.min(limit, lines.length), entries: lines.slice(-limit) });
});

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
  if (!message) return; // status updates → ignore
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

    logInteraction(from, text);

    // Sesión abandonada hace 6+ horas → empezar limpio (conserva el vehículo)
    let state = userState[from] || {};
    if (state.lastTs && Date.now() - state.lastTs > SESSION_TTL_MS) {
      state = { vehicle: state.vehicle };
      userState[from] = state;
    }
    state.lastTs = Date.now();
    userState[from] = state;

    if (["RESET", "REINICIAR", "NUEVO", "MENU"].some(c => upper.includes(c))) {
      delete userState[from];
      return safeSend(from, welcomeMessage());
    }

    // 💰 Smoke test: leads siempre alcanzables, en cualquier punto del flujo
    if (OFFER_ENABLED && upper.includes("ME INTERESA")) {
      logInterest(from, "hot", text);
      logEvent(from, "hot_lead");
      return safeSend(from, OFFER_CONFIRMED);
    }
    if (OFFER_ENABLED && upper === "INFO") {
      logInterest(from, "info", text);
      logEvent(from, "offer_shown", { variant: "full" });
      return safeSend(from, OFFER_FULL);
    }

    // Un código nuevo SIEMPRE arranca diagnóstico nuevo, aunque estuviera
    // a medio flujo (antes se quedaban atorados si abandonaban preguntas)
    const parsed = parseInput(text);
    if (parsed) {
      const hasNewVehicle = parsed.vehicle.make || parsed.vehicle.model || parsed.vehicle.year;
      const vehicle = hasNewVehicle ? parsed.vehicle : (state.vehicle || parsed.vehicle);
      return startDiagnostic(from, parsed.code, vehicle, text);
    }

    if (state.stage === "awaiting_feedback") return handleFeedback(from, upper, state);
    if (state.stage === "awaiting_fix_description") return handleFixDescription(from, text, state);
    if (state.stage === "questioning") return handleAnswer(from, upper, state);

    // ¿Describe un síntoma conocido sin código?
    const symptom = detectSymptom(text);
    if (symptom) {
      logSymptom(from, symptom.tag, text);
      return safeSend(from,
        `🔧 Por lo que describes:\n\n${symptom.hint}\n\n` +
        `Para un diagnóstico exacto necesito el *código de falla*. Escanéalo gratis en AutoZone y mándamelo (ej: P0420) junto con marca, modelo y año.\n\n` +
        `_Ej: Nissan Versa 2016 P0420 90000_`
      );
    }

    // Nada reconocible → bienvenida
    return safeSend(from, welcomeMessage());

  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

function welcomeMessage() {
  return (
    `👋 Bienvenido a *Aivora Diagnostics* 🔧\n\n` +
    `Mándame la falla de tu carro así de fácil:\n\n` +
    `*Marca Modelo Año Código Kilometraje*\n` +
    `_Ej: Nissan Versa 2016 P0300 84000_\n\n` +
    `O si solo tienes el código, mándalo solito:\n` +
    `_Ej: P0300_\n\n` +
    `Escribe *MENU* en cualquier momento para reiniciar.`
  );
}

// ─────────────────────────────────────────────────────────────
// 🔹 START DIAGNOSTIC
// ─────────────────────────────────────────────────────────────
async function startDiagnostic(from, code, vehicle, rawText) {
  const diag = diagnostics[code];

  if (!diag) {
    logMissedCode(from, code, rawText);
    return safeSend(from,
      `⚠️ El código *${code}* todavía no está en mi base.\n\n` +
      `Ya lo registré para agregarlo pronto 🙌\n\n` +
      `Tengo ${AVAILABLE_CODES.length} códigos de Versa listos. Manda uno como P0300, P0420, P0744, P2135, P0705 o P0302 para un diagnóstico al instante.`
    );
  }

  userState[from] = { stage: "questioning", code, vehicle, step: 0, answers: {}, lastTs: Date.now() };
  logEvent(from, "diag_start", { code });

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

  state.answers[current.key] = normalizeAnswer(upper);
  state.step++;

  if (state.step < diag.questions.length) {
    return safeSend(from, diag.questions[state.step].ask);
  }

  const result = diag.logic(state.answers, state.vehicle);
  const v = state.vehicle;
  const hasV = v.make && v.make.length > 0;

  state.lastResult = result;
  state.stage = "awaiting_feedback";
  logEvent(from, "diag_result", { code: state.code });
  if (OFFER_ENABLED) logEvent(from, "offer_shown", { variant: "footer" });

  return safeSend(from,
    `🧠 *Diagnóstico Aivora*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    (hasV ? `🚗 ${v.year} ${v.make} ${v.model}${v.mileage > 0 ? ` · ${Number(v.mileage).toLocaleString()} km` : ""}\n` : "") +
    `🔎 ${state.code}\n\n` +
    `*Causa probable:*\n${result.cause}\n\n` +
    `*Acción recomendada:*\n${result.action}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `¿Esto resolvió el problema?\n\n` +
    `✅ *FIXED* — Sí, resuelto\n` +
    `❌ *NO* — Sigue fallando` +
    (OFFER_ENABLED ? OFFER_FOOTER : "")
  );
}

// ─────────────────────────────────────────────────────────────
// 🔹 HANDLE FEEDBACK
// ─────────────────────────────────────────────────────────────
async function handleFeedback(from, upper, state) {
  const norm = normalizeAnswer(upper);
  const resolved = upper.includes("FIXED") || upper.includes("LISTO") || norm === "SI";

  if (resolved) {
    state.stage = "awaiting_fix_description";
    return safeSend(from,
      `✅ *¡Excelente!* 🚗💨\n\n` +
      `Una última cosa — ¿cuál fue la reparación final?\n` +
      `_(Ej: "Cambié las bujías y la bobina del cilindro 3")_\n\n` +
      `Esto hace a Aivora más preciso para todos. 🙏`
    );
  }

  state.stage = "escalated";
  return safeSend(from,
    `⚠️ *Diagnóstico no resuelto — Profundizando*\n\n` +
    `El código *${state.code}* puede tener una causa más profunda.\n\n` +
    `Pasos adicionales:\n` +
    `• Escanear datos en vivo: RPM, TPS, MAF, O2\n` +
    `• Verificar tierra del motor y voltaje de batería en ralentí\n` +
    `• Revisar boletines de servicio (TSB) del modelo\n` +
    `• Si persiste, inspección física especializada\n\n` +
    `Manda un nuevo código o escribe *MENU* para empezar de nuevo.`
  );
}

// ─────────────────────────────────────────────────────────────
// 🔹 HANDLE FIX DESCRIPTION — THE LEARNING LOOP 🎯
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
  if (OFFER_ENABLED) logEvent(from, "offer_shown", { variant: "post_fix" });

  return safeSend(from,
    `✅ *¡Registrado, gracias!*\n\n` +
    `Cada caso confirmado hace a Aivora más preciso. 🧠\n\n` +
    `Manda un nuevo código cuando lo necesites. ¡Éxito! 🔧` +
    (OFFER_ENABLED
      ? `\n\n━━━━━━━━━━━━━━━━━━\n` +
        `🚀 Por cierto: estamos armando *Aivora Pro* — 10 diagnósticos prioritarios con seguimiento personal por ${OFFER_PRICE} (lanzamiento).\n\n` +
        `Manda *INFO* si quieres los detalles. Aivora normal sigue gratis. 😉`
      : "")
  );
}

// ─────────────────────────────────────────────────────────────
// 🔹 SEND HELPER
// ─────────────────────────────────────────────────────────────
async function safeSend(to, body) {
  if (to.startsWith("52") && to.length === 12) {
    to = "521" + to.slice(2);
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
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
app.listen(PORT, () => console.log(
  `🚀 Aivora V1 active on port ${PORT} — ${AVAILABLE_CODES.length} códigos activos — ` +
  `data: ${DATA_DIR} (${IS_PERSISTENT ? "PERSISTENTE ✅" : "efímero ⚠️"}) — ` +
  `offer: ${OFFER_ENABLED ? "ON" : "OFF"}`
));