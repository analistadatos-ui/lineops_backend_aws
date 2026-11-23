// banda-plc.js
// ---------------------------------------------------------------------------
// Banda transportadora (CS-001) — monitor de PLCs, SOLO LECTURA.
//
// Misma forma que finished-warehouse.js:
//   const registerBanda = require("./banda-plc");
//   await registerBanda.initSchema({ pool, setSchema });
//   registerBanda(app, { authenticateToken, pool, setSchema });
//
// Qué hace:
//   • Lee la memoria V (V200..V285) de cada IP configurada con el protocolo S7
//     (puerto 102), igual que banda_plc.py de Nexo. Solo usa la función 0x04
//     (leer variable): este módulo NO tiene forma de escribir en un PLC.
//   • Cada IP tiene su propio interruptor (encendido / apagado). Apagado por
//     omisión; el estado vive en memoria y se pierde al reiniciar el servidor.
//   • Detecta cada escaneo (V215 sube a 0x0B, o cambia el texto en V246),
//     decide a qué poste debería ir la caja y lo guarda en banda_eventos.
//   • "Probar conexión": revisa qué puertos responden (S7, Modbus, web) e
//     intenta una lectura S7. Para Modbus solo abre y cierra el puerto: no
//     manda ninguna petición.
//
// Variables de entorno (opcionales):
//   BANDA_PLC_IPS        "10.1.11.100,10.1.11.103,10.1.11.104,10.1.11.107"
//   BANDA_PLC_NOMBRES    "10.1.11.100=PLC de la banda;10.1.11.104=Programa anterior"
//   BANDA_PLC_INTERVALO  segundos entre lecturas (0.25)
//   BANDA_PLC_AUTOSTART  "10.1.11.100" → IPs que se encienden al arrancar
//   BANDA_PROBE_PORTS    "102,502,80,443"
//   BANDA_MISMO_CODIGO_SEG  segundos mínimos para contar otra vez el mismo código (3)
//
// OJO: las direcciones V215 / V246 solo están confirmadas para 10.1.11.100.
// En las otras IPs la pantalla muestra la memoria cruda para poder estudiarla.
// ---------------------------------------------------------------------------

const net = require("net");

const V_INICIO = 200;
const V_LARGO = 86;             // V200..V285
const OFF = (dir) => dir - V_INICIO;
const V_SENAL = 215;            // 0 -> 0x0B durante ~0.5 s en cada escaneo
const V_SERIAL = 246;           // texto ASCII del último serial, terminado en 0
const SERIAL_MAX = 40;
const ESPERA_DEL_EVENTO = 700;  // ms: esperar a que el texto del serial esté completo
// La misma caja vuelve a contar si el PLC BORRÓ el código entre un escaneo y otro
// (así se distingue un re-escaneo real de la señal que el PLC repite sola).
// Por debajo de este tiempo se toma como rebote del lector, no como otra pasada.
const MISMO_CODIGO_MIN = Math.max(0, Math.round((Number(process.env.BANDA_MISMO_CODIGO_SEG) || 3) * 1000));
const TSAPS = [[0x1000, 0x0300], [0x4d57, 0x4d57], [0x0100, 0x0300]];
const EVENTOS_EN_MEMORIA = 200;

const IPS = String(process.env.BANDA_PLC_IPS || "10.1.11.100,10.1.11.103,10.1.11.104,10.1.11.107")
  .split(",").map((s) => s.trim()).filter(Boolean);
const NOMBRES_DEFECTO = {
  "10.1.11.100": "PLC de la banda (CS-001)",
  "10.1.11.104": "Programa anterior (recibía V5..V8)",
};
const NOMBRES = { ...NOMBRES_DEFECTO };
for (const par of String(process.env.BANDA_PLC_NOMBRES || "").split(";")) {
  const i = par.indexOf("=");
  if (i > 0) NOMBRES[par.slice(0, i).trim()] = par.slice(i + 1).trim();
}
const INTERVALO = Math.max(100, Math.round((Number(process.env.BANDA_PLC_INTERVALO) || 0.25) * 1000));
const PUERTOS_PRUEBA = String(process.env.BANDA_PROBE_PORTS || "102,502,80,443")
  .split(",").map((p) => Number(p.trim())).filter((p) => p > 0 && p < 65536);
const PUERTO_NOMBRE = { 102: "S7 (Siemens)", 502: "Modbus TCP", 80: "Web", 443: "Web segura" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tpkt = (carga) => Buffer.concat([Buffer.from([0x03, 0x00, (carga.length + 4) >> 8, (carga.length + 4) & 255]), carga]);
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

// ---------------------------------------------------------------------------
// Cliente S7 mínimo: conexión COTP, negociación y LECTURA de la memoria V (DB1).
// No implementa escritura.
// ---------------------------------------------------------------------------
class ClienteS7 {
  constructor(ip, tl, tr, { puerto = 102, timeout = 4000 } = {}) {
    Object.assign(this, { ip, tl, tr, puerto, timeout });
    this.ref = 0;
    this.buf = Buffer.alloc(0);
    this.espera = null;          // { n, resolve, reject, timer }
    this.muerto = null;
    this.s = null;
  }

  _pump() {
    const w = this.espera;
    if (w && this.buf.length >= w.n) {
      const datos = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      clearTimeout(w.timer);
      this.espera = null;
      w.resolve(Buffer.from(datos));
    }
  }

  _exacto(n) {
    if (this.muerto) return Promise.reject(this.muerto);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.espera = null;
        reject(new Error(`el PLC no contestó en ${this.timeout / 1000} s`));
        this.cierra();
      }, this.timeout);
      this.espera = { n, resolve, reject, timer };
      this._pump();
    });
  }

  async _recibe() {
    const cab = await this._exacto(4);
    return this._exacto(cab.readUInt16BE(2) - 4);
  }

  async conecta() {
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.ip, port: this.puerto });
      const timer = setTimeout(() => { s.destroy(); reject(new Error("no responde el puerto 102")); }, this.timeout);
      s.once("connect", () => { clearTimeout(timer); resolve(); });
      s.once("error", (e) => { clearTimeout(timer); reject(e); });
      this.s = s;
    });
    this.s.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this._pump(); });
    const muere = (e) => {
      this.muerto = e || new Error("el PLC cerró la conexión");
      if (this.espera) { clearTimeout(this.espera.timer); this.espera.reject(this.muerto); this.espera = null; }
    };
    this.s.on("error", muere);
    this.s.on("close", () => muere());

    const cr = Buffer.from([0x11, 0xe0, 0, 0, 0, 1, 0, 0xc1, 2, this.tl >> 8, this.tl & 255, 0xc2, 2, this.tr >> 8, this.tr & 255, 0xc0, 1, 0x0a]);
    this.s.write(tpkt(cr));
    const r = await this._recibe();
    if (r.length < 2 || r[1] !== 0xd0) throw new Error(`el PLC rechazó la conexión (TSAP ${hex4(this.tl)}/${hex4(this.tr)})`);
    this.s.write(tpkt(Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), Buffer.from("32010000ffff00080000f0000001000101e0", "hex")])));
    await this._recibe();
  }

  // n bytes de V<direccion> (DB1). Función S7 0x04 = leer variable.
  async leeV(direccion, n) {
    this.ref = (this.ref + 1) & 0xffff;
    const msg = Buffer.alloc(24);
    Buffer.from([0x32, 0x01, 0x00, 0x00]).copy(msg, 0);
    msg.writeUInt16BE(this.ref, 4);
    Buffer.from([0x00, 0x0e, 0x00, 0x00, 0x04, 0x01, 0x12, 0x0a, 0x10, 0x02]).copy(msg, 6);
    msg.writeUInt16BE(n, 16);
    msg.writeUInt16BE(1, 18);   // DB1 = memoria V
    msg[20] = 0x84;
    const bit = direccion * 8;
    msg[21] = (bit >> 16) & 255; msg[22] = (bit >> 8) & 255; msg[23] = bit & 255;
    this.s.write(tpkt(Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), msg])));
    const r = await this._recibe();
    const base = 3 + 12 + 2;
    if (r[13] !== 0 || r[14] !== 0) throw new Error(`el PLC contestó con error S7 ${r.subarray(13, 15).toString("hex")}`);
    if (r[base] !== 0xff) throw new Error(`el PLC no dio el dato (código 0x${(r[base] ?? 0).toString(16)})`);
    return Buffer.from(r.subarray(base + 4, base + 4 + n));
  }

  cierra() {
    try { this.s?.destroy(); } catch { /* */ }
    this.s = null;
  }
}

async function conectarS7(ip) {
  const errores = [];
  for (const [tl, tr] of TSAPS) {
    const c = new ClienteS7(ip, tl, tr);
    try {
      await c.conecta();
      return { cliente: c, tsap: `${hex4(tl)}/${hex4(tr)}` };
    } catch (e) {
      errores.push(`${hex4(tl)}/${hex4(tr)}: ${e.message}`);
      c.cierra();
      if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|no responde/.test(e.message)) break;   // el puerto ni abre: no tiene caso probar más TSAP
    }
  }
  throw new Error(errores.join("; "));
}

const serialDe = (v) => {
  const ini = OFF(V_SERIAL);
  const crudo = v.subarray(ini, ini + SERIAL_MAX);
  const fin = crudo.indexOf(0);
  return [...(fin >= 0 ? crudo.subarray(0, fin) : crudo)].filter((c) => c >= 32 && c < 127).map((c) => String.fromCharCode(c)).join("").trim();
};

// ---------------------------------------------------------------------------
// ¿Qué es esa caja y a qué poste va?
// El PLC guarda lo escaneado SIN sus 3 primeros caracteres, así que se busca el
// código tal cual y también por sufijo. Regla (ajústela aquí si cambia):
//   • caja de una lista de pre-empaque                → poste CORRECTO
//   • ticket ya dado de entrada a inventario          → poste CORRECTO
//   • ticket todavía pendiente de entrada             → poste de RECHAZO
//   • código que el sistema no conoce / sin lectura   → poste de RECHAZO
// ---------------------------------------------------------------------------
async function reconocer(client, serial) {
  if (!serial) return { reconocido: false, tipo: null, referencia: null, poste: "rechazo", motivo: "El PLC no leyó ningún código" };
  const args = [serial, serial.length + 3];
  const coincide = (col) => `(upper(${col}) = upper($1) OR (length(${col}) = $2 AND upper(substr(${col}, 4)) = upper($1)))`;

  const caja = await client.query(
    `SELECT b.box_qrcode, b.po, b.style, b.size_code, b.color_name, b.quantity, l.list_no, l.status
       FROM pre_packing_boxes b JOIN pre_packing_lists l ON l.id = b.list_id
      WHERE ${coincide("b.box_qrcode")} ORDER BY b.id DESC LIMIT 1`, args);
  if (caja.rows[0]) {
    const b = caja.rows[0];
    return { reconocido: true, tipo: "caja", referencia: b.box_qrcode, poste: "correcto",
      motivo: `Caja de la lista ${b.list_no} (${b.status}) · ${[b.po, b.style, b.size_code, b.color_name].filter(Boolean).join(" ")}` };
  }

  const tk = await client.query(
    `SELECT ticket_no, folio, work_order_no, size_code, color, pieces, checked_in_at
       FROM scanned_tickets
      WHERE ${coincide("folio")} OR ${coincide("ticket_no")} ORDER BY id DESC LIMIT 1`, args);
  if (tk.rows[0]) {
    const t = tk.rows[0];
    const dentro = !!t.checked_in_at;
    return { reconocido: true, tipo: "ticket", referencia: t.folio || t.ticket_no, poste: dentro ? "correcto" : "rechazo",
      motivo: `${dentro ? "Ticket en inventario" : "Ticket sin entrada a inventario"} · ${[t.work_order_no, t.size_code, t.color, `${Number(t.pieces) || 0} pzas`].filter(Boolean).join(" ")}` };
  }

  if (/^\d{17}$/.test(serial)) {
    return { reconocido: false, tipo: "nike", referencia: null, poste: "rechazo",
      motivo: "Etiqueta de cartón Nike (le faltan sus 3 primeros dígitos); este sistema no guarda las etiquetas de Nike" };
  }
  return { reconocido: false, tipo: null, referencia: null, poste: "rechazo", motivo: "El sistema no conoce este código" };
}

// ---------------------------------------------------------------------------
// Estado en memoria de cada PLC.
// ---------------------------------------------------------------------------
const plcs = new Map(IPS.map((ip) => [ip, {
  ip, nombre: NOMBRES[ip] || "Por identificar",
  encendido: false, conectado: false, tsap: null, error: null,
  ultimoContacto: null, lecturas: 0, hex: null, senal: null, serial: null,
  ultimaPrueba: null, generacion: 0, ultimoLeido: null, ultimoLeidoAt: null, pulsosRepetidos: 0,
}]));
const eventos = [];   // los últimos EVENTOS_EN_MEMORIA, el más nuevo al final
let siguienteId = 1;

const publico = (p) => ({
  ip: p.ip, nombre: p.nombre, encendido: p.encendido, conectado: p.conectado, tsap: p.tsap, error: p.error,
  ultimoContacto: p.ultimoContacto, lecturas: p.lecturas, hex: p.hex, senal: p.senal, serial: p.serial,
  ultimaPrueba: p.ultimaPrueba, ultimoLeido: p.ultimoLeido, ultimoLeidoAt: p.ultimoLeidoAt, pulsosRepetidos: p.pulsosRepetidos,
});

function revisaPuerto(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.createConnection({ host: ip, port });
    const fin = (abierto, error) => { s.destroy(); resolve({ port, nombre: PUERTO_NOMBRE[port] || null, abierto, ms: Date.now() - t0, error }); };
    s.setTimeout(timeout, () => fin(false, "sin respuesta"));
    s.once("connect", () => fin(true, null));
    s.once("error", (e) => fin(false, e.code === "ECONNREFUSED" ? "cerrado" : e.code || e.message));
  });
}

function registerBanda(app, deps) {
  const { authenticateToken, pool, setSchema } = deps;

  const conCliente = async (fn) => {
    const client = await pool.connect();
    try { await setSchema(client); return await fn(client); } finally { client.release(); }
  };

  async function guardar(p, serial, pulso, cambio, v, repetido = false) {
    let r;
    try { r = await conCliente((c) => reconocer(c, serial)); }
    catch (e) { r = { reconocido: false, tipo: null, referencia: null, poste: "rechazo", motivo: `No se pudo consultar la base: ${e.message}` }; }
    const ev = {
      plc_ip: p.ip, serial, senal: !!pulso, cambio_texto: !!cambio, reconocido: r.reconocido, tipo: r.tipo,
      referencia: r.referencia, poste: r.poste, motivo: r.motivo, datos_hex: v.toString("hex"), created_at: new Date().toISOString(),
      repetido,
    };
    try {
      const { rows } = await conCliente((c) => c.query(
        `INSERT INTO banda_eventos (plc_ip, serial, senal, cambio_texto, reconocido, tipo, referencia, poste, motivo, datos_hex, repetido)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
        [ev.plc_ip, ev.serial, ev.senal, ev.cambio_texto, ev.reconocido, ev.tipo, ev.referencia, ev.poste, ev.motivo, ev.datos_hex, ev.repetido]));
      ev.id = Number(rows[0].id);
      ev.created_at = rows[0].created_at;
      siguienteId = Math.max(siguienteId, ev.id + 1);
    } catch (e) {
      ev.id = siguienteId++;
      console.warn("⚠️ banda: no se pudo guardar el escaneo:", e.message);
    }
    eventos.push(ev);
    if (eventos.length > EVENTOS_EN_MEMORIA) eventos.shift();
    console.log(`📦 banda ${p.ip}: ${JSON.stringify(serial)} → ${r.poste} (${r.motivo})`);
  }

  // Un bucle por IP. `generacion` evita que queden dos bucles si se apaga y prende rápido.
  async function bucle(p, gen) {
    let cliente = null, previoSenal = null, ultimoSerial = null, disparo = null, hubo = { pulso: false, cambio: false };
    let serialEvento = null, vEvento = null;
    let vaciado = false, ultimoGuardado = 0;   // ¿el PLC borró el código desde la última caja?   // último código NO vacío visto durante el escaneo (el PLC puede borrarlo antes de los 0.7 s)
    const sigue = () => p.encendido && p.generacion === gen;
    while (sigue()) {
      try {
        if (!cliente) {
          const c = await conectarS7(p.ip);
          if (!sigue()) { c.cliente.cierra(); break; }
          cliente = c.cliente;
          Object.assign(p, { conectado: true, error: null, tsap: c.tsap });
          previoSenal = null; ultimoSerial = null; disparo = null; serialEvento = null; vEvento = null; vaciado = false;
          console.log(`🔌 banda: conectado al PLC ${p.ip} (TSAP ${c.tsap})`);
        }
        const v = await cliente.leeV(V_INICIO, V_LARGO);
        const ahora = Date.now();
        const senal = v[OFF(V_SENAL)];
        const serial = serialDe(v);
        Object.assign(p, { conectado: true, error: null, ultimoContacto: new Date(ahora).toISOString(), lecturas: p.lecturas + 1, hex: v.toString("hex"), senal, serial });
        if (previoSenal === null) {         // primera lectura tras conectar: solo línea base
          previoSenal = senal; ultimoSerial = serial;
        } else {
          const sube = senal === 0x0b && previoSenal !== 0x0b;
          if (!serial && ultimoSerial) vaciado = true;
          let otraVez = false;
          if (serial && vaciado) {   // el código acaba de reaparecer tras borrarse: se decide UNA vez
            otraVez = serial === ultimoSerial && ahora - ultimoGuardado >= MISMO_CODIGO_MIN;
            vaciado = false;
          }
          const cambia = !!serial && (serial !== ultimoSerial || otraVez);
          if ((sube || cambia) && disparo === null) disparo = ahora;
          if (disparo !== null && serial) { serialEvento = serial; vEvento = v; }
          hubo.pulso = hubo.pulso || sube;
          hubo.cambio = hubo.cambio || cambia;
          previoSenal = senal;
          if (disparo !== null && ahora - disparo >= ESPERA_DEL_EVENTO) {
            const leido = serialEvento || serial;
            if (hubo.cambio) {
              await guardar(p, leido, hubo.pulso, hubo.cambio, vEvento || v, !!leido && leido === ultimoSerial);
              if (leido) ultimoSerial = leido;
              vaciado = !serial; ultimoGuardado = Date.now();
              Object.assign(p, { ultimoLeido: leido || null, ultimoLeidoAt: new Date().toISOString() });
            } else {
              p.pulsosRepetidos += 1;   // el PLC repite la señal sin código nuevo: no es otra caja
            }
            disparo = null; hubo = { pulso: false, cambio: false }; serialEvento = null; vEvento = null;
          }
        }
        await sleep(INTERVALO);
      } catch (e) {
        Object.assign(p, { conectado: false, error: String(e.message || e).slice(0, 200) });
        cliente?.cierra();
        cliente = null;
        for (let i = 0; i < 10 && sigue(); i++) await sleep(500);   // reintenta en ~5 s, pero se apaga al instante
      }
    }
    cliente?.cierra();
    if (p.generacion === gen) p.conectado = false;
  }

  function enciende(p, on) {
    if (on === p.encendido) return;
    p.encendido = on;
    p.generacion += 1;
    if (on) { p.error = null; bucle(p, p.generacion); }
    else { p.conectado = false; }
  }

  async function prueba(ip) {
    const t0 = Date.now();
    const puertos = await Promise.all(PUERTOS_PRUEBA.map((port) => revisaPuerto(ip, port)));
    let s7 = { ok: false, error: "el puerto 102 no responde" };
    if (puertos.find((x) => x.port === 102)?.abierto) {
      let c = null;
      try {
        c = await conectarS7(ip);
        const v = await c.cliente.leeV(V_INICIO, V_LARGO);
        s7 = { ok: true, tsap: c.tsap, hex: v.toString("hex"), senal: v[OFF(V_SENAL)], serial: serialDe(v) };
      } catch (e) {
        s7 = { ok: false, error: String(e.message || e).slice(0, 300) };
      } finally {
        c?.cliente.cierra();
      }
    }
    return { ip, fecha: new Date().toISOString(), ms: Date.now() - t0, puertos, s7 };
  }

  // Solo se aceptan las IPs configuradas: la pantalla no puede usarse para escanear otras máquinas.
  const plcDe = (req, res) => {
    const p = plcs.get(String(req.params.ip || ""));
    if (!p) { res.status(404).json({ success: false, error: "Esa IP no está en BANDA_PLC_IPS" }); return null; }
    return p;
  };

  // Estado de todos los PLC + eventos nuevos (después de `after`).
  app.get("/api/banda/estado", authenticateToken, (req, res) => {
    const after = Number(req.query.after) || 0;
    const nuevos = eventos.filter((e) => e.id > after).slice(-100).map(({ datos_hex, ...e }) => e);
    res.json({ success: true, intervaloMs: INTERVALO, plcs: [...plcs.values()].map(publico), eventos: nuevos });
  });

  // Historial guardado (para la tabla al abrir la pantalla).
  app.get("/api/banda/eventos", authenticateToken, async (req, res) => {
    try {
      const limite = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
      const { rows } = await conCliente((c) => c.query(
        `SELECT id, plc_ip, serial, senal, cambio_texto, reconocido, tipo, referencia, poste, motivo, repetido, created_at
           FROM banda_eventos ORDER BY id DESC LIMIT $1`, [limite]));
      const hoy = await conCliente((c) => c.query(
        `SELECT poste, COUNT(*)::int AS n FROM banda_eventos WHERE cambio_texto AND created_at >= date_trunc('day', now()) GROUP BY poste`));
      res.json({ success: true, eventos: rows.map((r) => ({ ...r, id: Number(r.id) })), hoy: Object.fromEntries(hoy.rows.map((r) => [r.poste, r.n])) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Encender / apagar la lectura de una IP. No toca el PLC: solo abre o cierra la lectura.
  app.post("/api/banda/plcs/:ip/monitor", authenticateToken, (req, res) => {
    const p = plcDe(req, res);
    if (!p) return;
    enciende(p, !!req.body?.on);
    res.json({ success: true, plc: publico(p) });
  });

  // Prueba de conexión de una IP (puertos + una lectura S7).
  app.post("/api/banda/plcs/:ip/probe", authenticateToken, async (req, res) => {
    const p = plcDe(req, res);
    if (!p) return;
    try {
      p.ultimaPrueba = await prueba(p.ip);
      res.json({ success: true, prueba: p.ultimaPrueba });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  for (const ip of String(process.env.BANDA_PLC_AUTOSTART || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (plcs.has(ip)) enciende(plcs.get(ip), true);
  }
}

async function initSchema({ pool, setSchema }) {
  const client = await pool.connect();
  try {
    await setSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS banda_eventos(
        id BIGSERIAL PRIMARY KEY,
        plc_ip VARCHAR(45) NOT NULL,
        serial VARCHAR(80),
        senal BOOLEAN NOT NULL DEFAULT false,
        cambio_texto BOOLEAN NOT NULL DEFAULT false,
        reconocido BOOLEAN NOT NULL DEFAULT false,
        tipo VARCHAR(20),
        referencia VARCHAR(120),
        poste VARCHAR(20) NOT NULL,
        motivo TEXT,
        datos_hex TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_banda_eventos_at ON banda_eventos(created_at DESC);");
    await client.query("ALTER TABLE banda_eventos ADD COLUMN IF NOT EXISTS repetido BOOLEAN NOT NULL DEFAULT false;");
    console.log("✅ banda_eventos ready");
  } finally {
    client.release();
  }
}

registerBanda.initSchema = initSchema;
registerBanda.ClienteS7 = ClienteS7;   // por si se quiere probar desde la consola
module.exports = registerBanda;