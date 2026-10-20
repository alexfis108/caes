/************************************************************
 * PAE HUANCAVELICA — Carga de Formatos CAE
 * Aplicación web con Google Apps Script
 * Estados: CON FORMATO / SIN FORMATO / OBSERVADO
 *
 * VERSIÓN ANTI-BLOQUEO (ajustes tras la suspensión de la cuenta):
 * 1. Hoja TRAMITADOR como ÚNICA fuente de verdad (sin escaneos de Drive)
 * 2. Caché entre ejecuciones (CacheService) = menos lecturas de hoja/APIs
 * 3. Rate limiting por sesión y global (anti-rafaga de peticiones)
 * 4. reCAPTCHA v3 + honeypot en la carga de archivos
 * 5. Correos con control de cuota, ritmo diario y auditoría (hoja LOG_CORREOS)
 * 6. Logo cacheado (sin UrlFetchApp en cada PDF)
 * 7. LockService con espera corta (5 s en lugar de 30 s)
 ************************************************************/

// ==================== CONFIGURACIÓN ====================
const CONFIG = {
  ID_HOJA_CALCULO: '1h3pOTIAbgbC6zOmIXZEmMvgIv45y0N0DOIOsXv9__iY',
  HOJA_IIEES: 'IIEES',
  HOJA_TRAMITADOR: 'TRAMITADOR',
  HOJA_PERSONAL: 'PERSONAL',
  HOJA_RUTA: 'RUTA',
  HOJA_OBSERVACIONES: 'OBSERVACIONES',
  HOJA_SIGO: 'SIGO',              // marcas "FORMATO CARGADO AL SIGO" del personal PAE

  // Carpeta ÚNICA donde se guardan TODOS los archivos (ACTAS CAE) cargados.
  // IMPORTANTE: la app YA NO la escanea para saber qué IIEE tienen formato;
  // la fuente de verdad es la hoja TRAMITADOR. Solo se usa para GUARDAR archivos.
  ID_CARPETA_DRIVE: '13gudjEkjNzwtnzLm5LFzq0F526_t8lgo',
  // Carpeta legado: SOLO la usa sincronizarLegadoUnaVez() (migración única y manual)
  ID_CARPETA_LEGADO: '',

  URL_FORMATO_PDF: 'https://drive.google.com/uc?export=download&id=19IRmUiuQhLRpCeoqb97qHtC4m-xuqOLV',
  URL_FORMATO_WORD: 'https://docs.google.com/document/d/1tdWlzOrCdSn5oeBbdLTBbp7m8lqWt--1/export?format=docx',

  // Enlace público del sitio para re-cargar formatos (usado en correos y WhatsApp)
  URL_APP_SITIO: 'https://sites.google.com/view/pae-huancavelica/caes',

  LOGO_URL: 'https://raw.githubusercontent.com/alexfis108/imagenes/refs/heads/main/PAE.png',

  TAMANO_MAX_MB: 10,
  ZONA_HORARIA: 'America/Lima',
  MAX_RESULTADOS: 30,

  PALABRA_ADMIN: 'ADMINISTRADOR',
  CLAVE_ADMIN: 'PAEHuancavelica2026@@',

  // ============ CONTROL ANTI-BLOQUEO (ajustes tras la suspensión) ============
  // --- Correos controlados (evita que MailApp dispare los filtros antispam) ---
  ENVIAR_CORREOS: true,           // Poner en false para suspender TODOS los envíos
  MAX_CORREOS_DIA: 80,            // Tope diario propio (cuenta gratuita Gmail: 100/día)
  MAX_CORREOS_POR_MINUTO: 8,      // Ritmo máximo de envío por minuto
  RESERVA_CUOTA_CORREO: 5,        // No enviar si la cuota restante de MailApp <= este valor

  // --- reCAPTCHA v3 (protección anti-bot en la carga de archivos) ---
  // 1) Cree las claves en https://www.google.com/recaptcha/admin (tipo reCAPTCHA v3)
  // 2) Registre los dominios donde corre la app (p. ej. sites.google.com y script.google.com)
  // 3) Pegue las claves aquí. Si las deja vacías, la verificación queda desactivada.
  RECAPTCHA_SITE_KEY: '',         // Clave del sitio (se inserta en Index.html)
  RECAPTCHA_SECRET_KEY: '',       // Clave secreta (verificación en el servidor)
  RECAPTCHA_MIN_SCORE: 0.5,       // Puntaje mínimo aceptado (0.0 a 1.0)
  RECAPTCHA_BLOQUEAR: true,       // true = rechaza cargas sospechosas; false = solo registra

  // --- Rate limiting (máximo de peticiones para no agotar las cuotas de APIs) ---
  MAX_BUSQUEDAS_POR_MIN: 10,        // búsquedas por minuto por sesión
  MAX_BUSQUEDAS_GLOBAL_POR_MIN: 150,// búsquedas por minuto de todo el sistema
  MAX_DNIS_POR_MIN: 12,             // consultas de personal por minuto por sesión
  MAX_DNIS_GLOBAL_POR_MIN: 60,      // consultas de personal por minuto global
  MAX_CARGAS_POR_10MIN: 3,          // cargas de archivo por cada 10 min por sesión
  MAX_CARGAS_GLOBAL_POR_MIN: 15,    // cargas de archivo por minuto global
  MAX_CARGOS_POR_10MIN: 3,          // generaciones de cargo PDF por 10 min por sesión
  MAX_CARGOS_GLOBAL_POR_10MIN: 20,  // generaciones de cargo PDF por 10 min global
  MAX_INTENTOS_ADMIN_POR_MIN: 5,    // intentos de clave admin por minuto por sesión
  MAX_INTENTOS_ADMIN_GLOBAL_POR_MIN: 30,
  MAX_MARCAS_POR_10MIN: 40,         // marcas SIGO por 10 min por sesión (el personal puede marcar varias seguidas)
  MAX_MARCAS_GLOBAL_POR_MIN: 120,   // marcas SIGO por minuto global

  // --- Otros ---
  HOJA_LOG_CORREOS: 'LOG_CORREOS', // hoja de auditoría de correos enviados/omitidos
  TTL_CACHE_DATOS_SEG: 900,        // caché de datos de hojas entre ejecuciones (15 min)
  TTL_CACHE_LOGO_SEG: 21600,       // caché del logo (6 h, máximo de CacheService)
  ESPERA_LOCK_MS: 5000             // espera máxima del LockService (antes 30000)
};

const COLORES = { verde: '#0B6E4F', verdeClaro: '#16A34A', naranja: '#F58220', amarillo: '#FFC20E', gris: '#64748B', ambar: '#B45309' };

/* ============================================================
 * MAPAS DE COLUMNAS (detectadas por encabezados de la fila 1)
 * ============================================================ */
const MAPA_IIEES = {
  COD_MOD: ['COD MODULAR', 'CODIGO MODULAR', 'COD_MODULAR', 'CODIGO_MODULAR', 'CODMOD'],
  NOMBRE: ['NOMBRE DE LA IIEE', 'NOMBRE IIEE', 'NOMBRE DE LA IE', 'NOMBRE DE LA I.E.', 'NOMBRE DE LA INSTITUCION EDUCATIVA', 'INSTITUCION EDUCATIVA', 'NOMBRE'],
  NIVEL: ['NIVEL', 'NIVEL/MODALIDAD', 'NIVEL Y MODALIDAD', 'NIVEL MODALIDAD'],
  PROVINCIA: ['PROVINCIA'],
  DISTRITO: ['DISTRITO'],
  CENTRO_POBLADO: ['CENTRO POBLADO', 'CENTRO POBLADO (CCPP)', 'CCPP', 'CENTRO POBL'],
  COD_RUTA: ['COD_RUTA', 'CODIGO RUTA', 'CODIGO DE RUTA', 'COD RUTA', 'RUTA'],
  COD_PERSONAL: ['COD_PERSONAL_ASIGNADO', 'COD PERSONAL ASIGNADO', 'CODIGO PERSONAL ASIGNADO', 'CODIGO DE PERSONAL ASIGNADO', 'COD PERSONAL', 'CODPERSONAL', 'PERSONAL ASIGNADO', 'COD_PERSONAL']
};
const RESPALDO_IIEES = { COD_MOD: 5, NOMBRE: 6, COD_RUTA: 7, NIVEL: 2, PROVINCIA: 3, DISTRITO: 4, CENTRO_POBLADO: 8, COD_PERSONAL: 10 };

const MAPA_PERSONAL = {
  DNI: ['DNI', 'D.N.I.', 'DOCUMENTO', 'DOCUMENTO DE IDENTIDAD', 'NRO DOCUMENTO', 'NUMERO DE DOCUMENTO'],
  APELLIDOS: ['APELLIDOS Y NOMBRES', 'APELLIDOS Y NOMBRE', 'NOMBRES Y APELLIDOS', 'TRAMITADOR', 'NOMBRE COMPLETO', 'APELLIDOS'],
  PATERNO: ['APELLIDO PATERNO', 'APELLIDO PATER', 'APELLIDOPATERNO', 'APATERNO', 'PATERNO'],
  MATERNO: ['APELLIDO MATERNO', 'APELLIDO MATER', 'APELLIDOMATERNO', 'AMATERNO', 'MATERNO'],
  NOMBRES: ['NOMBRES', 'NOMBRE'],
  CELULAR: ['CELULAR PERSONAL', 'CELULAR INSTITUCIONAL', 'CELULAR', 'TELEFONO', 'CEL', 'NUMERO DE CONTACTO']
};
const RESPALDO_PERSONAL = { DNI: 2, APELLIDOS: 2, PATERNO: 3, MATERNO: 4, NOMBRES: 5, CELULAR: 7 };

const MAPA_TRAMITADOR = {
  FECHA: ['FECHA', 'FECHA Y HORA', 'FECHA DE CARGA', 'FECHA/HORA'],
  APELLIDOS: ['APELLIDOS Y NOMBRES', 'APELLIDOS Y NOMBRE', 'NOMBRES Y APELLIDOS', 'TRAMITADOR', 'NOMBRE COMPLETO', 'APELLIDOSYNOMBRES'],
  CELULAR: ['CELULAR', 'TELEFONO', 'CEL', 'NUMERO DE CONTACTO'],
  CORREO: ['CORREO', 'CORREO ELECTRONICO', 'EMAIL'],
  COD_MOD: ['COD MODULAR', 'CODIGO MODULAR', 'CODIGO_MODULAR', 'CODMODULAR'],
  NOMBRE_IIEE: ['NOMBRE IIEE', 'NOMBRE DE LA IIEE', 'IIEE'],
  NIVEL: ['NIVEL'],
  PROVINCIA: ['PROVINCIA'],
  DISTRITO: ['DISTRITO'],
  COD_RUTA: ['COD_RUTA', 'CODIGO RUTA', 'COD RUTA', 'RUTA'],
  ARCHIVO: ['ARCHIVO', 'NOMBRE DE ARCHIVO', 'ARCHIVO CARGADO'],
  URL: ['URL ARCHIVO', 'URL', 'ENLACE', 'LINK', 'URL DRIVE', 'IDARCHIVO', 'ID ARCHIVO']
};
const RESPALDO_TRAMITADOR = { FECHA: 1, APELLIDOS: 2, CELULAR: 3, CORREO: 4, COD_MOD: 5, NOMBRE_IIEE: 6, NIVEL: 7, PROVINCIA: 8, DISTRITO: 9, COD_RUTA: 10, ARCHIVO: 11, URL: 12 };

const MAPA_RUTA = {
  NRUTA: ['NRUTA', 'N RUTA', 'N° RUTA', 'N. RUTA', 'NUMERO DE RUTA', 'NUMERO RUTA', 'NUM RUTA', 'NUMERO', 'CODIGO', 'ID RUTA'],
  RUTA: ['RUTA', 'NOMBRE DE RUTA', 'NOMBRE RUTA', 'RUTA NOMBRE', 'COD_RUTA', 'CODIGO DE RUTA', 'CODIGO RUTA', 'COD RUTA']
};
const RESPALDO_RUTA = { NRUTA: 1, RUTA: 2 };

// Columnas FIJAS de la hoja OBSERVACIONES (la crea la propia app)
// A:FECHA B:COD.MODULAR C:NOMBRE IIEE D:COD.RUTA E:DNI PERSONAL F:PERSONAL QUE OBSERVÓ
// G:CELULAR PERSONAL H:COMENTARIO I:ESTADO J:FECHA RESUBIDA
const OBS_COL = { FECHA: 1, COD_MOD: 2, NOMBRE: 3, RUTA: 4, DNI: 5, PERSONAL: 6, CELULAR: 7, COMENTARIO: 8, ESTADO: 9, FECHA_RESUBIDA: 10 };

// Columnas FIJAS de la hoja SIGO (la crea la propia app)
// A:FECHA B:COD.MODULAR C:NOMBRE IIEE D:COD.RUTA E:DNI PERSONAL F:PERSONAL G:ESTADO
// ESTADO: 'SIGO' = marca activa · 'ANULADA' = marca retirada por el personal
const SIGO_COL = { FECHA: 1, COD_MOD: 2, NOMBRE: 3, RUTA: 4, DNI: 5, PERSONAL: 6, ESTADO: 7 };

// ==================== PUNTO DE ENTRADA WEB ====================
function doGet() {
  const t = HtmlService.createTemplateFromFile('Index');
  t.urlWebApp = ScriptApp.getService().getUrl() || '';
  t.urlSitio = CONFIG.URL_APP_SITIO;
  t.recaptchaSiteKey = CONFIG.RECAPTCHA_SITE_KEY || '';
  return t.evaluate()
    .setTitle('PAE Huancavelica — Formato CAE')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    if (!e || !e.parameter) throw new Error('Solicitud no válida.');
    const datos = JSON.parse(e.parameter.datos || '{}');
    const blob = e.parameter.archivo;
    if (!blob || !blob.getBytes) throw new Error('No se recibió ningún archivo.');
    return respuestaJSON(procesarCarga(datos, blob));
  } catch (error) {
    return respuestaJSON({ ok: false, mensaje: 'Error: ' + error.message });
  }
}

function respuestaJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ==================== UTILIDADES ====================
function normalizar(texto) {
  return String(texto == null ? '' : texto).toUpperCase()
    .replace(/[\u00C1\u00C0\u00C4\u00C2]/g, 'A')
    .replace(/[\u00C9\u00C8\u00CB\u00CA]/g, 'E')
    .replace(/[\u00CD\u00CC\u00CF\u00CE]/g, 'I')
    .replace(/[\u00D3\u00D2\u00D6\u00D4]/g, 'O')
    .replace(/[\u00DA\u00D9\u00DC\u00DB]/g, 'U')
    .replace(/[^A-Z0-9]/g, '');
}

function limpiar(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.ZONA_HORARIA, 'dd/MM/yyyy');
  return String(v).trim();
}

function escaparHtml(t) {
  return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function limpiarParaNombre(texto) {
  return String(texto == null ? '' : texto).replace(/[\\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function generarNombreArchivoCAE(codMod, nombreIIEE) {
  let base = 'CAE_' + limpiarParaNombre(codMod) +'_'+ limpiarParaNombre(nombreIIEE);
  if (base.length > 30) base = base.substring(0, 30).trim();
  return base + '.pdf';
}

function claveCodMod(v) {
  const n = normalizar(v);
  return n ? n.replace(/^0+/, '') : '';
}

function claveRuta(v) {
  let s = normalizar(v);
  if (!s) return '';
  return s.replace(/(^|[A-Z])0+(\d)/g, '$1$2');
}

function compararRutasNatural(a, b) {
  const ta = String(a == null ? '' : a).toUpperCase().split(/(\d+)/);
  const tb = String(b == null ? '' : b).toUpperCase().split(/(\d+)/);
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i] == null ? '' : ta[i];
    const y = tb[i] == null ? '' : tb[i];
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return parseInt(x, 10) - parseInt(y, 10);
    return x < y ? -1 : 1;
  }
  return 0;
}

function detectarColumnas(encabezados, mapa, respaldo) {
  const norm = encabezados.map(function (h) { return normalizar(h); });
  const cols = {};
  Object.keys(mapa).forEach(function (campo) {
    const candidatos = mapa[campo].map(function (c) { return normalizar(c); }).filter(function (c) { return c !== ''; });
    cols[campo] = respaldo[campo] || 1;
    let indice = -1;
    for (let i = 0; i < norm.length; i++) {
      if (norm[i] !== '' && candidatos.indexOf(norm[i]) !== -1) { indice = i; break; }
    }
    if (indice === -1) {
      for (let i = 0; i < norm.length; i++) {
        const h = norm[i];
        if (h === '') continue;
        for (let j = 0; j < candidatos.length; j++) {
          const c = candidatos[j];
          if (c.length >= 4 && (h.indexOf(c) !== -1 || (h.length >= 4 && c.indexOf(h) !== -1))) { indice = i; break; }
        }
        if (indice !== -1) break;
      }
    }
    if (indice !== -1) cols[campo] = indice + 1;
  });
  return cols;
}

function encabezadoEs(encabezados, colIdx, candidatos) {
  const h = normalizar(encabezados[colIdx]);
  if (!h) return false;
  return candidatos.some(function (c) { return normalizar(c) === h; });
}

function fechaLegible(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm');
  const s = limpiar(v);
  return (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s) || /\d{4}-\d{2}-\d{2}/.test(s)) ? s : '';
}

function leerHoja(hoja) {
  const rango = hoja.getDataRange();
  const valores = rango.getValues();
  const mostrados = rango.getDisplayValues();
  return valores.map(function (fila, i) {
    return fila.map(function (v, j) {
      const d = String(mostrados[i] && mostrados[i][j] != null ? mostrados[i][j] : '').trim();
      return (d !== '' && d.charAt(0) !== '#') ? d : v;
    });
  });
}

function invalidarCaches() {
  CACHE_IIEES = null;
  CACHE_RUTAS_CANONICAS = null;
  CACHE_ASIGNACIONES = null;
  CACHE_RESOLUTOR = null;
  CACHE_OBSERVACIONES = null;
  CACHE_INFO_CARGAS = null;
  CACHE_TRAMITADORES = null;
  limpiarCacheDatos();
}

/* ============================================================
 * CACHÉ ENTRE EJECUCIONES (CacheService)
 * Reduce drásticamente las lecturas de la hoja de cálculo: los datos
 * leídos se comparten entre TODAS las ejecuciones durante 15 minutos.
 * (Antes, cada búsqueda de cada usuario releía las hojas completas.)
 * ============================================================ */
const _CHUNK_B64 = 90000; // CacheService admite ~100 KB por valor

function cachePutJSON(prefijo, obj) {
  try {
    const b64 = Utilities.base64Encode(JSON.stringify(obj), Utilities.Charset.UTF_8);
    const n = Math.ceil(b64.length / _CHUNK_B64) || 1;
    if (n > 40) return; // demasiado grande para cachear: se lee de la hoja
    const cache = CacheService.getScriptCache();
    cache.put(prefijo + '_N', String(n), CONFIG.TTL_CACHE_DATOS_SEG);
    for (let i = 0; i < n; i++) {
      cache.put(prefijo + '_' + i, b64.substr(i * _CHUNK_B64, _CHUNK_B64), CONFIG.TTL_CACHE_DATOS_SEG);
    }
  } catch (e) {}
}

function cacheGetJSON(prefijo) {
  try {
    const cache = CacheService.getScriptCache();
    const meta = cache.get(prefijo + '_N');
    if (!meta) return null;
    const n = Number(meta);
    if (!n || n < 1 || n > 40) return null;
    const partes = [];
    for (let i = 0; i < n; i++) {
      const p = cache.get(prefijo + '_' + i);
      if (p == null) return null;
      partes.push(p);
    }
    return JSON.parse(Utilities.newBlob(Utilities.base64Decode(partes.join(''))).getDataAsString('UTF-8'));
  } catch (e) { return null; }
}

// Limpia la caché compartida. Debe llamarse tras CUALQUIER escritura en las hojas.
function limpiarCacheDatos() {
  try {
    const cache = CacheService.getScriptCache();
    const prefijos = ['IIEES', 'TRAM', 'OBS', 'PERSONAL', 'RUTAS', 'SIGO'];
    prefijos.forEach(function (p) {
      const n = Number(cache.get(p + '_N') || 0);
      const aEliminar = [p + '_N', p + '_0', p + '_1', p + '_2', p + '_3', p + '_4'];
      for (let i = 5; i < n; i++) aEliminar.push(p + '_' + i);
      cache.removeAll(aEliminar);
    });
  } catch (e) {}
}

/* ============================================================
 * RATE LIMITING (anti-abuso)
 * Contadores por ventana de tiempo en CacheService. Si se supera el
 * límite, se rechaza la petición con un mensaje amable. Esto evita que
 * ráfagas de peticiones (humanas o de bots) agoten las cuotas y hagan
 * que Google interprete la app como un bot.
 * ============================================================ */
function _incrementarContador(clave, ttlSeg) {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(clave) || 0) + 1;
    cache.put(clave, String(n), ttlSeg);
    return n;
  } catch (e) { return 1; } // si la caché falla, no bloqueamos a los usuarios
}

function permitirPeticion(tipo, sid) {
  const s = String(sid == null ? '' : sid).replace(/[^A-Za-z0-9_-]/g, '').substring(0, 40);
  const t = Math.floor(Date.now() / 1000);
  const minuto = Math.floor(t / 60);
  const diezMin = Math.floor(t / 600);
  const controles = [];

  if (tipo === 'BUSQUEDA') {
    controles.push(['RL_G_BUSQ_' + minuto, CONFIG.MAX_BUSQUEDAS_GLOBAL_POR_MIN, 65]);
    if (s) controles.push(['RL_S_BUSQ_' + s + '_' + minuto, CONFIG.MAX_BUSQUEDAS_POR_MIN, 65]);
  } else if (tipo === 'DNI') {
    controles.push(['RL_G_DNI_' + minuto, CONFIG.MAX_DNIS_GLOBAL_POR_MIN, 65]);
    if (s) controles.push(['RL_S_DNI_' + s + '_' + minuto, CONFIG.MAX_DNIS_POR_MIN, 65]);
  } else if (tipo === 'CARGA') {
    controles.push(['RL_G_CARGA_' + minuto, CONFIG.MAX_CARGAS_GLOBAL_POR_MIN, 65]);
    if (s) controles.push(['RL_S_CARGA_' + s + '_' + diezMin, CONFIG.MAX_CARGAS_POR_10MIN, 605]);
  } else if (tipo === 'CARGO') {
    controles.push(['RL_G_CARGO_' + diezMin, CONFIG.MAX_CARGOS_GLOBAL_POR_10MIN, 605]);
    if (s) controles.push(['RL_S_CARGO_' + s + '_' + diezMin, CONFIG.MAX_CARGOS_POR_10MIN, 605]);
  } else if (tipo === 'ADMIN') {
    controles.push(['RL_G_ADMIN_' + minuto, CONFIG.MAX_INTENTOS_ADMIN_GLOBAL_POR_MIN, 65]);
    if (s) controles.push(['RL_S_ADMIN_' + s + '_' + minuto, CONFIG.MAX_INTENTOS_ADMIN_POR_MIN, 65]);
  } else if (tipo === 'SIGO') {
    controles.push(['RL_G_SIGO_' + minuto, CONFIG.MAX_MARCAS_GLOBAL_POR_MIN, 65]);
    if (s) controles.push(['RL_S_SIGO_' + s + '_' + diezMin, CONFIG.MAX_MARCAS_POR_10MIN, 605]);
  }

  for (let i = 0; i < controles.length; i++) {
    if (_incrementarContador(controles[i][0], controles[i][2]) > controles[i][1]) return false;
  }
  return true;
}

const MENSAJES_LIMITE = {
  BUSQUEDA: 'Se alcanzó el máximo de búsquedas por minuto. Espere unos segundos e inténtelo de nuevo.',
  DNI: 'Se alcanzó el máximo de consultas por minuto. Espere unos segundos e inténtelo de nuevo.',
  CARGA: 'El sistema está procesando varias cargas en este momento. Espere unos minutos e inténtelo nuevamente.',
  CARGO: 'Se alcanzó el máximo de cargos generados por ahora. Espere unos minutos e inténtelo nuevamente.',
  ADMIN: 'Demasiados intentos. Espere un minuto e inténtelo de nuevo.',
  SIGO: 'Se alcanzó el máximo de marcas por minuto. Espere unos segundos e inténtelo de nuevo.'
};

/* ============================================================
 * reCAPTCHA v3 — verificación en el servidor
 * El frontend (Index.html) obtiene un token invisible; aquí se valida
 * contra Google. Con claves vacías queda desactivado (modo degradado).
 * ============================================================ */
function verificarRecaptcha(token, accion) {
  const secreto = CONFIG.RECAPTCHA_SECRET_KEY;
  if (!secreto) return { ok: true, omitido: true }; // sin clave secreta: desactivada
  if (!token) {
    return { ok: !CONFIG.RECAPTCHA_BLOQUEAR, mensaje: 'Falta la verificación de seguridad (reCAPTCHA). Recargue la página e inténtelo de nuevo.' };
  }
  try {
    const resp = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'post',
      payload: { secret: secreto, response: String(token) },
      muteHttpExceptions: true
    });
    const data = JSON.parse(resp.getContentText() || '{}');
    if (data.success) {
      if (accion && data.action && data.action !== accion) {
        return { ok: !CONFIG.RECAPTCHA_BLOQUEAR, mensaje: 'Verificación reCAPTCHA no válida.' };
      }
      if (typeof data.score === 'number' && data.score < CONFIG.RECAPTCHA_MIN_SCORE) {
        console.warn('reCAPTCHA puntaje bajo: ' + data.score);
        return { ok: !CONFIG.RECAPTCHA_BLOQUEAR, mensaje: 'La actividad parece automatizada. Si usted es una persona, inténtelo de nuevo.' };
      }
      return { ok: true };
    }
    console.error('reCAPTCHA falló: ' + resp.getContentText());
    return { ok: !CONFIG.RECAPTCHA_BLOQUEAR, mensaje: 'Verificación reCAPTCHA fallida. Inténtelo de nuevo en unos segundos.' };
  } catch (e) {
    // Ante un error de red en la verificación, no penalizamos al usuario real
    console.error('reCAPTCHA error: ' + e);
    return { ok: true, error: String(e) };
  }
}

/* ============================================================
 * CONTROL DE CORREOS (evita bloqueo por envío masivo)
 * - Respeta la cuota diaria real de MailApp (getRemainingDailyQuota)
 * - Tope diario y ritmo por minuto configurables en CONFIG
 * - Registra envíos y omisiones en la hoja LOG_CORREOS
 * ============================================================ */
function puedeEnviarCorreo() {
  if (!CONFIG.ENVIAR_CORREOS) return { ok: false, motivo: 'Envío de correos desactivado en CONFIG.' };
  try {
    const restante = MailApp.getRemainingDailyQuota();
    if (restante <= CONFIG.RESERVA_CUOTA_CORREO) {
      return { ok: false, motivo: 'Cuota diaria de correo agotada (quedan ' + restante + ').' };
    }
  } catch (e) {}
  try {
    const props = PropertiesService.getScriptProperties();
    const claveDia = 'CORREOS_' + Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'yyyyMMdd');
    if (Number(props.getProperty(claveDia) || 0) >= CONFIG.MAX_CORREOS_DIA) {
      return { ok: false, motivo: 'Se alcanzó el tope diario de ' + CONFIG.MAX_CORREOS_DIA + ' correos.' };
    }
  } catch (e) {}
  const minuto = Math.floor(Date.now() / 60000);
  if (_incrementarContador('CORREO_M_' + minuto, 65) > CONFIG.MAX_CORREOS_POR_MINUTO) {
    return { ok: false, motivo: 'Se alcanzó el ritmo máximo de ' + CONFIG.MAX_CORREOS_POR_MINUTO + ' correos por minuto.' };
  }
  return { ok: true };
}

function registrarCorreoEnviado() {
  try {
    const props = PropertiesService.getScriptProperties();
    const claveDia = 'CORREOS_' + Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'yyyyMMdd');
    props.setProperty(claveDia, String(Number(props.getProperty(claveDia) || 0) + 1));
  } catch (e) {}
}

function registrarLogCorreo(tipo, destinatario, estado, detalle) {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    let hoja = ss.getSheetByName(CONFIG.HOJA_LOG_CORREOS);
    if (!hoja) {
      hoja = ss.insertSheet(CONFIG.HOJA_LOG_CORREOS);
      hoja.getRange(1, 1, 1, 5).setValues([['FECHA', 'TIPO', 'DESTINATARIO', 'ESTADO', 'DETALLE']]).setFontWeight('bold');
      hoja.setFrozenRows(1);
    }
    hoja.appendRow([
      Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm:ss'),
      tipo, String(destinatario || ''), estado, String(detalle || '')
    ]);
  } catch (e) { console.error('registrarLogCorreo: ' + e); }
}

/* ============================================================
 * CLAVE DE ADMINISTRADOR
 * Puede sobreescribirse sin tocar el código: guarde la propiedad
 * CLAVE_ADMIN en Archivo > Propiedades del proyecto (recomendado).
 * También limita los intentos (anti fuerza bruta).
 * ============================================================ */
function validarClaveAdmin(clave, sid) {
  if (!permitirPeticion('ADMIN', sid)) return { ok: false, mensaje: MENSAJES_LIMITE.ADMIN };
  let claveReal = CONFIG.CLAVE_ADMIN;
  try {
    const guardada = PropertiesService.getScriptProperties().getProperty('CLAVE_ADMIN');
    if (guardada) claveReal = guardada;
  } catch (e) {}
  if (String(clave || '') !== claveReal) return { ok: false, mensaje: 'Contraseña incorrecta.' };
  return { ok: true };
}

/* ============================================================
 * LOGO CACHÉ (evita UrlFetchApp en cada PDF generado)
 * Nivel 1: variable de ejecución · Nivel 2: CacheService (6 h)
 * Solo descarga de nuevo si no hay ninguna caché disponible.
 * ============================================================ */
let _LOGO_B64 = null;
function obtenerLogoBase64() {
  if (_LOGO_B64) return _LOGO_B64;
  try {
    const b64 = CacheService.getScriptCache().get('LOGO_PAE_B64');
    if (b64) { _LOGO_B64 = b64; return b64; }
  } catch (e) {}
  try {
    const resp = UrlFetchApp.fetch(CONFIG.LOGO_URL, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      const b64 = Utilities.base64Encode(resp.getBlob().getBytes());
      _LOGO_B64 = b64;
      try { if (b64.length < 95000) CacheService.getScriptCache().put('LOGO_PAE_B64', b64, CONFIG.TTL_CACHE_LOGO_SEG); } catch (e2) {}
      return b64;
    }
  } catch (e) { console.error('obtenerLogoBase64: ' + e); }
  return '';
}

// ==================== HOJA IIEES ====================
let CACHE_IIEES = null;

function leerIIEES() {
  if (CACHE_IIEES) return CACHE_IIEES;
  const cacheado = cacheGetJSON('IIEES');
  if (cacheado && cacheado.valores && cacheado.col) { CACHE_IIEES = cacheado; return CACHE_IIEES; }
  const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
  const hoja = ss.getSheetByName(CONFIG.HOJA_IIEES);
  if (!hoja) throw new Error('No se encontró la hoja ' + CONFIG.HOJA_IIEES + '.');
  const filas = leerHoja(hoja);
  if (filas.length < 2) throw new Error('La hoja ' + CONFIG.HOJA_IIEES + ' no tiene datos.');
  const col = detectarColumnas(filas[0], MAPA_IIEES, RESPALDO_IIEES);
  CACHE_IIEES = { valores: filas, col: col };
  cachePutJSON('IIEES', CACHE_IIEES);
  return CACHE_IIEES;
}

function extraerIIEE(fila, col) {
  return {
    codMod: limpiar(fila[col.COD_MOD - 1]),
    nombre: limpiar(fila[col.NOMBRE - 1]),
    nivel: limpiar(fila[col.NIVEL - 1]),
    provincia: limpiar(fila[col.PROVINCIA - 1]),
    distrito: limpiar(fila[col.DISTRITO - 1]),
    centroPoblado: limpiar(fila[col.CENTRO_POBLADO - 1]),
    codRuta: limpiar(fila[col.COD_RUTA - 1]),
    codPersonal: limpiar(fila[col.COD_PERSONAL - 1])
  };
}

let CACHE_RUTAS_CANONICAS = null;
function obtenerRutasCanonicas() {
  if (CACHE_RUTAS_CANONICAS) return CACHE_RUTAS_CANONICAS;
  const cacheado = cacheGetJSON('RUTAS');
  if (cacheado) { CACHE_RUTAS_CANONICAS = cacheado; return CACHE_RUTAS_CANONICAS; }
  const datos = leerIIEES();
  const v = datos.valores, col = datos.col;
  const conteo = {};
  for (let i = 1; i < v.length; i++) {
    const ruta = limpiar(v[i][col.COD_RUTA - 1]);
    if (!ruta) continue;
    const k = claveRuta(ruta);
    if (!k) continue;
    if (!conteo[k]) conteo[k] = {};
    conteo[k][ruta] = (conteo[k][ruta] || 0) + 1;
  }
  const mapa = {};
  Object.keys(conteo).forEach(function (k) {
    const formas = Object.keys(conteo[k]);
    formas.sort(function (a, b) {
      return (conteo[k][b] - conteo[k][a]) || (b.length - a.length) || (a < b ? -1 : 1);
    });
    mapa[k] = formas[0];
  });
  CACHE_RUTAS_CANONICAS = mapa;
  cachePutJSON('RUTAS', mapa);
  return mapa;
}

function obtenerRutasDisponibles() {
  const canon = obtenerRutasCanonicas();
  const datos = leerIIEES();
  const conteo = {};
  for (let i = 1; i < datos.valores.length; i++) {
    const k = claveRuta(datos.valores[i][datos.col.COD_RUTA - 1]);
    if (k) conteo[k] = (conteo[k] || 0) + 1;
  }
  const vistas = {};
  const lista = [];
  try {
    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hoja = ss.getSheetByName(CONFIG.HOJA_RUTA);
    if (hoja && hoja.getLastRow() > 1) {
      const filas = leerHoja(hoja);
      const col = detectarColumnas(filas[0], MAPA_RUTA, RESPALDO_RUTA);
      let colRuta = (col.RUTA || 2) - 1;
      if (colRuta < 0) colRuta = 1;
      for (let i = 1; i < filas.length; i++) {
        const ruta = limpiar(filas[i][colRuta]);
        const k = claveRuta(ruta);
        if (!k || vistas[k]) continue;
        vistas[k] = true;
        lista.push({ ruta: canon[k] || ruta, total: conteo[k] || 0 });
      }
    }
  } catch (e) {}
  Object.keys(canon).forEach(function (k) {
    if (vistas[k]) return;
    vistas[k] = true;
    lista.push({ ruta: canon[k], total: conteo[k] || 0 });
  });
  lista.sort(function (a, b) { return compararRutasNatural(a.ruta, b.ruta); });
  return lista;
}

// ==================== BÚSQUEDA DE IIEE ====================
// Resultados con estado: cargado / observado (+info del personal PAE y del archivo)
function buscarIIEE(consulta, sid) {
  // Rate limiting: protege las cuotas si muchos usuarios (o bots) buscan a la vez
  if (!permitirPeticion('BUSQUEDA', sid)) {
    return { lista: [], total: 0, limitado: true, mensaje: MENSAJES_LIMITE.BUSQUEDA };
  }
  const q = normalizar(consulta);
  if (!q) return { lista: [], total: 0 };
  const qSinCeros = q.replace(/^0+/, '');
  const qRuta = claveRuta(consulta);
  const datos = leerIIEES();
  const v = datos.valores, col = datos.col;
  const encontrados = [];
  for (let i = 1; i < v.length; i++) {
    const iiee = extraerIIEE(v[i], col);
    if (!iiee.codMod && !iiee.nombre) continue;
    const nCod = normalizar(iiee.codMod);
    const nNombre = normalizar(iiee.nombre);
    const nRuta = claveRuta(iiee.codRuta);
    let prioridad = 0;
    if (nCod === q || (qSinCeros && nCod.replace(/^0+/, '') === qSinCeros)) prioridad = 1;
    else if (q.length >= 4 && (nCod.indexOf(q) === 0 || nCod.replace(/^0+/, '').indexOf(qSinCeros) === 0)) prioridad = 2;
    else if (nNombre.indexOf(q) !== -1 ||
             (qRuta && nRuta && (nRuta === qRuta ||
               (qRuta.length >= 2 && nRuta.length >= 2 && (nRuta.indexOf(qRuta) !== -1 || qRuta.indexOf(nRuta) !== -1))))) prioridad = 3;
    if (prioridad > 0) { iiee.prioridad = prioridad; encontrados.push(iiee); }
  }
  encontrados.sort(function (a, b) {
    return a.prioridad - b.prioridad || String(a.nombre).localeCompare(String(b.nombre));
  });

  const lista = encontrados.slice(0, CONFIG.MAX_RESULTADOS);
  try {
    const info = obtenerInfoCargas();
    lista.forEach(function (iiee) {
      const k = claveCodMod(iiee.codMod);
      iiee.cargado = !!info.cargados[k];
      if (iiee.cargado) {
        const arch = info.archivos[k];
        iiee.archivoUrl = (arch && arch.url) || '';
        const o = info.observados[k];
        const mSigo = info.sigo && info.sigo[k] && !(arch && arch.url);
        iiee.sigo = !!mSigo;
        if (mSigo) { iiee.sigoPor = info.sigo[k].personal || ''; iiee.sigoFecha = info.sigo[k].fecha || ''; }
        iiee.observado = !!o;
        if (o) {
          iiee.observacionComentario = o.comentario || '';
          iiee.observacionFecha = o.fecha || '';
          iiee.observacionPersonal = o.personal || '';
        }
      } else {
        iiee.observado = false;
      }
      if (iiee.codPersonal) {
        const inf = infoDeCodigoPersonal(iiee.codPersonal);
        if (inf) {
          iiee.personalNombre = inf.nombre || '';
          iiee.personalCelular = inf.celular || '';
        }
      }
    });
  } catch (e) { console.error('buscarIIEE decorar: ' + e); }
  return { lista: lista, total: encontrados.length };
}

function obtenerIIEEPorCodMod(codMod, nombreIIEE) {
  const datos = leerIIEES();
  const v = datos.valores, col = datos.col;
  const objetivo = claveCodMod(codMod);
  const nombreBuscado = normalizar(nombreIIEE);
  let primera = null;
  for (let i = 1; i < v.length; i++) {
    const iiee = extraerIIEE(v[i], col);
    if (objetivo && claveCodMod(iiee.codMod) === objetivo) {
      if (!primera) primera = iiee;
      if (nombreBuscado && normalizar(iiee.nombre) === nombreBuscado) return iiee;
    }
  }
  return primera;
}

function obtenerIIEEsPorRuta(codRuta) {
  const objetivo = claveRuta(codRuta);
  if (!objetivo) return [];
  const datos = leerIIEES();
  const v = datos.valores, col = datos.col;
  const canonicas = obtenerRutasCanonicas();
  const nombreOficial = canonicas[objetivo] || limpiar(codRuta);
  const lista = [];
  for (let i = 1; i < v.length; i++) {
    if (claveRuta(v[i][col.COD_RUTA - 1]) === objetivo) {
      const iiee = extraerIIEE(v[i], col);
      iiee.codRuta = nombreOficial;
      lista.push(iiee);
    }
  }
  lista.sort(function (a, b) { return String(a.nombre).localeCompare(String(b.nombre)); });
  return lista;
}

// ==================== ESTADO DE CARGAS (Drive + TRAMITADOR + OBSERVACIONES) ====================
function validarColumnasTramitador(valores, col) {
  const setCodMods = {};
  try {
    const d = leerIIEES();
    for (let i = 1; i < d.valores.length; i++) {
      const k = claveCodMod(d.valores[i][d.col.COD_MOD - 1]);
      if (k) setCodMods[k] = true;
    }
  } catch (e) {}

  let colCodMod = (col.COD_MOD || 5) - 1, mejor = 0;
  for (let j = 0; j < valores[0].length; j++) {
    let aciertos = 0;
    for (let i = 1; i < valores.length; i++) {
      const k = claveCodMod(valores[i][j]);
      if (k && setCodMods[k]) aciertos++;
    }
    if (aciertos > mejor) { mejor = aciertos; colCodMod = j; }
  }

  let colFecha = (col.FECHA || 1) - 1, mejorF = 0;
  for (let j = 0; j < valores[0].length; j++) {
    let fechas = 0;
    for (let i = 1; i < valores.length; i++) {
      if (fechaLegible(valores[i][j])) fechas++;
    }
    if (fechas > mejorF) { mejorF = fechas; colFecha = j; }
  }

  let colUrl = (col.URL || 12) - 1, mejorU = 0;
  for (let j = 0; j < valores[0].length; j++) {
    let enlaces = 0;
    for (let i = 1; i < valores.length; i++) {
      const s = String(valores[i][j] || '').trim();
      if (/^https?:\/\//i.test(s) || /^[-A-Za-z0-9_]{25,}$/.test(s)) enlaces++;
    }
    if (enlaces > mejorU) { mejorU = enlaces; colUrl = j; }
  }
  return { colCodMod: colCodMod, colFecha: colFecha, colUrl: colUrl };
}

let CACHE_TRAMITADORES = null;

function leerTramitadores() {
  if (CACHE_TRAMITADORES) return CACHE_TRAMITADORES;
  const cacheado = cacheGetJSON('TRAM');
  if (cacheado && Array.isArray(cacheado)) { CACHE_TRAMITADORES = cacheado; return CACHE_TRAMITADORES; }
  const registros = [];
  try {
    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hoja = ss.getSheetByName(CONFIG.HOJA_TRAMITADOR);
    if (hoja && hoja.getLastRow() > 1) {
      const filas = leerHoja(hoja);
      const col = detectarColumnas(filas[0], MAPA_TRAMITADOR, RESPALDO_TRAMITADOR);
      const v = validarColumnasTramitador(filas, col);
      for (let i = 1; i < filas.length; i++) {
        const fila = filas[i];
        const k = claveCodMod(fila[v.colCodMod]);
        if (!k) continue;
        let url = '';
        const bruto = String(fila[v.colUrl] || '').trim();
        if (/^https?:\/\//i.test(bruto)) url = bruto;
        else if (/^[-A-Za-z0-9_]{25,}$/.test(bruto)) url = 'https://drive.google.com/file/d/' + bruto + '/view?usp=sharing';
        const item = normalizar(fila[0]);
        registros.push({
          item: /^\d{1,6}$/.test(item) ? item : '',
          codMod: k,
          apellidos: limpiar(fila[(col.APELLIDOS || 2) - 1]),
          celular: limpiar(fila[(col.CELULAR || 3) - 1]),
          correo: limpiar(fila[(col.CORREO || 4) - 1]),
          fecha: fechaLegible(fila[v.colFecha]),
          archivo: limpiar(fila[(col.ARCHIVO || 11) - 1]),
          url: url
        });
      }
    }
  } catch (e) { console.error('leerTramitadores: ' + e); }
  CACHE_TRAMITADORES = registros;
  cachePutJSON('TRAM', registros);
  return registros;
}

function obtenerUltimosTramitadores() {
  const mapa = {};
  leerTramitadores().forEach(function (r) { mapa[r.codMod] = r; });
  return mapa;
}

// FUENTE DE VERDAD: la hoja TRAMITADOR. Una IIEE está CARGADA si existe un
// registro de carga con URL en esa hoja. OBSERVADA = cargada + observación abierta.
// YA NO SE ESCANEA DRIVE: antes, cada búsqueda recorría archivo por archivo con
// DriveApp y, al entrar varios usuarios a la vez, generaba miles de llamadas por
// minuto a la API de Drive, lo que Google interpretó como tráfico de bot.
let CACHE_INFO_CARGAS = null;
function obtenerInfoCargas() {
  if (CACHE_INFO_CARGAS) return CACHE_INFO_CARGAS;

  const tramitadores = obtenerUltimosTramitadores(); // { codMod: último registro }
  const cargados = {};
  const archivos = {};
  Object.keys(tramitadores).forEach(function (k) {
    const t = tramitadores[k];
    if (!t) return;
    cargados[k] = true;
    archivos[k] = { url: t.url || '', nombre: t.archivo || '', actualizado: 0 };
  });

  // Marcas "FORMATO CARGADO AL SIGO" del personal PAE: también cuentan como
  // ATENDIDAS (sin archivo en la web). El detalle queda en el mapa `sigo`.
  const sigo = leerMarcasSIGO().activas;
  Object.keys(sigo).forEach(function (k) { if (!cargados[k]) cargados[k] = true; });

  const observados = leerObservaciones().abiertas;

  CACHE_INFO_CARGAS = { cargados: cargados, archivos: archivos, tramitadores: tramitadores, observados: observados, sigo: sigo };
  return CACHE_INFO_CARGAS;
}

/**
 * [OPCIONAL — EJECUTAR UNA SOLA VEZ Y MANUALMENTE DESDE EL EDITOR]
 * sincronizarLegadoUnaVez(): recorre UNA sola vez las carpetas de Drive
 * configuradas y registra en la hoja TRAMITADOR los archivos CAE_ que existan
 * en Drive pero que no figuren en la hoja (p. ej. cargas antiguas), para que
 * la hoja quede como única fuente de verdad.
 * Puede tardar varios minutos si hay muchos archivos. Ejecutar una sola vez.
 */
function sincronizarLegadoUnaVez() {
  const existentes = {};
  leerTramitadores().forEach(function (r) { existentes[r.codMod] = true; });

  const ides = [CONFIG.ID_CARPETA_DRIVE, CONFIG.ID_CARPETA_LEGADO];
  let creados = 0;
  ides.forEach(function (idCarpeta) {
    if (!idCarpeta) return;
    const escanear = function (carpeta) {
      const it = carpeta.getFiles();
      while (it.hasNext()) {
        const f = it.next();
        const nombre = String(f.getName()).trim();
        const m = /^CAE_?(\d{2,10})/i.exec(nombre);
        if (!m) continue;
        for (let len = Math.min(m[1].length, 8); len >= 5; len--) {
          const iiee = obtenerIIEEPorCodMod(m[1].substring(0, len), '');
          if (iiee) {
            const k = claveCodMod(iiee.codMod);
            if (!existentes[k]) {
              existentes[k] = true;
              let fecha = '';
              try { fecha = Utilities.formatDate(f.getLastUpdated(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm:ss'); } catch (e2) {}
              registrarEnTramitador(
                { apellidos: '(REGISTRO MIGRADO)', celular: '', correo: '' },
                iiee, nombre, f.getUrl(), fecha
              );
              creados++;
            }
            break;
          }
        }
      }
      const sub = carpeta.getFolders();
      while (sub.hasNext()) escanear(sub.next());
    };
    try { escanear(DriveApp.getFolderById(idCarpeta)); } catch (e) { console.error('Legado ' + idCarpeta + ': ' + e); }
  });
  limpiarCacheDatos();
  Logger.log('Sincronización terminada. Registros creados en TRAMITADOR: ' + creados);
}

// ==================== RESOLUTOR DE PERSONAL ====================
let CACHE_RESOLUTOR = null;
function obtenerResolutorPersonal() {
  if (CACHE_RESOLUTOR) return CACHE_RESOLUTOR;
  const cacheado = cacheGetJSON('PERSONAL');
  if (cacheado && cacheado.porCodigo && cacheado.infoPorCodigo) { CACHE_RESOLUTOR = cacheado; return CACHE_RESOLUTOR; }
  const porCodigo = {};
  const infoPorCodigo = {};
  try {
    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hoja = ss.getSheetByName(CONFIG.HOJA_PERSONAL);
    if (hoja && hoja.getLastRow() > 1) {
      const filas = leerHoja(hoja);
      const col = detectarColumnas(filas[0], MAPA_PERSONAL, RESPALDO_PERSONAL);
      const porCelular = {};
      const porNombre = {};
      for (let i = 1; i < filas.length; i++) {
        const dni = dniDeFila(filas[i], col);
        const nombre = nombreCompletoPersonal(filas[0], filas[i], col);
        const celular = celularDeFila(filas[i], col);
        const item = normalizar(filas[i][0]);
        const info = { dni: dni, nombre: nombre, celular: celular };
        if (/^\d{1,6}$/.test(item)) {
          infoPorCodigo[item] = info;
          infoPorCodigo[item.replace(/^0+/, '')] = info;
          if (dni) { porCodigo[item] = dni; porCodigo[item.replace(/^0+/, '')] = dni; }
        }
        if (dni) { infoPorCodigo[dni] = info; porCodigo[dni] = dni; }
        if (nombre) porNombre[normalizar(nombre)] = info;
        if (celular) porCelular[celular] = info;
      }
      leerTramitadores().forEach(function (t) {
        if (!t.item) return;
        const cel = normalizar(t.celular);
        let info = (cel && porCelular[cel]) || null;
        if (!info && t.apellidos) info = porNombre[normalizar(t.apellidos)] || null;
        if (info) {
          infoPorCodigo[t.item] = info;
          infoPorCodigo[t.item.replace(/^0+/, '')] = info;
          if (info.dni) { porCodigo[t.item] = info.dni; porCodigo[t.item.replace(/^0+/, '')] = info.dni; }
        }
      });
    }
  } catch (e) { console.error('obtenerResolutorPersonal: ' + e); }
  CACHE_RESOLUTOR = { porCodigo: porCodigo, infoPorCodigo: infoPorCodigo };
  cachePutJSON('PERSONAL', CACHE_RESOLUTOR);
  return CACHE_RESOLUTOR;
}

function dniDeCodigoPersonal(codPersonal) {
  const cp = normalizar(codPersonal);
  if (!cp) return '';
  const r = obtenerResolutorPersonal();
  return r.porCodigo[cp] || r.porCodigo[cp.replace(/^0+/, '')] || '';
}

function infoDeCodigoPersonal(codPersonal) {
  const cp = normalizar(codPersonal);
  if (!cp) return null;
  const r = obtenerResolutorPersonal();
  return r.infoPorCodigo[cp] || r.infoPorCodigo[cp.replace(/^0+/, '')] || null;
}

// ==================== HOJA OBSERVACIONES ====================
function obtenerOcrearHojaObservaciones(ss) {
  let hoja = ss.getSheetByName(CONFIG.HOJA_OBSERVACIONES);
  if (!hoja) hoja = ss.insertSheet(CONFIG.HOJA_OBSERVACIONES);
  if (hoja.getLastRow() === 0) {
    const enc = ['FECHA', 'COD. MODULAR', 'NOMBRE IIEE', 'COD. RUTA', 'DNI PERSONAL', 'PERSONAL QUE OBSERVÓ', 'CELULAR PERSONAL', 'COMENTARIO', 'ESTADO', 'FECHA RESUBIDA'];
    hoja.getRange(1, 1, 1, enc.length).setValues([enc]);
    hoja.getRange(1, 1, 1, enc.length).setFontWeight('bold');
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Observaciones ABIERTAS (ESTADO='OBSERVADO'): codMod → {fecha, comentario, personal, celular, dni}
let CACHE_OBSERVACIONES = null;
function leerObservaciones() {
  if (CACHE_OBSERVACIONES) return CACHE_OBSERVACIONES;
  const cacheado = cacheGetJSON('OBS');
  if (cacheado && cacheado.abiertas) { CACHE_OBSERVACIONES = cacheado; return CACHE_OBSERVACIONES; }
  const abiertas = {};
  try {
    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hoja = ss.getSheetByName(CONFIG.HOJA_OBSERVACIONES);
    if (hoja && hoja.getLastRow() > 1) {
      const filas = leerHoja(hoja);
      for (let i = 1; i < filas.length; i++) {
        const f = filas[i];
        const k = claveCodMod(f[OBS_COL.COD_MOD - 1]);
        if (!k) continue;
        if (normalizar(f[OBS_COL.ESTADO - 1]) !== 'OBSERVADO') continue;
        abiertas[k] = {
          fecha: fechaLegible(f[OBS_COL.FECHA - 1]) || limpiar(f[OBS_COL.FECHA - 1]),
          comentario: limpiar(f[OBS_COL.COMENTARIO - 1]),
          personal: limpiar(f[OBS_COL.PERSONAL - 1]),
          celularPersonal: limpiar(f[OBS_COL.CELULAR - 1]),
          dniPersonal: normalizar(f[OBS_COL.DNI - 1])
        };
      }
    }
  } catch (e) { console.error('leerObservaciones: ' + e); }
  CACHE_OBSERVACIONES = { abiertas: abiertas };
  cachePutJSON('OBS', CACHE_OBSERVACIONES);
  return CACHE_OBSERVACIONES;
}

// ==================== MARCA "FORMATO CARGADO AL SIGO" ====================
/* El personal PAE (módulo DNI) puede marcar una IIEE SIN archivo en la web como
 * "Formato cargado al SIGO" cuando el tramitador no pudo subir el archivo pero
 * el formato ya fue procesado. Efecto:
 *  - La IIEE se considera ATENDIDA en todos los reportes y tableros.
 *  - Queda bloqueada para la carga web (el personal puede retirar la marca).
 *  - Si el tramitador sube su archivo, la carga web tiene precedencia. */

function obtenerOcrearHojaSIGO(ss) {
  let hoja = ss.getSheetByName(CONFIG.HOJA_SIGO);
  if (!hoja) hoja = ss.insertSheet(CONFIG.HOJA_SIGO);
  if (hoja.getLastRow() === 0) {
    const enc = ['FECHA', 'COD. MODULAR', 'NOMBRE IIEE', 'COD. RUTA', 'DNI PERSONAL', 'PERSONAL', 'ESTADO'];
    hoja.getRange(1, 1, 1, enc.length).setValues([enc]);
    hoja.getRange(1, 1, 1, enc.length).setFontWeight('bold');
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Marcas ACTIVAS (ESTADO='SIGO'): codMod → {fecha, personal, dni, nombre, ruta}
let CACHE_SIGO = null;
function leerMarcasSIGO() {
  if (CACHE_SIGO) return CACHE_SIGO;
  const cacheado = cacheGetJSON('SIGO');
  if (cacheado && cacheado.activas) { CACHE_SIGO = cacheado; return CACHE_SIGO; }
  const activas = {};
  try {
    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hoja = ss.getSheetByName(CONFIG.HOJA_SIGO);
    if (hoja && hoja.getLastRow() > 1) {
      const filas = leerHoja(hoja);
      for (let i = 1; i < filas.length; i++) {
        const f = filas[i];
        const k = claveCodMod(f[SIGO_COL.COD_MOD - 1]);
        if (!k) continue;
        if (normalizar(f[SIGO_COL.ESTADO - 1]) !== 'SIGO') continue;
        activas[k] = {
          fecha: fechaLegible(f[SIGO_COL.FECHA - 1]) || limpiar(f[SIGO_COL.FECHA - 1]),
          personal: limpiar(f[SIGO_COL.PERSONAL - 1]),
          dni: normalizar(f[SIGO_COL.DNI - 1]),
          nombre: limpiar(f[SIGO_COL.NOMBRE - 1]),
          ruta: limpiar(f[SIGO_COL.RUTA - 1])
        };
      }
    }
  } catch (e) { console.error('leerMarcasSIGO: ' + e); }
  CACHE_SIGO = { activas: activas };
  cachePutJSON('SIGO', CACHE_SIGO);
  return CACHE_SIGO;
}

// Localiza al personal PAE por DNI y devuelve su nombre (misma búsqueda que observarIIEE)
function resolverPersonalPorDni(dniNorm) {
  const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
  const hojaP = ss.getSheetByName(CONFIG.HOJA_PERSONAL);
  if (!hojaP || hojaP.getLastRow() < 2) return { ok: false, mensaje: 'No se pudo acceder a la hoja PERSONAL.' };
  const filasP = leerHoja(hojaP);
  const colP = detectarColumnas(filasP[0], MAPA_PERSONAL, RESPALDO_PERSONAL);
  for (let i = 1; i < filasP.length; i++) {
    let ok = false;
    for (let j = 0; j < filasP[i].length; j++) {
      if (normalizar(filasP[i][j]) === dniNorm) { ok = true; break; }
    }
    if (ok) {
      const nombre = nombreCompletoPersonal(filasP[0], filasP[i], colP);
      if (!nombre) return { ok: false, mensaje: 'El personal no tiene nombre registrado.' };
      return { ok: true, nombre: nombre, celular: celularDeFila(filasP[i], colP) };
    }
  }
  return { ok: false, mensaje: 'No se encontró personal con el DNI indicado.' };
}

// Marca una IIEE (sin archivo en la web) como "FORMATO CARGADO AL SIGO"
function marcarCargadoSIGO(dni, codMod, sid) {
  try {
    if (!permitirPeticion('SIGO', sid)) return { ok: false, mensaje: MENSAJES_LIMITE.SIGO };
    const dniNorm = normalizar(dni);
    if (!dniNorm) return { ok: false, mensaje: 'DNI no válido.' };

    const rp = resolverPersonalPorDni(dniNorm);
    if (!rp.ok) return rp;

    const iiee = iieeAsignadaADni(codMod, dniNorm);
    if (!iiee) return { ok: false, mensaje: 'Esta IIEE no está asignada a usted; no puede marcarla.' };

    const info = obtenerInfoCargas();
    const k = claveCodMod(iiee.codMod);
    const arch = info.archivos[k];
    if (arch && arch.url) return { ok: false, mensaje: 'Esta IIEE ya tiene su Formato CAE cargado en la web; no necesita la marca SIGO.' };
    if (info.sigo && info.sigo[k]) return { ok: true, yaMarcada: true, mensaje: 'Esta IIEE ya estaba marcada como "Cargado al SIGO".' };

    const kr = claveRuta(iiee.codRuta);
    const canon = obtenerRutasCanonicas();
    const nombreRuta = (kr && canon[kr]) || iiee.codRuta || '';
    const fecha = Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm:ss');

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(CONFIG.ESPERA_LOCK_MS)) {
      return { ok: false, mensaje: 'El sistema está procesando otra solicitud. Inténtelo de nuevo en unos segundos.' };
    }
    try {
      const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
      const hoja = obtenerOcrearHojaSIGO(ss);
      // Upsert: una sola fila por codMod; si existía una marca anulada se reactiva
      const ultima = Math.max(hoja.getLastRow(), 1);
      const rango = hoja.getRange(1, 1, ultima, SIGO_COL.ESTADO);
      const valores = rango.getValues();
      const nuevaFila = [fecha, String(iiee.codMod), iiee.nombre, nombreRuta, dniNorm, rp.nombre, 'SIGO'];
      let filaDestino = -1;
      for (let i = 1; i < valores.length; i++) {
        if (claveCodMod(valores[i][SIGO_COL.COD_MOD - 1]) === k) { filaDestino = i; break; }
      }
      if (filaDestino > -1) {
        for (let c = 0; c < nuevaFila.length; c++) valores[filaDestino][c] = nuevaFila[c];
        rango.setValues(valores);
      } else {
        hoja.appendRow(nuevaFila);
      }
      try {
        const celda = hoja.getRange(filaDestino > -1 ? filaDestino + 1 : hoja.getLastRow(), SIGO_COL.COD_MOD);
        celda.setNumberFormat('@');
        celda.setValue(String(iiee.codMod));
      } catch (e2) {}
    } finally {
      lock.releaseLock();
    }

    limpiarCacheDatos();

    return { ok: true, mensaje: '✅ IIEE marcada como "Formato cargado al SIGO". Ya se considera atendida en el control.' };
  } catch (error) {
    return { ok: false, mensaje: 'Error: ' + error.message };
  }
}

// Retira la marca "Cargado al SIGO": la IIEE vuelve al estado SIN FORMATO
function quitarMarcaSIGO(dni, codMod, sid) {
  try {
    if (!permitirPeticion('SIGO', sid)) return { ok: false, mensaje: MENSAJES_LIMITE.SIGO };
    const dniNorm = normalizar(dni);
    const k = claveCodMod(codMod);
    if (!dniNorm || !k) return { ok: false, mensaje: 'Datos no válidos.' };

    const iiee = iieeAsignadaADni(codMod, dniNorm);
    if (!iiee) return { ok: false, mensaje: 'Esta IIEE no está asignada a usted.' };

    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hoja = ss.getSheetByName(CONFIG.HOJA_SIGO);
    if (!hoja || hoja.getLastRow() < 2) return { ok: false, mensaje: 'La IIEE no tiene marca SIGO activa.' };

    const filas = leerHoja(hoja);
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(CONFIG.ESPERA_LOCK_MS)) {
      return { ok: false, mensaje: 'El sistema está procesando otra solicitud. Inténtelo de nuevo en unos segundos.' };
    }
    try {
      const ultima = Math.max(hoja.getLastRow(), 1);
      const rango = hoja.getRange(1, SIGO_COL.ESTADO, ultima, 1);
      const valores = rango.getValues();
      let n = 0;
      for (let i = 1; i < filas.length; i++) {
        if (claveCodMod(filas[i][SIGO_COL.COD_MOD - 1]) === k && normalizar(filas[i][SIGO_COL.ESTADO - 1]) === 'SIGO') {
          valores[i][0] = 'ANULADA';
          n++;
        }
      }
      if (!n) return { ok: false, mensaje: 'La IIEE no tiene marca SIGO activa.' };
      rango.setValues(valores);
    } finally {
      lock.releaseLock();
    }

    limpiarCacheDatos();
    return { ok: true, mensaje: 'Marca SIGO retirada. La IIEE vuelve al estado SIN FORMATO y puede cargarse por la web.' };
  } catch (error) {
    return { ok: false, mensaje: 'Error: ' + error.message };
  }
}

// Devuelve la IIEE solo si está asignada al personal indicado (columna J)
function iieeAsignadaADni(codMod, dniNorm) {
  const iiee = obtenerIIEEPorCodMod(codMod, '');
  if (!iiee) return null;
  const cp = normalizar(iiee.codPersonal);
  if (!cp) return null;
  if (dniDeCodigoPersonal(cp) !== dniNorm) return null;
  return iiee;
}

// Marca una IIEE (con formato cargado) como OBSERVADA y notifica al tramitador por correo
function observarIIEE(dni, codMod, comentario) {
  try {
    const dniNorm = normalizar(dni);
    if (!dniNorm) return { ok: false, mensaje: 'DNI no válido.' };

    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hojaP = ss.getSheetByName(CONFIG.HOJA_PERSONAL);
    if (!hojaP || hojaP.getLastRow() < 2) return { ok: false, mensaje: 'No se pudo acceder a la hoja PERSONAL.' };
    const filasP = leerHoja(hojaP);
    const colP = detectarColumnas(filasP[0], MAPA_PERSONAL, RESPALDO_PERSONAL);

    let nombrePersonal = '', celularPersonal = '', hallado = false;
    for (let i = 1; i < filasP.length; i++) {
      let ok = false;
      for (let j = 0; j < filasP[i].length; j++) {
        if (normalizar(filasP[i][j]) === dniNorm) { ok = true; break; }
      }
      if (ok) {
        hallado = true;
        nombrePersonal = nombreCompletoPersonal(filasP[0], filasP[i], colP);
        celularPersonal = celularDeFila(filasP[i], colP);
        break;
      }
    }
    if (!hallado) return { ok: false, mensaje: 'No se encontró personal con el DNI indicado.' };
    if (!nombrePersonal) return { ok: false, mensaje: 'El personal no tiene nombre registrado.' };

    const iiee = iieeAsignadaADni(codMod, dniNorm);
    if (!iiee) return { ok: false, mensaje: 'Esta IIEE no está asignada a usted; no puede observarla.' };

    const info = obtenerInfoCargas();
    const k = claveCodMod(iiee.codMod);
    if (!(info.archivos[k] && info.archivos[k].url)) return { ok: false, mensaje: 'La IIEE no tiene formato cargado en la web; no se puede observar.' };
    if (info.observados[k]) return { ok: false, mensaje: 'Esta IIEE ya se encuentra observada.' };

    const kr = claveRuta(iiee.codRuta);
    const canon = obtenerRutasCanonicas();
    const nombreRuta = (kr && canon[kr]) || iiee.codRuta;
    const fechaObs = Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm:ss');
    const comentarioLimpio = String(comentario || '').trim();

    const hoja = obtenerOcrearHojaObservaciones(ss);
    hoja.appendRow([fechaObs, iiee.codMod, iiee.nombre, nombreRuta, dniNorm, nombrePersonal, celularPersonal, comentarioLimpio, 'OBSERVADO', '']);
    try {
      const celda = hoja.getRange(hoja.getLastRow(), OBS_COL.COD_MOD);
      celda.setNumberFormat('@');
      celda.setValue(String(iiee.codMod));
    } catch (e) {}

    // Correo automático al tramitador (si registró correo)
    const t = info.tramitadores[k] || {};
    let correoEnviado = false;
    if (t.correo) {
      try {
        enviarCorreoObservacion(t, iiee, {
          comentario: comentarioLimpio,
          personal: nombrePersonal,
          celular: celularPersonal,
          fecha: fechaObs
        });
        correoEnviado = true;
      } catch (e) { console.error('Correo observación: ' + e); }
    }

    limpiarCacheDatos();

    return {
      ok: true,
      mensaje: 'IIEE marcada como OBSERVADA. El tramitador podrá volver a cargar el formato.' +
        (correoEnviado ? ' Se envió correo de notificación al tramitador.' : ''),
      correoEnviado: correoEnviado
    };
  } catch (error) {
    return { ok: false, mensaje: 'Error: ' + error.message };
  }
}

// Retira la observación: la IIEE vuelve al estado CON FORMATO
function quitarObservacion(dni, codMod) {
  try {
    const dniNorm = normalizar(dni);
    const k = claveCodMod(codMod);
    if (!dniNorm || !k) return { ok: false, mensaje: 'Datos no válidos.' };

    const iiee = iieeAsignadaADni(codMod, dniNorm);
    if (!iiee) return { ok: false, mensaje: 'Esta IIEE no está asignada a usted.' };

    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hoja = ss.getSheetByName(CONFIG.HOJA_OBSERVACIONES);
    if (!hoja || hoja.getLastRow() < 2) return { ok: false, mensaje: 'No hay observaciones registradas.' };
    const filas = leerHoja(hoja);
    const ultima = Math.max(hoja.getLastRow(), 1);
    const rango = hoja.getRange(1, OBS_COL.ESTADO, ultima, 1);
    const valores = rango.getValues();
    let n = 0;
    for (let i = 1; i < filas.length; i++) {
      if (claveCodMod(filas[i][OBS_COL.COD_MOD - 1]) === k && normalizar(filas[i][OBS_COL.ESTADO - 1]) === 'OBSERVADO') {
        valores[i][0] = 'RETIRADA';
        n++;
      }
    }
    if (!n) return { ok: false, mensaje: 'La IIEE no tiene observación activa.' };
    rango.setValues(valores);
    limpiarCacheDatos();
    return { ok: true, mensaje: 'Observación retirada. La IIEE vuelve al estado CON FORMATO.' };
  } catch (error) {
    return { ok: false, mensaje: 'Error: ' + error.message };
  }
}

// Cierra las observaciones abiertas de una IIEE (tras re-cargar el formato)
function cerrarObservacionesAbiertas(kCodMod, fechaResubida) {
  const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
  const hoja = ss.getSheetByName(CONFIG.HOJA_OBSERVACIONES);
  if (!hoja || hoja.getLastRow() < 2) return 0;
  const filas = leerHoja(hoja);
  const ultima = Math.max(hoja.getLastRow(), 1);
  const rangoEstado = hoja.getRange(1, OBS_COL.ESTADO, ultima, 1);
  const valores = rangoEstado.getValues();
  const rangoFecha = hoja.getRange(1, OBS_COL.FECHA_RESUBIDA, ultima, 1);
  const fechas = rangoFecha.getValues();
  let n = 0;
  for (let i = 1; i < filas.length; i++) {
    if (claveCodMod(filas[i][OBS_COL.COD_MOD - 1]) === kCodMod && normalizar(filas[i][OBS_COL.ESTADO - 1]) === 'OBSERVADO') {
      valores[i][0] = 'REGISTRADO';
      fechas[i][0] = fechaResubida;
      n++;
    }
  }
  if (n) { rangoEstado.setValues(valores); rangoFecha.setValues(fechas); }
  return n;
}

// ==================== CARGA DE ARCHIVO ====================
function procesarCarga(datos, blob) {
  // Honeypot anti-bot: campo oculto del formulario; si llega con valor, es un bot
  if (datos && datos.web) throw new Error('No se pudo procesar la solicitud.');
  if (!datos || !datos.codMod) throw new Error('Datos incompletos de la institución educativa.');
  if (!datos.apellidos || !String(datos.apellidos).trim()) throw new Error('Debe ingresar los apellidos y nombres del tramitador.');
  if (!datos.celular || !String(datos.celular).trim()) throw new Error('Debe ingresar el número de celular.');

  const nombreOriginal = String(blob.getName() || '');
  const tipoMime = String(blob.getContentType() || '').toLowerCase();
  if (tipoMime.indexOf('pdf') === -1 && nombreOriginal.toLowerCase().indexOf('.pdf') === -1) {
    throw new Error('Solo se permiten archivos PDF.');
  }
  const bytes = blob.getBytes();
  if (bytes.length > CONFIG.TAMANO_MAX_MB * 1024 * 1024) {
    throw new Error('El archivo supera el tamaño máximo de ' + CONFIG.TAMANO_MAX_MB + ' MB.');
  }

  // Rate limiting: protege las cuotas si muchos usuarios (o bots) envían a la vez
  if (!permitirPeticion('CARGA', datos.sid)) {
    throw new Error(MENSAJES_LIMITE.CARGA);
  }

  // reCAPTCHA v3: verifica que sea una persona y no un script automatizado
  const rc = verificarRecaptcha(datos.recaptchaToken, 'upload');
  if (!rc.ok) throw new Error(rc.mensaje);

  // Bloqueada solo si ya tiene ARCHIVO cargado en la web (o marca SIGO activa)
  // Y NO está observada. Las IIEEs OBSERVADAS se desbloquean para la re-carga.
  // Las marcas SIGO bloquean la carga web (la IIEE ya está atendida); el
  // personal puede retirar la marca desde su módulo si el tramitador debe subirlo.
  const infoCargas = obtenerInfoCargas();
  const kPrevio = claveCodMod(datos.codMod);
  const archPrevio = infoCargas.archivos[kPrevio];
  const tieneArchivoPrevio = !!(archPrevio && archPrevio.url);
  const marcadaSIGO = !!(infoCargas.sigo && infoCargas.sigo[kPrevio] && !tieneArchivoPrevio);
  if ((tieneArchivoPrevio || marcadaSIGO) && !infoCargas.observados[kPrevio]) {
    if (marcadaSIGO) {
      throw new Error('Esta IIEE ya fue registrada por el personal PAE como "Formato cargado al SIGO". Coordine con el personal si necesita cargar el archivo.');
    }
    throw new Error('Esta IIEE ya tiene su Formato CAE cargado. No es posible cargarlo nuevamente.');
  }
  const esResubida = !!(tieneArchivoPrevio && infoCargas.observados[kPrevio]);

  const iiee = obtenerIIEEPorCodMod(datos.codMod, datos.nombre);
  if (!iiee) throw new Error('No se encontró la IIEE con código modular ' + datos.codMod + '.');

  const kRutaIIEE = claveRuta(iiee.codRuta);
  const rutasCanon = obtenerRutasCanonicas();
  if (kRutaIIEE && rutasCanon[kRutaIIEE]) iiee.codRuta = rutasCanon[kRutaIIEE];

  // LockService con espera CORTA: las esperas largas encolan ejecuciones,
  // acumulan procesos colgados y consumen recursos (motivo de bloqueo).
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.ESPERA_LOCK_MS)) {
    throw new Error('El sistema está procesando otra solicitud. Inténtelo de nuevo en unos segundos.');
  }
  try {
    const carpeta = DriveApp.getFolderById(CONFIG.ID_CARPETA_DRIVE);
    let nombreArchivo = generarNombreArchivoCAE(iiee.codMod, iiee.nombre);
    if (carpeta.getFilesByName(nombreArchivo).hasNext()) {
      nombreArchivo = nombreArchivo.replace(/\.pdf$/, '') + '_' + Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'yyyyMMdd-HHmmss') + '.pdf';
    }
    const archivo = carpeta.createFile(blob);
    archivo.setName(nombreArchivo);
    try {
      archivo.setDescription('CAE | ' + iiee.nombre + ' | Ruta: ' + iiee.codRuta + (esResubida ? ' | RE-CARGA (formato observado)' : '') + ' | Tramitador: ' + datos.apellidos + ' | Cel.: ' + datos.celular);
    } catch (e) {}

    const fechaCarga = Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm:ss');
    registrarEnTramitador(datos, iiee, nombreArchivo, archivo.getUrl(), fechaCarga);

    // Si era una re-carga de formato observado: cerrar la observación
    if (esResubida) {
      try { cerrarObservacionesAbiertas(kPrevio, fechaCarga); } catch (e) { console.error('cerrarObservaciones: ' + e); }
    }

    const correo = String(datos.correo || '').trim();
    let correoEnviado = false;
    let avisoCorreo = '';
    if (correo) {
      try {
        enviarCorreoConfirmacion(datos, iiee, fechaCarga, nombreArchivo);
        correoEnviado = true;
      } catch (e) {
        console.error('Correo: ' + e);
        avisoCorreo = 'La carga fue exitosa, pero el correo de confirmación quedó pendiente: ' + e.message;
      }
    }

    limpiarCacheDatos();

    return {
      ok: true,
      mensaje: 'Archivo cargado correctamente.',
      archivo: nombreArchivo,
      fechaCarga: fechaCarga,
      correoEnviado: correoEnviado,
      avisoCorreo: avisoCorreo,
      resubida: esResubida,
      iiee: { nombre: iiee.nombre, codMod: iiee.codMod, nivel: iiee.nivel, provincia: iiee.provincia, distrito: iiee.distrito, centroPoblado: iiee.centroPoblado },
      tramitador: { apellidos: String(datos.apellidos).trim(), celular: String(datos.celular).trim(), correo: correo }
    };
  } finally {
    lock.releaseLock();
  }
}

function subirArchivoBase64(base64, nombreOriginal, tipoMime, datos) {
  try {
    const bytes = Utilities.base64Decode(base64);
    const blob = Utilities.newBlob(bytes, tipoMime || 'application/pdf', nombreOriginal || 'archivo.pdf');
    return procesarCarga(datos, blob);
  } catch (error) {
    return { ok: false, mensaje: 'Error: ' + error.message };
  }
}

// ==================== REGISTRO EN HOJA TRAMITADOR ====================
function registrarEnTramitador(datos, iiee, nombreArchivo, urlArchivo, fechaCarga) {
  const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
  let hoja = ss.getSheetByName(CONFIG.HOJA_TRAMITADOR);
  if (!hoja) hoja = ss.insertSheet(CONFIG.HOJA_TRAMITADOR);

  if (hoja.getLastRow() === 0) {
    const enc = ['FECHA', 'APELLIDOS Y NOMBRES', 'CELULAR', 'CORREO', 'COD. MODULAR', 'NOMBRE IIEE', 'NIVEL', 'PROVINCIA', 'DISTRITO', 'COD. RUTA', 'ARCHIVO', 'URL ARCHIVO'];
    hoja.getRange(1, 1, 1, enc.length).setValues([enc]);
    hoja.getRange(1, 1, 1, enc.length).setFontWeight('bold');
    hoja.setFrozenRows(1);
  }

  const numCols = hoja.getLastColumn();
  const filas = leerHoja(hoja);
  const col = detectarColumnas(filas[0], MAPA_TRAMITADOR, RESPALDO_TRAMITADOR);
  const val = validarColumnasTramitador(filas, col);

  const valoresFila = {
    FECHA: fechaCarga, APELLIDOS: String(datos.apellidos || '').trim(), CELULAR: String(datos.celular || '').trim(),
    CORREO: String(datos.correo || '').trim(), COD_MOD: iiee.codMod, NOMBRE_IIEE: iiee.nombre, NIVEL: iiee.nivel,
    PROVINCIA: iiee.provincia, DISTRITO: iiee.distrito, COD_RUTA: iiee.codRuta, ARCHIVO: nombreArchivo, URL: urlArchivo
  };

  const fila = new Array(numCols).fill('');
  Object.keys(valoresFila).forEach(function (campo) {
    let c;
    if (campo === 'COD_MOD') c = val.colCodMod;
    else if (campo === 'FECHA') c = val.colFecha;
    else if (campo === 'URL') c = val.colUrl;
    else c = (col[campo] || 1) - 1;
    if (c >= 0 && c < numCols) fila[c] = valoresFila[campo];
  });
  hoja.appendRow(fila);

  try {
    const celda = hoja.getRange(hoja.getLastRow(), val.colCodMod + 1);
    celda.setNumberFormat('@');
    celda.setValue(String(iiee.codMod));
  } catch (e) {}
}

// ==================== CORREO DE CONFIRMACIÓN (HTML) ====================
function enviarCorreoConfirmacion(datos, iiee, fechaCarga, nombreArchivo) {
  const correo = String(datos.correo || '').trim();
  const nombreTramitador = String(datos.apellidos || '').trim();

  // Control anti-bloqueo: verificar cuota, tope diario y ritmo ANTES de enviar
  const permiso = puedeEnviarCorreo();
  if (!permiso.ok) {
    registrarLogCorreo('CONFIRMACION', correo, 'OMITIDO', permiso.motivo);
    throw new Error(permiso.motivo);
  }
  const asunto = '✅ Carga correcta del Formato CAE — IIEE ' + iiee.nombre;

  const textoPlano = 'Estimado(a) ' + nombreTramitador + ', se ha cargado correctamente el archivo CAE de la IIEE ' +
    iiee.nombre + ', nivel ' + iiee.nivel + '. Gracias por su colaboración con el PAE - Programa de Alimentación Escolar, Unidad Territorial Huancavelica.';

  const filaCorreo = function (etiqueta, valor) {
    return '<tr>' +
      '<td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;font-weight:bold;color:#64748b;background:#f8fafc;width:42%">' + etiqueta + '</td>' +
      '<td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#1e293b">' + escaparHtml(valor || '—') + '</td>' +
      '</tr>';
  };

  const html =
    '<div style="margin:0;padding:24px 10px;background:#eef2f5;font-family:Arial,Helvetica,sans-serif">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">' +
        '<tr><td style="background:' + COLORES.verde + ';padding:22px 16px;text-align:center">' +
          '<img src="' + CONFIG.LOGO_URL + '" alt="PAE" width="84" style="display:block;margin:0 auto 10px;background:#ffffff;border-radius:50%;padding:6px">' +
          '<div style="color:#ffffff;font-size:16px;font-weight:bold;letter-spacing:.5px">PROGRAMA DE ALIMENTACIÓN ESCOLAR</div>' +
          '<div style="color:' + COLORES.amarillo + ';font-size:12px;font-weight:bold;margin-top:3px">UNIDAD TERRITORIAL HUANCAVELICA</div>' +
        '</td></tr>' +
        '<tr><td style="padding:24px 24px 6px">' +
          '<div style="display:inline-block;background:#DCFCE7;color:#166534;border:1px solid #86EFAC;border-radius:999px;padding:5px 14px;font-size:12px;font-weight:bold;margin-bottom:14px">✔ CARGA COMPLETADA</div>' +
          '<p style="margin:0 0 10px;font-size:15px;color:#1e293b">Estimado(a) <b>' + escaparHtml(nombreTramitador) + '</b>:</p>' +
          '<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155">Se ha cargado correctamente el archivo <b>CAE</b> de la IIEE <b>' + escaparHtml(iiee.nombre) + '</b>, nivel <b>' + escaparHtml(iiee.nivel) + '</b>.</p>' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0">' +
            filaCorreo('INSTITUCIÓN EDUCATIVA', iiee.nombre) +
            filaCorreo('CÓDIGO MODULAR', iiee.codMod) +
            filaCorreo('NIVEL', iiee.nivel) +
            filaCorreo('PROVINCIA / DISTRITO', iiee.provincia + ' / ' + iiee.distrito) +
            filaCorreo('FECHA Y HORA DE CARGA', fechaCarga) +
            filaCorreo('ARCHIVO REGISTRADO', nombreArchivo) +
          '</table>' +
          '<p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#334155">Gracias por su colaboración con el <b style="color:' + COLORES.verde + '">PAE — Programa de Alimentación Escolar</b>.</p>' +
        '</td></tr>' +
        '<tr><td style="background:' + COLORES.verde + ';padding:16px;text-align:center">' +
          '<div style="color:#ffffff;font-size:13px;font-weight:bold">PAE — Unidad Territorial Huancavelica</div>' +
          '<div style="color:#c9e8dd;font-size:11px;margin-top:4px">Mensaje generado automáticamente · ' + fechaCarga + '</div>' +
        '</td></tr>' +
      '</table>' +
    '</div>';

  MailApp.sendEmail({ to: correo, subject: asunto, body: textoPlano, htmlBody: html });
  registrarCorreoEnviado();
  registrarLogCorreo('CONFIRMACION', correo, 'ENVIADO', 'IIEE ' + (iiee.codMod || '') + ' — ' + iiee.nombre);
}

// ==================== CORREO DE OBSERVACIÓN (HTML) ====================
function enviarCorreoObservacion(tramitador, iiee, obs) {
  const correo = String(tramitador.correo || '').trim();
  if (!correo) return;

  // Control anti-bloqueo: verificar cuota, tope diario y ritmo ANTES de enviar
  const permiso = puedeEnviarCorreo();
  if (!permiso.ok) {
    registrarLogCorreo('OBSERVACION', correo, 'OMITIDO', permiso.motivo);
    throw new Error(permiso.motivo);
  }
  const nombreTramitador = String(tramitador.apellidos || '').trim();
  const asunto = '⚠️ Formato CAE OBSERVADO — IIEE ' + iiee.nombre;

  const textoPlano = 'Estimado(a) ' + nombreTramitador + ', el Formato CAE cargado para la IIEE ' + iiee.nombre +
    ' (Código Modular ' + iiee.codMod + ') ha sido OBSERVADO' +
    (obs.comentario ? ' por el siguiente motivo: ' + obs.comentario : '') + '.\n\n' +
    'Por favor revise y vuelva a cargar el formato a través del siguiente enlace: ' + CONFIG.URL_APP_SITIO + '\n\n' +
    'Personal PAE asignado a la IIEE: ' + obs.personal + ' — Celular: ' + (obs.celular || '—') + '\n\n' +
    'Gracias por su colaboración con el PAE — Programa de Alimentación Escolar, Unidad Territorial Huancavelica.';

  const filaCorreo = function (etiqueta, valor, fondo) {
    return '<tr>' +
      '<td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;font-weight:bold;color:#64748b;background:' + (fondo || '#f8fafc') + ';width:42%">' + etiqueta + '</td>' +
      '<td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#1e293b">' + escaparHtml(valor || '—') + '</td>' +
      '</tr>';
  };

  const html =
    '<div style="margin:0;padding:24px 10px;background:#eef2f5;font-family:Arial,Helvetica,sans-serif">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">' +
        '<tr><td style="background:' + COLORES.ambar + ';padding:22px 16px;text-align:center">' +
          '<img src="' + CONFIG.LOGO_URL + '" alt="PAE" width="84" style="display:block;margin:0 auto 10px;background:#ffffff;border-radius:50%;padding:6px">' +
          '<div style="color:#ffffff;font-size:16px;font-weight:bold;letter-spacing:.5px">PROGRAMA DE ALIMENTACIÓN ESCOLAR</div>' +
          '<div style="color:#FEF3C7;font-size:12px;font-weight:bold;margin-top:3px">UNIDAD TERRITORIAL HUANCAVELICA</div>' +
        '</td></tr>' +
        '<tr><td style="padding:24px 24px 6px">' +
          '<div style="display:inline-block;background:#FEF3C7;color:#92400E;border:1px solid #FDE68A;border-radius:999px;padding:5px 14px;font-size:12px;font-weight:bold;margin-bottom:14px">⚠️ FORMATO OBSERVADO — REQUIERE NUEVA CARGA</div>' +
          '<p style="margin:0 0 10px;font-size:15px;color:#1e293b">Estimado(a) <b>' + escaparHtml(nombreTramitador) + '</b>:</p>' +
          '<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155">El Formato <b>CAE</b> que usted cargó para la IIEE <b>' + escaparHtml(iiee.nombre) + '</b> ha sido <b style="color:' + COLORES.ambar + '">OBSERVADO</b>. Por favor revise el documento y <b>vuelva a cargarlo</b> a través de la aplicación.</p>' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0">' +
            filaCorreo('INSTITUCIÓN EDUCATIVA', iiee.nombre) +
            filaCorreo('CÓDIGO MODULAR', iiee.codMod) +
            filaCorreo('NIVEL', iiee.nivel) +
            filaCorreo('PROVINCIA / DISTRITO', iiee.provincia + ' / ' + iiee.distrito) +
            filaCorreo('MOTIVO DE LA OBSERVACIÓN', obs.comentario || 'No se registró motivo', '#FEF3C7') +
            filaCorreo('FECHA DE OBSERVACIÓN', obs.fecha) +
            filaCorreo('PERSONAL PAE ASIGNADO', obs.personal) +
            filaCorreo('CELULAR DE CONTACTO', obs.celular) +
          '</table>' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr><td style="text-align:center">' +
            '<a href="' + CONFIG.URL_APP_SITIO + '" style="display:inline-block;background:' + COLORES.ambar + ';color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;padding:12px 26px;border-radius:10px">↻ VOLVER A CARGAR EL FORMATO CAE</a>' +
            '<div style="font-size:11px;color:#64748b;margin-top:8px">' + escaparHtml(CONFIG.URL_APP_SITIO) + '</div>' +
          '</td></tr></table>' +
          '<p style="margin:0;font-size:13px;line-height:1.6;color:#334155">Ante cualquier consulta, comuníquese con <b>' + escaparHtml(obs.personal) + '</b> al celular <b>' + escaparHtml(obs.celular || '—') + '</b>.</p>' +
        '</td></tr>' +
        '<tr><td style="background:' + COLORES.ambar + ';padding:16px;text-align:center">' +
          '<div style="color:#ffffff;font-size:13px;font-weight:bold">PAE — Unidad Territorial Huancavelica</div>' +
          '<div style="color:#FEF3C7;font-size:11px;margin-top:4px">Mensaje generado automáticamente · ' + obs.fecha + '</div>' +
        '</td></tr>' +
      '</table>' +
    '</div>';

  MailApp.sendEmail({ to: correo, subject: asunto, body: textoPlano, htmlBody: html });
  registrarCorreoEnviado();
  registrarLogCorreo('OBSERVACION', correo, 'ENVIADO', 'IIEE ' + (iiee.codMod || '') + ' — ' + iiee.nombre);
}

// ==================== CARGO DE ENVÍO (PDF) ====================
function generarCargo(info) {
  try {
    info = info || {};
    // Rate limiting: generar PDF consume cuota de DocumentApp y Drive
    if (!permitirPeticion('CARGO', info.sid)) {
      return { ok: false, mensaje: MENSAJES_LIMITE.CARGO };
    }
    const fecha = info.fechaCarga || Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm:ss');
    const doc = DocumentApp.create('CARGO CAE ' + (info.codMod || ''));
    const cuerpo = doc.getBody();

    // Logo desde caché (SIN UrlFetchApp en cada generación de PDF)
    try {
      const b64Logo = obtenerLogoBase64();
      if (b64Logo) {
        const blobLogo = Utilities.newBlob(Utilities.base64Decode(b64Logo), 'image/png', 'logo.png');
        const pImg = cuerpo.appendParagraph('');
        const img = pImg.appendImage(blobLogo);
        const w = img.getWidth(), h = img.getHeight();
        img.setWidth(100); img.setHeight(Math.round(h * 100 / w));
        pImg.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      }
    } catch (e) {}

    parrafo(cuerpo, 'PROGRAMA DE ALIMENTACIÓN ESCOLAR — PAE', { bold: true, centrado: true, tamano: 11, color: COLORES.verde });
    parrafo(cuerpo, 'UNIDAD TERRITORIAL HUANCAVELICA', { centrado: true, tamano: 10, color: COLORES.gris });
    barra(cuerpo, COLORES.verde);
    parrafo(cuerpo, 'CARGO DE ENVÍO', { bold: true, centrado: true, tamano: 20, color: COLORES.verde });
    parrafo(cuerpo, 'Carga del Formato CAE de las II.EE.', { centrado: true, cursiva: true, tamano: 10, color: COLORES.gris });
    barra(cuerpo, COLORES.amarillo);
    parrafo(cuerpo, 'Fecha y hora de carga: ' + fecha, { bold: true, tamano: 11 });

    agregarTablaDatos(cuerpo, 'DATOS DEL TRAMITADOR', [
      ['Apellidos y Nombres', info.apellidos || '—'],
      ['Celular', info.celular || '—'],
      ['Correo electrónico', info.correo || '—']
    ]);

    agregarTablaDatos(cuerpo, 'DATOS DE LA INSTITUCIÓN EDUCATIVA', [
      ['Nombre de la IIEE', info.nombre || '—'],
      ['Código Modular', info.codMod || '—'],
      ['Nivel', info.nivel || '—'],
      ['Provincia / Distrito', (info.provincia || '—') + ' / ' + (info.distrito || '—')],
      ['Centro Poblado', info.centroPoblado || '—'],
      ['Archivo cargado', info.archivo || '—']
    ]);

    parrafo(cuerpo, '');
    parrafo(cuerpo, 'Estimado(a) ' + (info.apellidos || '') + ', se ha cargado correctamente el archivo CAE de la IIEE ' +
      (info.nombre || '') + ', nivel ' + (info.nivel || '') +
      '. Gracias por su colaboración con el PAE — Programa de Alimentación Escolar, Unidad Territorial Huancavelica.', { cursiva: true, tamano: 10 });
    parrafo(cuerpo, '');
    parrafo(cuerpo, '');
    parrafo(cuerpo, '________________________________', { centrado: true });
    parrafo(cuerpo, 'PAE — Unidad Territorial Huancavelica', { centrado: true, bold: true, tamano: 10, color: COLORES.verde });
    parrafo(cuerpo, 'Huancavelica, ' + fecha, { centrado: true, tamano: 9, color: COLORES.gris });

    doc.saveAndClose();
    const pdf = doc.getAs('application/pdf').setName('CARGO_' + (info.codMod || '') + '.pdf');
    try { DriveApp.getFileById(doc.getId()).setTrashed(true); } catch (e) {}
    return { ok: true, base64: Utilities.base64Encode(pdf.getBytes()), nombre: pdf.getName() };
  } catch (error) {
    return { ok: false, mensaje: 'No se pudo generar el cargo: ' + error.message };
  }
}

function parrafo(cuerpo, texto, opciones) {
  opciones = opciones || {};
  const p = cuerpo.appendParagraph(texto);
  if (opciones.centrado) p.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  const t = p.editAsText();
  if (opciones.bold) t.setBold(true);
  if (opciones.cursiva) t.setItalic(true);
  if (opciones.subrayado) t.setUnderline(true);
  if (opciones.tamano) t.setFontSize(opciones.tamano);
  if (opciones.color) t.setForegroundColor(opciones.color);
  return p;
}

function barra(cuerpo, color) {
  try {
    const tabla = cuerpo.appendTable([['']]);
    tabla.setBorderColor(color);
    const celda = tabla.getCell(0, 0);
    celda.setBackgroundColor(color);
    celda.setWidth(460);
    const p = celda.getChild(0).asParagraph();
    p.editAsText().setFontSize(2).setForegroundColor(color);
    parrafo(cuerpo, '');
  } catch (e) {}
}

function agregarTablaDatos(cuerpo, titulo, filas) {
  parrafo(cuerpo, '');
  const datos = [[titulo, '']];
  filas.forEach(function (f) { datos.push([String(f[0]), String(f[1] == null ? '' : f[1])]); });
  const tabla = cuerpo.appendTable(datos);
  try { tabla.setBorderColor('#CBD5E1'); } catch (e) {}
  for (let c = 0; c < 2; c++) {
    const celda = tabla.getCell(0, c);
    celda.setBackgroundColor(COLORES.verde);
    celda.editAsText().setBold(true).setForegroundColor('#FFFFFF').setFontSize(10);
  }
  for (let i = 1; i < datos.length; i++) {
    const c1 = tabla.getCell(i, 0), c2 = tabla.getCell(i, 1);
    try { c1.setWidth(175); c2.setWidth(330); } catch (e) {}
    c1.setBackgroundColor('#F0FDF9');
    c1.editAsText().setBold(true).setFontSize(9).setForegroundColor(COLORES.verde);
    c2.editAsText().setFontSize(10).setForegroundColor('#1e293b');
  }
  parrafo(cuerpo, '');
}

// ==================== PERSONAL PAE ====================
function nombreCompletoPersonal(encabezados, fila, col) {
  const tienePater = encabezadoEs(encabezados, (col.PATERNO || 3) - 1, MAPA_PERSONAL.PATERNO);
  const tieneMater = encabezadoEs(encabezados, (col.MATERNO || 4) - 1, MAPA_PERSONAL.MATERNO);
  const tieneNombres = encabezadoEs(encabezados, (col.NOMBRES || 5) - 1, MAPA_PERSONAL.NOMBRES);
  if (tienePater || tieneMater || tieneNombres) {
    const partes = [
      tienePater ? limpiar(fila[(col.PATERNO || 3) - 1]) : '',
      tieneMater ? limpiar(fila[(col.MATERNO || 4) - 1]) : '',
      tieneNombres ? limpiar(fila[(col.NOMBRES || 5) - 1]) : ''
    ].filter(Boolean);
    if (partes.length) return partes.join(' ');
  }
  return limpiar(fila[(col.APELLIDOS || 2) - 1]);
}

function dniDeFila(fila, col) {
  const directo = normalizar(fila[(col.DNI || 2) - 1]);
  if (/^\d{6,12}$/.test(directo)) return directo;
  for (let j = 0; j < fila.length; j++) {
    const n = normalizar(fila[j]);
    if (/^\d{8}$/.test(n)) return n;
  }
  return '';
}

function celularDeFila(fila, col) {
  const directo = normalizar(fila[(col.CELULAR || 7) - 1]);
  if (/^9\d{8}$/.test(directo)) return directo;
  for (let j = 0; j < fila.length; j++) {
    const n = normalizar(fila[j]);
    if (/^9\d{8}$/.test(n)) return n;
  }
  return '';
}

// Consulta del personal: sus IIEE con estado CARGADO / PENDIENTE / OBSERVADO
function buscarPersonal(dni, sid) {
  if (!permitirPeticion('DNI', sid)) return { ok: false, mensaje: MENSAJES_LIMITE.DNI };
  const dniNorm = normalizar(dni);
  if (!dniNorm) return { ok: false, mensaje: 'Ingrese su DNI.' };
  const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
  const hoja = ss.getSheetByName(CONFIG.HOJA_PERSONAL);
  if (!hoja || hoja.getLastRow() < 2) return { ok: false, mensaje: 'No se pudo acceder a la información del personal.' };

  const filas = leerHoja(hoja);
  const col = detectarColumnas(filas[0], MAPA_PERSONAL, RESPALDO_PERSONAL);

  let idx = -1;
  for (let i = 1; i < filas.length; i++) {
    for (let j = 0; j < filas[i].length; j++) {
      if (normalizar(filas[i][j]) === dniNorm) { idx = i; break; }
    }
    if (idx > -1) break;
  }
  if (idx === -1) return { ok: false, mensaje: 'No se encontró personal registrado con el DNI: ' + dni };

  const fila = filas[idx];
  const apellidos = nombreCompletoPersonal(filas[0], fila, col);

  const datos = leerIIEES();
  const v = datos.valores, colI = datos.col;
  const canonicas = obtenerRutasCanonicas();
  const info = obtenerInfoCargas();

  const iiees = [];
  const vistos = {};
  for (let i = 1; i < v.length; i++) {
    const cp = normalizar(v[i][colI.COD_PERSONAL - 1]);
    if (!cp) continue;
    if (dniDeCodigoPersonal(cp) !== dniNorm) continue;
    const iiee = extraerIIEE(v[i], colI);
    const k = claveCodMod(iiee.codMod);
    if (!k || vistos[k]) continue;
    vistos[k] = true;

    const kr = claveRuta(iiee.codRuta);
    if (kr && canonicas[kr]) iiee.codRuta = canonicas[kr];
    if (info.cargados[k]) {
      iiee.tramitador = info.tramitadores[k] || null;
      const arch = info.archivos[k];
      iiee.archivoUrl = (arch && arch.url) || (iiee.tramitador && iiee.tramitador.url) || '';
      iiee.archivoNombre = (arch && arch.nombre) || (iiee.tramitador && iiee.tramitador.archivo) || '';
      const o = info.observados[k];
      if (o) {
        iiee.estado = 'OBSERVADO';
        iiee.observacion = { fecha: o.fecha, comentario: o.comentario, personal: o.personal, celularPersonal: o.celularPersonal };
      } else if (info.sigo && info.sigo[k] && !(arch && arch.url)) {
        iiee.estado = 'SIGO';
        iiee.sigo = info.sigo[k];
      } else {
        iiee.estado = 'CARGADO';
      }
    } else {
      iiee.estado = 'PENDIENTE';
    }
    iiees.push(iiee);
  }
  if (!iiees.length) return { ok: false, mensaje: 'El personal no tiene IIEE asignadas. Verifique la columna COD_PERSONAL_ASIGNADO de la hoja IIEES.' };

  const rutasSet = {};
  iiees.forEach(function (i) { if (i.codRuta) rutasSet[i.codRuta] = true; });
  const rutas = Object.keys(rutasSet).sort(compararRutasNatural);

  iiees.sort(function (a, b) {
    return compararRutasNatural(a.codRuta, b.codRuta) || String(a.nombre).localeCompare(String(b.nombre));
  });
  let cargadas = 0, observadas = 0, conSigo = 0;
  iiees.forEach(function (i) {
    if (i.estado === 'CARGADO') cargadas++;
    else if (i.estado === 'OBSERVADO') observadas++;
    else if (i.estado === 'SIGO') conSigo++;
  });

  return {
    ok: true, dni: dniNorm, apellidos: apellidos, rutas: rutas,
    resumen: { total: iiees.length, cargadas: cargadas, observadas: observadas, sigo: conSigo, pendientes: iiees.length - cargadas - observadas - conSigo },
    iiees: iiees
  };
}

// ==================== ASIGNACIONES POR PERSONAL ====================
let CACHE_ASIGNACIONES = null;
function obtenerAsignacionesPorPersonal() {
  if (CACHE_ASIGNACIONES) return CACHE_ASIGNACIONES;

  const info = obtenerInfoCargas();
  const canonicas = obtenerRutasCanonicas();
  const datos = leerIIEES();
  const v = datos.valores, colI = datos.col;

  const porDni = {};
  const orden = [];
  try {
    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hoja = ss.getSheetByName(CONFIG.HOJA_PERSONAL);
    if (hoja && hoja.getLastRow() > 1) {
      const filas = leerHoja(hoja);
      const col = detectarColumnas(filas[0], MAPA_PERSONAL, RESPALDO_PERSONAL);
      for (let i = 1; i < filas.length; i++) {
        const dni = dniDeFila(filas[i], col);
        const apellidos = nombreCompletoPersonal(filas[0], filas[i], col);
        if (dni && apellidos) {
          porDni[dni] = { dni: dni, apellidos: apellidos, iiees: [], vistos: {} };
          orden.push(dni);
        }
      }
    }
  } catch (e) { console.error('obtenerAsignacionesPorPersonal: ' + e); }

  const decorar = function (iiee) {
    const kr = claveRuta(iiee.codRuta);
    if (kr && canonicas[kr]) iiee.codRuta = canonicas[kr];
    const k = claveCodMod(iiee.codMod);
    if (info.cargados[k]) {
      const arch = info.archivos[k];
      if (info.observados[k]) iiee.estado = 'OBSERVADO';
      else if (info.sigo && info.sigo[k] && !(arch && arch.url)) iiee.estado = 'SIGO';
      else iiee.estado = 'CARGADO';
    } else {
      iiee.estado = 'PENDIENTE';
    }
    return iiee;
  };

  for (let i = 1; i < v.length; i++) {
    const cp = normalizar(v[i][colI.COD_PERSONAL - 1]);
    if (!cp) continue;
    const dni = dniDeCodigoPersonal(cp);
    const destino = dni && porDni[dni];
    if (!destino) continue;
    const iiee = extraerIIEE(v[i], colI);
    const k = claveCodMod(iiee.codMod);
    if (!k || destino.vistos[k]) continue;
    destino.vistos[k] = true;
    destino.iiees.push(decorar(iiee));
  }

  const lista = orden.map(function (dni) {
    const d = porDni[dni];
    const rs = {};
    d.iiees.forEach(function (i) { if (i.codRuta) rs[i.codRuta] = true; });
    d.rutas = Object.keys(rs).sort(compararRutasNatural);
    d.iiees.sort(function (a, b) {
      return compararRutasNatural(a.codRuta, b.codRuta) || String(a.nombre).localeCompare(String(b.nombre));
    });
    d.cargadas = d.iiees.filter(function (i) { return i.estado === 'CARGADO'; }).length;
    d.observadas = d.iiees.filter(function (i) { return i.estado === 'OBSERVADO'; }).length;
    d.sigo = d.iiees.filter(function (i) { return i.estado === 'SIGO'; }).length;
    return d;
  });
  lista.sort(function (a, b) { return String(a.apellidos).localeCompare(String(b.apellidos)); });

  CACHE_ASIGNACIONES = lista;
  return lista;
}

// ==================== ADMINISTRADOR ====================
function obtenerDatosAdmin(clave, sid) {
  const va = validarClaveAdmin(clave, sid);
  if (!va.ok) return va;
  try {
    const datos = leerIIEES();
    const v = datos.valores, col = datos.col;
    const info = obtenerInfoCargas();
    const canonicas = obtenerRutasCanonicas();

    const cargadasDetalle = [];
    let total = 0, cargadas = 0, observadas = 0, sigo = 0;
    for (let i = 1; i < v.length; i++) {
      const iiee = extraerIIEE(v[i], col);
      if (!iiee.codMod && !iiee.nombre) continue;
      total++;
      const kMod = claveCodMod(iiee.codMod);
      const kr = claveRuta(iiee.codRuta);
      const nombreRuta = (kr && canonicas[kr]) || iiee.codRuta || 'SIN RUTA';
      if (info.cargados[kMod]) {
        const o = info.observados[kMod];
        const arch = info.archivos[kMod];
        const esSigo = !o && info.sigo && info.sigo[kMod] && !(arch && arch.url);
        if (o) observadas++; else cargadas++;
        if (esSigo) sigo++;
        const t = info.tramitadores[kMod] || {};
        const m = esSigo ? info.sigo[kMod] : null;
        cargadasDetalle.push({
          ruta: nombreRuta, codMod: iiee.codMod, nombre: iiee.nombre, nivel: iiee.nivel, distrito: iiee.distrito,
          estado: o ? 'OBSERVADO' : (esSigo ? 'SIGO' : 'CARGADO'),
          comentario: o ? (o.comentario || '') : '',
          sigoPor: m ? (m.personal || '') : '',
          sigoFecha: m ? (m.fecha || '') : '',
          tramitador: t.apellidos || '', celular: t.celular || '', correo: t.correo || '', fecha: t.fecha || '',
          archivoUrl: (arch && arch.url) || t.url || ''
        });
      }
    }
    cargadasDetalle.sort(function (a, b) {
      return compararRutasNatural(a.ruta, b.ruta) || String(a.nombre).localeCompare(String(b.nombre));
    });

    const asignaciones = obtenerAsignacionesPorPersonal();
    const personal = asignaciones.map(function (p) {
      return {
        dni: p.dni, apellidos: p.apellidos, rutas: p.rutas,
        total: p.iiees.length, cargadas: p.cargadas + (p.sigo || 0), deEllasSigo: (p.sigo || 0), observadas: p.observadas,
        faltantes: p.iiees.length - p.cargadas - (p.sigo || 0) - p.observadas
      };
    });

    return {
      ok: true,
      fecha: Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm'),
      total: total, cargadas: cargadas, observadas: observadas, sigo: sigo, pendientes: total - cargadas - observadas,
      avance: total ? Math.round(cargadas * 1000 / total) / 10 : 0,
      personal: personal,
      cargadasDetalle: cargadasDetalle
    };
  } catch (error) {
    return { ok: false, mensaje: 'Error: ' + error.message };
  }
}

function obtenerPersonalYRutas(clave, sid) {
  const va = validarClaveAdmin(clave, sid);
  if (!va.ok) return va;
  try {
    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const hoja = ss.getSheetByName(CONFIG.HOJA_PERSONAL);
    if (!hoja || hoja.getLastRow() < 2) return { ok: false, mensaje: 'No se pudo acceder a la hoja PERSONAL.' };
    const filas = leerHoja(hoja);
    const col = detectarColumnas(filas[0], MAPA_PERSONAL, RESPALDO_PERSONAL);

    const datos = leerIIEES();
    const v = datos.valores, colI = datos.col;
    const canon = obtenerRutasCanonicas();
    const conteoPorDni = {};
    const rutasPorDni = {};
    for (let i = 1; i < v.length; i++) {
      const cp = normalizar(v[i][colI.COD_PERSONAL - 1]);
      if (!cp) continue;
      const dni = dniDeCodigoPersonal(cp);
      if (!dni) continue;
      conteoPorDni[dni] = (conteoPorDni[dni] || 0) + 1;
      const kr = claveRuta(v[i][colI.COD_RUTA - 1]);
      if (kr && canon[kr]) {
        if (!rutasPorDni[dni]) rutasPorDni[dni] = {};
        rutasPorDni[dni][canon[kr]] = true;
      }
    }

    const personal = [];
    for (let i = 1; i < filas.length; i++) {
      const apellidos = nombreCompletoPersonal(filas[0], filas[i], col);
      if (!apellidos) continue;
      const dni = dniDeFila(filas[i], col);
      const item = normalizar(filas[i][0]);
      personal.push({
        dni: dni,
        codigo: /^\d{1,6}$/.test(item) ? item : (dni || ''),
        apellidos: apellidos,
        rutas: Object.keys(rutasPorDni[dni] || {}).sort(compararRutasNatural),
        nIIEE: conteoPorDni[dni] || 0
      });
    }
    return { ok: true, personal: personal, rutas: obtenerRutasDisponibles() };
  } catch (error) {
    return { ok: false, mensaje: 'Error: ' + error.message };
  }
}

function obtenerIIEEsDeRutaParaAsignar(clave, ruta, sid) {
  const va = validarClaveAdmin(clave, sid);
  if (!va.ok) return va;
  try {
    const iiees = obtenerIIEEsPorRuta(ruta);
    const lista = iiees.map(function (i) {
      const cp = normalizar(i.codPersonal);
      const inf = cp ? infoDeCodigoPersonal(cp) : null;
      return {
        codMod: i.codMod, nombre: i.nombre, nivel: i.nivel, distrito: i.distrito, centroPoblado: i.centroPoblado,
        asignadoDni: (inf && inf.dni) || '',
        asignadoA: (inf && inf.nombre) || ''
      };
    });
    const nombreRuta = iiees.length ? iiees[0].codRuta : limpiar(ruta);
    return { ok: true, ruta: nombreRuta, iiees: lista };
  } catch (error) {
    return { ok: false, mensaje: 'Error: ' + error.message };
  }
}

function guardarAsignacionIIEEs(clave, dni, marcar, desmarcar, sid) {
  const va = validarClaveAdmin(clave, sid);
  if (!va.ok) return va;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.ESPERA_LOCK_MS)) {
    return { ok: false, mensaje: 'El sistema está procesando otra solicitud. Inténtelo de nuevo en unos segundos.' };
  }
  try {
    const ss = SpreadsheetApp.openById(CONFIG.ID_HOJA_CALCULO);
    const dniNorm = normalizar(dni);
    if (!dniNorm) return { ok: false, mensaje: 'DNI no válido.' };

    const hojaP = ss.getSheetByName(CONFIG.HOJA_PERSONAL);
    if (!hojaP || hojaP.getLastRow() < 2) return { ok: false, mensaje: 'No se pudo acceder a la hoja PERSONAL.' };
    const filasP = leerHoja(hojaP);
    let codigoPersonal = '';
    let hallado = false;
    for (let i = 1; i < filasP.length; i++) {
      let ok = false;
      for (let j = 0; j < filasP[i].length; j++) {
        if (normalizar(filasP[i][j]) === dniNorm) { ok = true; break; }
      }
      if (ok) {
        hallado = true;
        const item = normalizar(filasP[i][0]);
        codigoPersonal = /^\d{1,6}$/.test(item) ? String(item) : dniNorm;
        break;
      }
    }
    if (!hallado) return { ok: false, mensaje: 'No se encontró personal con el DNI: ' + dni };

    const hoja = ss.getSheetByName(CONFIG.HOJA_IIEES);
    if (!hoja) return { ok: false, mensaje: 'No se encontró la hoja IIEES.' };
    const filas = leerHoja(hoja);
    const colI = detectarColumnas(filas[0], MAPA_IIEES, RESPALDO_IIEES);
    let colJ = colI.COD_PERSONAL || 10;
    if (colJ > hoja.getMaxColumns()) hoja.insertColumnsAfter(hoja.getMaxColumns(), colJ - hoja.getMaxColumns());

    const idxPorCodMod = {};
    for (let i = 1; i < filas.length; i++) {
      const k = claveCodMod(filas[i][colI.COD_MOD - 1]);
      if (k && idxPorCodMod[k] === undefined) idxPorCodMod[k] = i;
    }

    const ultimaFila = Math.max(hoja.getLastRow(), 1);
    const rangoJ = hoja.getRange(1, colJ, ultimaFila, 1);
    const valoresJ = rangoJ.getValues();

    let nMarcar = 0, nDesmarcar = 0, nReasignadas = 0;
    (marcar || []).forEach(function (codMod) {
      const idx = idxPorCodMod[claveCodMod(codMod)];
      if (idx === undefined) return;
      const actual = String(valoresJ[idx][0] == null ? '' : valoresJ[idx][0]);
      const dniActual = actual ? dniDeCodigoPersonal(actual) : '';
      if (dniActual && dniActual !== dniNorm) nReasignadas++;
      valoresJ[idx][0] = codigoPersonal;
      nMarcar++;
    });
    (desmarcar || []).forEach(function (codMod) {
      const idx = idxPorCodMod[claveCodMod(codMod)];
      if (idx === undefined) return;
      const actual = String(valoresJ[idx][0] == null ? '' : valoresJ[idx][0]);
      if (dniDeCodigoPersonal(actual) === dniNorm) {
        valoresJ[idx][0] = '';
        nDesmarcar++;
      }
    });
    rangoJ.setValues(valoresJ);
    invalidarCaches();

    return {
      ok: true,
      mensaje: 'Asignación guardada: ' + nMarcar + ' IIEE asignada(s)' +
        (nReasignadas ? (', ' + nReasignadas + ' reasignada(s)') : '') +
        (nDesmarcar ? (', ' + nDesmarcar + ' liberada(s)') : ''),
      nMarcar: nMarcar, nReasignadas: nReasignadas, nDesmarcar: nDesmarcar
    };
  } catch (error) {
    return { ok: false, mensaje: 'Error: ' + error.message };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ==================== REPORTES EXCEL (.xls) ====================
// % AVANCE: 100% VERDE · ≥70% AMARILLO · ≥50% NARANJA · <50% ROJO
function estiloPorAvance(pct) {
  if (pct >= 100) return 'background:#15803D;color:#FFFFFF;font-weight:bold';
  if (pct >= 70) return 'background:#FFC20E;color:#713F12;font-weight:bold';
  if (pct >= 50) return 'background:#F58220;color:#FFFFFF;font-weight:bold';
  return 'background:#DC2626;color:#FFFFFF;font-weight:bold';
}

function construirXlsHtml(op) {
  const fecha = Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'dd/MM/yyyy HH:mm');
  let h = '<html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif">';
  h += '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">' +
    '<tr><td colspan="12" style="background:' + COLORES.verde + ';color:#fff;font-size:16px;font-weight:bold;padding:10px">' + escaparHtml(op.titulo) + '</td></tr>' +
    '<tr><td colspan="12" style="background:#F0FDF9;color:' + COLORES.verde + ';font-size:11px;font-weight:bold;padding:6px">' + escaparHtml(op.subtitulo || '') + ' — Generado: ' + fecha + '</td></tr>' +
    '</table>';

  if (op.resumen && op.resumen.length) {
    h += '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:10px 0"><tr>';
    op.resumen.forEach(function (r) {
      h += '<td style="border:1px solid #CBD5E1;background:#F8FAFC;text-align:center;padding:8px 18px">' +
        '<span style="font-size:10px;color:#64748B">' + escaparHtml(r[0]) + '</span><br>' +
        '<b style="font-size:18px;color:' + COLORES.verde + '">' + escaparHtml(r[1]) + '</b></td>';
    });
    h += '</tr></table>';
  }

  (op.tablas || []).forEach(function (t) {
    const n = t.encabezados.length;
    h += '<table cellpadding="5" cellspacing="0" style="border-collapse:collapse;margin:12px 0">';
    if (t.tituloTabla) {
      h += '<tr><td colspan="' + n + '" style="background:' + COLORES.naranja + ';color:#fff;font-weight:bold;padding:6px">' + escaparHtml(t.tituloTabla) + '</td></tr>';
    }
    h += '<tr>' + t.encabezados.map(function (e) {
      return '<td style="background:' + COLORES.verde + ';color:#fff;font-weight:bold;border:1px solid ' + COLORES.verde + '">' + escaparHtml(e) + '</td>';
    }).join('') + '</tr>';
    t.filas.forEach(function (f) {
      h += '<tr>' + f.map(function (celda, idx) {
        let estilo = 'border:1px solid #CBD5E1';
        const texto = String(celda == null ? '' : celda);
        if (t.colEstado !== undefined && idx === t.colEstado) {
          if (texto === 'CARGADO') estilo += ';background:#DCFCE7;color:#166534;font-weight:bold';
          else if (texto === 'OBSERVADO') estilo += ';background:#FDE68A;color:#92400E;font-weight:bold';
          else estilo += ';background:#FFEDD5;color:#9A3412;font-weight:bold';
        }
        if (t.colPct !== undefined && idx === t.colPct) {
          const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(texto);
          if (m) estilo += ';' + estiloPorAvance(parseFloat(m[1]));
        }
        return '<td style="' + estilo + '">' + escaparHtml(texto) + '</td>';
      }).join('') + '</tr>';
    });
    h += '</table>';
  });

  h += '</body></html>';
  return h;
}

function generarBlobXls(html, nombreBase) {
  const nombre = limpiarParaNombre(nombreBase).replace(/\s+/g, '_') + '_' +
    Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'yyyyMMdd_HHmm') + '.xls';
  const blob = Utilities.newBlob(html, 'application/vnd.ms-excel', nombre);
  return { base64: Utilities.base64Encode(blob.getBytes()), nombre: nombre };
}

// Reporte del personal: listado plano + columna de observación + resumen con observados
function generarReportePersonal(dni, sid) {
  try {
    const datos = buscarPersonal(dni, sid);
    if (!datos.ok) return { ok: false, mensaje: datos.mensaje };

    let cargadas = 0, observadas = 0, conSigo = 0;
    const filas = (datos.iiees || []).map(function (i, idx) {
      const t = i.tramitador || {};
      if (i.estado === 'CARGADO') cargadas++;
      else if (i.estado === 'OBSERVADO') observadas++;
      else if (i.estado === 'SIGO') conSigo++;
      let obs = i.observacion ? (i.observacion.comentario || 'Observado') : '';
      if (i.estado === 'SIGO') {
        obs = 'Cargado al SIGO' +
          (i.sigo && i.sigo.fecha ? ' el ' + i.sigo.fecha : '') +
          (i.sigo && i.sigo.personal ? ' por ' + i.sigo.personal : '') +
          ' (sin archivo web)';
      }
      return [
        idx + 1,
        i.codRuta || '—',
        i.codMod,
        i.nombre,
        i.nivel,
        i.distrito,
        i.estado,
        obs,
        t.apellidos || '',
        t.celular || '',
        t.correo || '',
        t.fecha || ''
      ];
    });

    const html = construirXlsHtml({
      titulo: 'REPORTE DE CARGA — FORMATO CAE',
      subtitulo: 'Personal: ' + datos.apellidos + ' · Rutas asignadas: ' + ((datos.rutas || []).join(', ') || '—'),
      resumen: [
        ['Total de IIEE asignadas', datos.resumen.total],
        ['IIEE con formato cargado (web)', cargadas],
        ['Cargadas al SIGO (sin archivo web)', conSigo],
        ['Formatos observados', observadas],
        ['IIEE faltantes', datos.resumen.total - cargadas - conSigo - observadas]
      ],
      tablas: [{
        tituloTabla: 'LISTADO DE IIEE ASIGNADAS',
        encabezados: ['N°', 'RUTA', 'CÓD. MODULAR', 'NOMBRE DE LA IIEE', 'NIVEL', 'DISTRITO', 'ESTADO', 'OBSERVACIÓN', 'TRAMITADOR', 'CELULAR', 'CORREO', 'FECHA DE CARGA'],
        filas: filas, colEstado: 6
      }]
    });
    const r = generarBlobXls(html, 'Reporte_Personal_' + (datos.apellidos || ''));
    return { ok: true, base64: r.base64, nombre: r.nombre };
  } catch (error) {
    return { ok: false, mensaje: 'No se pudo generar el reporte: ' + error.message };
  }
}

// Reporte del administrador: resumen por personal CON columnas de observados
function generarReporteAdmin(clave, sid) {
  const va = validarClaveAdmin(clave, sid);
  if (!va.ok) return va;
  try {
    const asignaciones = obtenerAsignacionesPorPersonal();
    let total = 0, cargadas = 0, observadas = 0, sigo = 0;
    const filasResumen = [];

    asignaciones.forEach(function (p) {
      const nSigo = p.sigo || 0;
      total += p.iiees.length;
      cargadas += p.cargadas;
      sigo += nSigo;
      observadas += p.observadas;
      const atendidas = p.cargadas + nSigo;
      const pend = p.iiees.length - atendidas - p.observadas;
      filasResumen.push([
        p.apellidos,
        p.dni,
        p.rutas.join(', ') || '—',
        p.iiees.length,
        atendidas,
        nSigo,
        p.observadas,
        pend,
        (p.iiees.length ? Math.round(atendidas * 100 / p.iiees.length) : 0) + '%'
      ]);
    });
    filasResumen.push(['TOTAL GENERAL', '', '', total, cargadas + sigo, sigo, observadas, total - cargadas - sigo - observadas, (total ? Math.round((cargadas + sigo) * 100 / total) : 0) + '%']);

    const html = construirXlsHtml({
      titulo: 'REPORTE GENERAL PAE — CARGA DEL FORMATO CAE',
      subtitulo: 'Resumen por personal · Unidad Territorial Huancavelica',
      tablas: [{
        tituloTabla: 'RESUMEN POR PERSONAL',
        encabezados: ['PERSONAL', 'DNI', 'RUTAS ASIGNADAS', 'IIEE ASIGNADAS', 'CARGADAS (INCL. SIGO)', 'DE ELLAS AL SIGO', 'OBSERVADAS', 'PENDIENTES', '% AVANCE'],
        filas: filasResumen,
        colPct: 8
      }]
    });
    const r = generarBlobXls(html, 'Reporte_General_PAE');
    return { ok: true, base64: r.base64, nombre: r.nombre };
  } catch (error) {
    return { ok: false, mensaje: 'No se pudo generar el reporte: ' + error.message };
  }
}
