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
// NOTE: Railway's filesystem is ephemeral — this resets on redeploy.
// For permanent storage, move to a DB or external store in Phase 2.
// ─────────────────────────────────────────────────────────────
const LOG_PATH = path.join(__dirname, "resolved_cases.jsonl");

function logResolvedCase(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() });
  fs.appendFileSync(LOG_PATH, line + "\n");
}

// Log every unrecognized code so you see what users ACTUALLY ask for.
const MISS_PATH = path.join(__dirname, "missed_codes.jsonl");
function logMissedCode(from, code, rawText) {
  const line = JSON.stringify({ from, code, rawText, ts: new Date().toISOString() });
  fs.appendFileSync(MISS_PATH, line + "\n");
}

// ─────────────────────────────────────────────────────────────
// 🗃️ SESSION STORE  (in-memory for V1; swap for Redis in Phase 2)
// ─────────────────────────────────────────────────────────────
const userState = {};

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

  // ── NISSAN VERSA — PRIMERA TANDA ────────────────────────────

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
        return { cause: "Cuerpo de aceleración desadaptado tras limpieza", action: `Realizar reaprendizaje del cuerpo de aceleración (Throttle Body Relearn): apagar y encender llave sin arrancar, esperar 3 seg, arrancar y dejar en ralentí 10 min sin tocar el acelerador.${versaNote}` };
      if (a.ac === "SI" && a.rough === "NO")
        return { cause: "Compensación normal del sistema IAC por carga del A/C", action: "Verificar que las RPM bajen al mínimo esperado (650–750 RPM) con A/C apagado. Si permanecen altas, limpiar cuerpo de aceleración con spray especializado." };
      if (a.rough === "SI")
        return { cause: "Válvula IAC sucia o sensor TPS descalibrado", action: `Limpiar válvula de control de aire en ralentí (IAC). Verificar lectura de TPS con escáner: debe ser 0.5V en reposo. Si falla, reemplazar TPS.${versaNote}` };
      return { cause: "Fuga de aire no controlada en admisión", action: `Inspeccionar mangueras del múltiple de admisión y empaques. Una fuga mínima puede elevar RPM sin encender otros códigos.${versaNote}` };
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
      const versaNote = isVersa ? " En la Nissan Versa, el sensor CMP está en la parte trasera del motor — revisar conector antes de reemplazar." : "";
      if (a.recent === "SI")
        return { cause: "Sensor CMP desconectado o mal posicionado tras intervención", action: `Verificar conector del sensor de árbol de levas (CMP) y que el reluctor esté bien alineado.${versaNote} Un error de instalación genera este código sin que el sensor esté dañado.` };
      if (a.start === "SI" && a.stall === "SI")
        return { cause: "Sensor CMP defectuoso — falla crítica", action: `El sensor de árbol de levas no envía señal a la ECU. Puede dejar el vehículo varado.${versaNote} Reemplazar sensor CMP. Costo estimado en LATAM: $300–$600 MXN genérico.` };
      if (a.stall === "SI")
        return { cause: "Señal intermitente del CMP — posible fallo de cableado", action: `Revisar continuidad del cableado con multímetro. Un cable roto internamente causa señal intermitente sin daño visible.${versaNote}` };
      return { cause: "Posible fallo del circuito o interferencia eléctrica", action: `Medir resistencia del sensor CMP (especificación Nissan: 200–900 Ohms en frío). Si está fuera de rango, reemplazar.${versaNote}` };
    }
  },

  P0101: {
    name: "Sensor MAF — Rango o desempeño fuera de especificación",
    questions: [
      { key: "filter", ask: "1️⃣ ¿El *filtro de aire* fue cambiado recientemente o está sucio? (SI / NO)" },
      { key: "power", ask: "2️⃣ ¿Nota *falta de potencia* o aceleración lenta? (SI / NO)" },
      { key: "idle", ask: "3️⃣ ¿El motor falla o fluctúa en *ralentí*? (SI / NO)" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa, el MAF es sensible al aceite de filtros reutilizables — un filtro de algodón (tipo K&N) puede contaminarlo." : "";
      if (a.filter === "SI")
        return { cause: "Filtro de aire contaminando el sensor MAF", action: `Limpiar el MAF con spray especializado (no usar limpiador multiusos). Dejar secar 30 min antes de arrancar.${versaNote}` };
      if (a.power === "SI" && a.idle === "SI")
        return { cause: "Sensor MAF degradado — lectura g/s incorrecta", action: `Con ${km.toLocaleString()} km, el MAF puede estar al final de su vida. En escáner, a ralentí debe leer 2–7 g/s en la Versa. Fuera de rango, reemplazar.` };
      if (a.power === "SI" && a.idle === "NO")
        return { cause: "MAF leyendo bajo bajo carga — obstrucción parcial", action: "Limpiar conducto de admisión completo y el MAF. Verificar que no haya cuerpos extraños antes del sensor." };
      return { cause: "Falla intermitente del MAF o conexión débil", action: `Revisar conector del MAF — los pines se oxidan en clima húmedo. Limpiar con limpiador de contactos eléctricos.${versaNote}` };
    }
  },

  P0605: {
    name: "Error interno de la ECU — ROM",
    questions: [
      { key: "multiple", ask: "1️⃣ ¿Aparecen *múltiples códigos al mismo tiempo* además del P0605? (SI / NO)" },
      { key: "battery", ask: "2️⃣ ¿La batería fue desconectada o hubo *corto eléctrico* recientemente? (SI / NO)" },
      { key: "start", ask: "3️⃣ ¿El vehículo *enciende y funciona* a pesar del código? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa, antes de reemplazar la ECU verifica que el software sea compatible con tu año exacto de modelo." : "";
      if (a.battery === "SI" && a.multiple === "SI")
        return { cause: "Corrupción temporal de memoria tras evento eléctrico", action: "Desconectar batería 15 min, reconectar y borrar códigos. Si el P0605 reaparece solo, la ECU tiene daño permanente. Si reaparecen otros, investigar esos primero." };
      if (a.start === "SI" && a.multiple === "NO")
        return { cause: "Error de checksum en ECU — puede ser transitorio", action: `Borrar el código y monitorear. Si regresa en menos de 50 km sin causa aparente, la ECU requiere reprogramación o reemplazo.${versaNote} Buscar ECU remanufacturada antes de comprar nueva.` };
      if (a.start === "NO")
        return { cause: "Fallo crítico de ECU — vehículo inoperable", action: `Requiere diagnóstico eléctrico presencial urgente. Verificar voltaje de alimentación a la ECU (12V estables) y tierras del motor antes de concluir que la ECU está dañada.${versaNote}` };
      return { cause: "ECU con posible daño interno por humedad o sobretensión", action: `Inspeccionar físicamente la ECU buscando humedad, quemaduras o corrosión en el conector. Una ECU dañada por agua falla intermitentemente.${versaNote}` };
    }
  },

  P0868: {
    name: "Presión de línea de transmisión CVT baja",
    questions: [
      { key: "slip", ask: "1️⃣ ¿El motor *acelera pero el carro no avanza* al mismo ritmo (patina)? (SI / NO)" },
      { key: "fluid", ask: "2️⃣ ¿El aceite de transmisión fue *revisado o cambiado* recientemente? (SI / NO)" },
      { key: "shudder", ask: "3️⃣ ¿Siente *vibración o temblor* al acelerar entre 40–80 km/h? (SI / NO)" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " ⚠️ La CVT de la Versa es conocida por fallas prematuras. Nissan extendió garantía en algunos mercados — verifica si tu VIN aplica en nissan.com.mx." : "";
      if (a.fluid === "NO" && km > 60000)
        return { cause: "Aceite CVT degradado — baja presión hidráulica", action: `Con ${km.toLocaleString()} km sin cambio de fluido CVT, la viscosidad baja genera pérdida de presión. Cambiar usando *exclusivamente NS-3 o NS-2* para Nissan CVT. Fluidos incorrectos dañan la transmisión.${versaNote}` };
      if (a.slip === "SI" && a.shudder === "SI")
        return { cause: "Falla interna de la CVT — banda o polea dañada", action: `Los síntomas indican daño mecánico interno. Llevar a revisión especializada en CVT antes de que el daño sea total.${versaNote} Evitar uso prolongado en este estado.` };
      if (a.slip === "SI" && a.shudder === "NO")
        return { cause: "Válvula de control de presión CVT sucia o defectuosa", action: `Cambiar fluido CVT y limpiar filtro interno si es accesible. La válvula puede responder a fluido limpio. Si el patinamiento persiste, revisar sensor de presión de línea.${versaNote}` };
      return { cause: "Sensor de presión de línea CVT defectuoso", action: `Si no hay síntomas físicos claros, el sensor puede reportar baja presión falsamente. Verificar con escáner la presión real vs reportada. Reemplazar sensor si hay discrepancia.${versaNote}` };
    }
  },

  // ── NISSAN VERSA — SEGUNDA TANDA (de uso real) ──────────────

  P2135: {
    name: "Correlación de sensores de posición del acelerador (TPS A/B)",
    questions: [
      { key: "limp", ask: "1️⃣ ¿El carro entra en *modo de emergencia* (no acelera o se queda en bajas RPM)? (SI / NO)" },
      { key: "intermittent", ask: "2️⃣ ¿La falla es *intermitente* (aparece y desaparece)? (SI / NO)" },
      { key: "cleaned", ask: "3️⃣ ¿El cuerpo de aceleración fue *limpiado o desconectado* recientemente? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa, el P2135 es de los códigos más comunes y casi siempre apunta al cuerpo de aceleración electrónico (TPS integrado)." : "";
      if (a.cleaned === "SI")
        return { cause: "Cuerpo de aceleración mal conectado o sin reaprendizaje", action: `Verificar que el conector del cuerpo de aceleración esté bien asentado. Luego reaprendizaje (Throttle Body Relearn): llave en ON sin arrancar 3 seg, apagar, repetir 3 veces, arrancar y dejar en ralentí 10 min.${versaNote}` };
      if (a.limp === "SI")
        return { cause: "Falla del sensor TPS dentro del cuerpo de aceleración", action: `Las dos señales del TPS no coinciden y la ECU activa modo de emergencia. Revisar voltajes de TPS1 y TPS2 con escáner. Lo más común es reemplazar el cuerpo de aceleración completo.${versaNote}` };
      if (a.intermittent === "SI")
        return { cause: "Conector o cableado del TPS con falla intermitente", action: `Inspeccionar arnés y conector del cuerpo de aceleración buscando pines flojos, corrosión o cable roto. Mover el arnés con el motor encendido para ubicar la falla.${versaNote}` };
      return { cause: "Cuerpo de aceleración sucio o desgastado", action: `Limpiar el cuerpo de aceleración con spray especializado y hacer el reaprendizaje. Si el código regresa, reemplazar la unidad.${versaNote}` };
    }
  },

  P0335: {
    name: "Circuito del sensor de posición del cigüeñal (CKP)",
    questions: [
      { key: "nostart", ask: "1️⃣ ¿El motor *no enciende* o arranca y se apaga? (SI / NO)" },
      { key: "hot", ask: "2️⃣ ¿La falla *empeora con el motor caliente*? (SI / NO)" },
      { key: "stall", ask: "3️⃣ ¿Se ha *apagado solo* mientras conduce? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa, el sensor CKP es causa frecuente de fallas de arranque, sobre todo en caliente." : "";
      if (a.nostart === "SI")
        return { cause: "Sensor CKP defectuoso — sin señal de RPM", action: `Sin señal del cigüeñal, la ECU no inyecta combustible ni genera chispa. Reemplazar el sensor CKP. Costo aprox. en LATAM: $400–$900 MXN.${versaNote}` };
      if (a.hot === "SI")
        return { cause: "Sensor CKP que falla por temperatura", action: `Un CKP que falla solo en caliente es patrón clásico de sensor degradado. Reemplazar aunque la lectura en frío sea normal.${versaNote}` };
      if (a.stall === "SI")
        return { cause: "Señal intermitente del CKP o cableado", action: `Revisar conector y cableado del CKP. Verificar la señal con osciloscopio mientras ocurre la falla.${versaNote}` };
      return { cause: "Posible falla de circuito o rueda fónica dañada", action: `Medir resistencia del sensor CKP y revisar la rueda dentada (reluctor) del cigüeñal por dientes dañados.${versaNote}` };
    }
  },

  P0011: {
    name: "Sincronización del árbol de levas muy adelantada (VVT — Banco 1)",
    questions: [
      { key: "oil", ask: "1️⃣ ¿Cuándo fue el último *cambio de aceite*?\n A) Reciente B) Hace más de 6 meses C) No sé" },
      { key: "rattle", ask: "2️⃣ ¿Escucha un *cascabeleo o ruido metálico* al arrancar en frío? (SI / NO)" },
      { key: "rough", ask: "3️⃣ ¿El motor se siente *áspero o sin fuerza*? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa, el P0011 suele relacionarse con aceite degradado o nivel bajo que afecta el actuador VVT." : "";
      if (a.oil === "B" || a.oil === "C")
        return { cause: "Aceite degradado afectando el sistema VVT", action: `El VVT depende de aceite limpio a presión correcta. Cambiar aceite y filtro con la viscosidad exacta que pide Nissan. Muchas veces el código desaparece tras el cambio.${versaNote}` };
      if (a.rattle === "SI")
        return { cause: "Solenoide o actuador VVT desgastado", action: `El cascabeleo en frío indica desgaste del actuador del árbol de levas. Revisar y posiblemente reemplazar el solenoide de control VVT (OCV).${versaNote}` };
      if (a.rough === "SI")
        return { cause: "Válvula de control de aceite (OCV) atascada", action: `La válvula que controla el VVT puede estar atascada por suciedad. Limpiar o reemplazar la OCV y revisar su malla filtrante.${versaNote}` };
      return { cause: "Sistema VVT fuera de rango — verificar con escáner", action: `Comparar con escáner el ángulo real vs comandado del árbol de levas. Verificar presión de aceite antes de reemplazar componentes.${versaNote}` };
    }
  },

  P0744: {
    name: "Convertidor de par / transmisión CVT — circuito intermitente",
    questions: [
      { key: "shudder", ask: "1️⃣ ¿Siente *vibración o temblor* al acelerar a velocidad constante (40–80 km/h)? (SI / NO)" },
      { key: "fluid", ask: "2️⃣ ¿El aceite de la transmisión CVT fue *cambiado* recientemente? (SI / NO)" },
      { key: "slip", ask: "3️⃣ ¿El motor *sube de RPM pero el carro no acelera igual* (patina)? (SI / NO)" }
    ],
    logic: (a, v) => {
      const km = parseInt(v.mileage) || 0;
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " ⚠️ La CVT de la Versa es delicada — usar SOLO fluido Nissan NS-3. Un fluido incorrecto la daña." : "";
      if (a.fluid === "NO" && km > 60000)
        return { cause: "Fluido CVT degradado", action: `Con ${km.toLocaleString()} km sin cambio, el fluido pierde propiedades y dispara este código. Cambiar fluido CVT con NS-3 y reiniciar el contador de degradación con escáner.${versaNote}` };
      if (a.shudder === "SI")
        return { cause: "Convertidor de par / embrague de bloqueo con desgaste (judder)", action: `El temblor a velocidad constante es típico de la CVT Nissan. Empezar con cambio de fluido NS-3; si persiste, requiere revisión especializada de la CVT.${versaNote}` };
      if (a.slip === "SI")
        return { cause: "Patinamiento interno de la CVT", action: `El patinamiento indica desgaste interno. Llevar a un especialista en CVT antes de que el daño sea mayor. Evitar acelerones fuertes mientras tanto.${versaNote}` };
      return { cause: "Falla intermitente del circuito del convertidor", action: `Revisar conector y arnés de la transmisión. Verificar con escáner los datos de deslizamiento del convertidor.${versaNote}` };
    }
  },

  P0443: {
    name: "Circuito de la válvula de purga del sistema EVAP",
    questions: [
      { key: "idle", ask: "1️⃣ ¿El motor *falla o se siente irregular* en ralentí? (SI / NO)" },
      { key: "smell", ask: "2️⃣ ¿Huele a *gasolina* en ocasiones? (SI / NO)" }
    ],
    logic: (a, v) => {
      const isVersa = v.model?.toUpperCase().includes("VERSA");
      const versaNote = isVersa ? " En la Versa, la válvula de purga (canister purge valve) es de fácil acceso y reemplazo económico." : "";
      if (a.idle === "SI")
        return { cause: "Válvula de purga pegada en posición abierta", action: `Una válvula de purga abierta mete vapores de gasolina al motor y descontrola el ralentí. Probar con multímetro (debe abrir/cerrar al aplicar 12V) y reemplazar si falla.${versaNote}` };
      if (a.smell === "SI")
        return { cause: "Válvula o manguera de purga con fuga", action: `Revisar la válvula de purga y mangueras buscando grietas o fugas. Hacer prueba de humo en el sistema EVAP si es necesario.${versaNote}` };
      return { cause: "Falla eléctrica del circuito de la válvula de purga", action: `Revisar conector y cableado de la válvula. Medir continuidad hacia la ECU. Reemplazar la válvula si el circuito está bien pero el código persiste.${versaNote}` };
    }
  }

};

const AVAILABLE_CODES = Object.keys(diagnostics);

// ─────────────────────────────────────────────────────────────
// 🔹 INPUT PARSER (un solo parser para todos los formatos)
//   • Pipes:    "Nissan | Versa | 2016 | P2135 | 84000"
//   • Espacios: "Nissan Versa 2016 P2135 84000"
//   • Natural:  "se prendió el foco P0420 en mi versa 2015"
//   • Solo código: "P0300"
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
  NP300: "NP300", SPARK: "Spark", GOL: "Gol", VENTO: "Vento", FIGO: "Figo"
};

function parseInput(text) {
  const code = text.toUpperCase().match(/P[0-9]{4}/)?.[0];
  if (!code) return null;

  // ── Formato con pipes ──
  if (text.includes("|")) {
    const parts = text.split("|").map(x => x.trim());
    const [make = "", model = "", year = "", , mileageRaw = "0"] = parts;
    return {
      code,
      vehicle: {
        make,
        model,
        year: (year.match(/\d{4}/) || [""])[0],
        mileage: (mileageRaw.replace(/[^0-9]/g, "") || "0")
      }
    };
  }

  // ── Texto libre / espacios ──
  const cleaned = text.replace(/P[0-9]{4}/i, " "); // quitar código antes de leer números
  const upper = cleaned.toUpperCase();

  let make = "";
  for (const key in KNOWN_MAKES) { if (upper.includes(key)) { make = KNOWN_MAKES[key]; break; } }
  let model = "";
  for (const key in KNOWN_MODELS) { if (upper.includes(key)) { model = KNOWN_MODELS[key]; break; } }

  const year = (cleaned.match(/\b(199\d|20[0-2]\d)\b/) || [""])[0];

  const nums = (cleaned.match(/\d[\d,]{2,}/g) || [])
    .map(n => n.replace(/[^0-9]/g, ""))
    .filter(n => n && n !== year);
  const mileage = nums.length
    ? nums.sort((a, b) => b.length - a.length || Number(b) - Number(a))[0]
    : "0";

  return { code, vehicle: { make, model, year, mileage } };
}

// Normaliza respuestas (sí, simón, nel, acentos, etc.)
function normalizeAnswer(text) {
  let t = (text || "").toUpperCase().trim();
  t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (["SI", "S", "YES", "CLARO", "SIMON", "SIP", "AJA", "AFIRMATIVO"].includes(t)) return "SI";
  if (["NO", "N", "NEL", "NOP", "NUNCA", "NEGATIVO"].includes(t)) return "NO";
  return t;
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
    const state = userState[from] || {};

    if (["RESET", "REINICIAR", "NUEVO", "MENU"].some(c => upper.includes(c))) {
      delete userState[from];
      return safeSend(from, welcomeMessage());
    }

    if (state.stage === "awaiting_feedback") return handleFeedback(from, upper, state);
    if (state.stage === "awaiting_fix_description") return handleFixDescription(from, text, state);
    if (state.stage === "questioning") return handleAnswer(from, upper, state);

    const parsed = parseInput(text);
    if (parsed) {
      const hasNewVehicle = parsed.vehicle.make || parsed.vehicle.model || parsed.vehicle.year;
      const vehicle = hasNewVehicle ? parsed.vehicle : (state.vehicle || parsed.vehicle);
      return startDiagnostic(from, parsed.code, vehicle, text);
    }

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
      `Códigos disponibles hoy:\n` +
      `P0300 · P0171 · P0420 · P0455 · P0128\n` +
      `P0507 · P0340 · P0101 · P0605 · P0868\n` +
      `P2135 · P0335 · P0011 · P0744 · P0443\n\n` +
      `Manda cualquiera de estos para un diagnóstico al instante.`
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
    `❌ *NO* — Sigue fallando`
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
    `Pasos adicionales recomendados:\n` +
    `• Escanear datos en tiempo real: RPM, TPS, MAF, O2\n` +
    `• Verificar tierra del motor y voltaje de batería en ralentí\n` +
    `• Revisar boletines de servicio (TSB) para este modelo\n` +
    `• Si persiste, considerar inspección física especializada\n\n` +
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

  return safeSend(from,
    `✅ *¡Registrado, gracias!*\n\n` +
    `Cada caso confirmado hace a Aivora más preciso. 🧠\n\n` +
    `Manda un nuevo código cuando lo necesites. ¡Éxito! 🔧`
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
app.listen(PORT, () => console.log(`🚀 Aivora V1 active on port ${PORT} — ${AVAILABLE_CODES.length} códigos activos`));