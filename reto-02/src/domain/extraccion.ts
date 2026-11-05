// Extracción determinista del contrato desde su texto, con confianza y evidencia por campo (HU-2).
import {
  ErrorExtraccion,
  esMoneda,
  fechaDesdeTexto,
  finDeMes,
  finDePlazo,
  type Moneda,
  numeroDeMes,
  numeroEnLetras,
  parsearCifra,
} from "./texto.ts"

export const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
export type Pais = (typeof PAISES)[number]

/** Campos del esquema 7.2 que salen del documento (el resto los calcula el registro). */
export const CAMPOS = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
] as const
export type Campo = (typeof CAMPOS)[number]

export interface Contrato {
  id_contrato: string | null
  cliente: string | null
  nit_cliente: string | null
  pais: Pais | null
  objeto: string | null
  valor: number | null
  moneda: Moneda | null
  fecha_inicio: string | null
  fecha_fin: string | null
  requiere_poliza: boolean | null
  tipo_poliza: string | null
  es_otrosi: boolean
  numero_otrosi: number | null
  valor_indeterminado: boolean
}

export interface Extraccion {
  contrato: Contrato
  confianza: Record<Campo, number>
  /** Fragmento del documento del que salió cada campo (para la revisión humana). */
  evidencia: Partial<Record<Campo, string>>
  avisos: string[]
}

/** NIT de Periferia IT Group: nunca es la contraparte. */
export const NIT_PERIFERIA = "900123456"

type Hallazgo<T> = { valor: T | null; confianza: number; evidencia?: string; aviso?: string }
const nada = <T>(): Hallazgo<T> => ({ valor: null, confianza: 0 })

const recortar = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

/** Párrafos del documento (separados por línea en blanco). */
function parrafos(texto: string): string[] {
  return texto.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean)
}

function clausula(ps: string[], patron: RegExp): string | null {
  return ps.find((p) => patron.test(p)) ?? null
}

// ---------- identificación ----------

function extraerOtrosi(primera: string): { es: boolean; numero: number | null } {
  const m = /^OTROS[ÍI]\s+No\.\s*(\d+)/i.exec(primera)
  return { es: Boolean(m), numero: m ? Number(m[1]) : null }
}

function extraerId(primera: string): Hallazgo<string> {
  const m = /No\.\s*([A-Z]{2}-\d{4}-\d+)/.exec(primera)
  return m?.[1] ? { valor: m[1], confianza: 1, evidencia: recortar(primera) } : nada()
}

interface Parte {
  nombre: string
  tipo: "NIT" | "RUC" | "RTN"
  id: string
  contexto: string
}

function normalizarId(tipo: Parte["tipo"], crudo: string): string {
  const sinPuntos = crudo.replace(/\./g, "")
  return (tipo === "NIT" ? sinPuntos.replace(/-\d$/, "") : sinPuntos).replace(/\D/g, "")
}

/** Partes del preámbulo: «NOMBRE EN MAYÚSCULAS, [identificada con] NIT|RUC|RTN <número>». */
function extraerPartes(preambulo: string): Parte[] {
  const patron = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 .&-]*[A-ZÁÉÍÓÚÑ.]),\s*(?:identificad[ao] con\s+)?(NIT|RUC|RTN)\s+([\d.-]*\d)/g
  const partes: Parte[] = []
  for (const m of preambulo.matchAll(patron)) {
    const tipo = m[2] as Parte["tipo"]
    const inicio = m.index ?? 0
    partes.push({ nombre: (m[1] ?? "").trim(), tipo, id: normalizarId(tipo, m[3] ?? ""), contexto: preambulo.slice(inicio, inicio + 260) })
  }
  return partes
}

/** Usa la grafía del bloque de firmas ("Industrias Delta S.A.S.") si el documento la trae. */
function grafiaNatural(texto: string, nombre: string): string | null {
  const minusculas = nombre.toLowerCase()
  for (const linea of texto.split("\n")) {
    const i = linea.toLowerCase().indexOf(minusculas)
    if (i < 0) continue
    const candidato = linea.slice(i, i + nombre.length)
    if (candidato !== candidato.toUpperCase()) return candidato
  }
  return null
}

function tituloSimple(nombre: string): string {
  return nombre.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, esp: string, l: string) => esp + l.toUpperCase())
}

const PAIS_POR_TEXTO: [RegExp, Pais][] = [
  [/colombia|bogot[aá]|medell[ií]n|barranquilla|cali\b|cartagena/i, "CO"],
  [/ecuador|quito|guayaquil/i, "EC"],
  [/per[uú]\b|lima\b|arequipa/i, "PE"],
  [/panam[aá]/i, "PA"],
  [/honduras|tegucigalpa|san pedro sula/i, "HN"],
]

function paisDe(parte: Parte): Hallazgo<Pais> {
  const porId: Pais | null =
    parte.tipo === "NIT" ? "CO" : parte.tipo === "RTN" ? "HN" : parte.id.length === 13 ? "EC" : parte.id.length === 11 ? "PE" : null
  if (porId) return { valor: porId, confianza: 0.9, evidencia: `${parte.tipo} ${parte.id}` }
  const domicilio = /domicilio en ([^,]+(?:, [^,]+)?)/i.exec(parte.contexto)?.[1] ?? parte.contexto
  const porTexto = PAIS_POR_TEXTO.find(([re]) => re.test(domicilio))
  return porTexto ? { valor: porTexto[1], confianza: 0.7, evidencia: recortar(domicilio) } : nada()
}

// ---------- objeto ----------

function extraerObjeto(ps: string[]): Hallazgo<string> {
  const p = clausula(ps, /\bOBJETO\.\s/)
  const m = p ? /\bOBJETO\.\s*(.+?\.)(?=\s|$)/.exec(p) : null
  if (!m?.[1]) return nada()
  let objeto = m[1].trim()
  if (objeto.length > 200) objeto = `${objeto.slice(0, 199).replace(/\s+\S*$/, "")}…`
  return { valor: objeto, confianza: 0.9, evidencia: recortar(m[1]) }
}

// ---------- valor y moneda ----------

interface Monto {
  valor: Hallazgo<number>
  moneda: Hallazgo<Moneda>
  indeterminado: boolean
}

function extraerMonto(ps: string[], texto: string): Monto {
  const p = clausula(ps, /\bVALOR\b/)
  if (!p) return { valor: nada(), moneda: monedaMencionada(texto), indeterminado: false }
  if (/no tiene un valor determinado|valor indeterminado|por demanda/i.test(p)) {
    return {
      valor: { valor: 0, confianza: 0.6, evidencia: recortar(p), aviso: "valor por demanda: se propone 0 (valor_indeterminado)" },
      moneda: monedaMencionada(texto),
      indeterminado: true,
    }
  }
  const desconocida = /\b([A-Z]{3})\s*\$?\s*\d/.exec(p)
  if (desconocida?.[1] && !esMoneda(desconocida[1])) throw new ErrorExtraccion(`moneda desconocida: ${desconocida[1]}`)
  const m = /\b(COP|USD|PEN|PAB|HNL)\s*\$?\s*(\d[\d.,]*\d|\d)/.exec(p)
  if (!m?.[1] || !m[2]) return { valor: nada(), moneda: nada(), indeterminado: false }
  const moneda = m[1] as Moneda
  const cifra = parsearCifra(m[2], moneda)
  const letras = /\b(?:es|ser[áa]) de\s+([^()]+)\(/i.exec(p)?.[1]
  const enLetras = letras ? numeroEnLetras(letras) : null
  const evidencia = recortar(p.slice(Math.max(0, p.search(/\b(?:es|ser[áa]) de\b/i))))
  const valor: Hallazgo<number> =
    enLetras === null
      ? { valor: cifra, confianza: 0.85, evidencia, aviso: "valor sin cifra en letras para contrastar" }
      : enLetras === cifra
        ? { valor: cifra, confianza: 0.95, evidencia }
        : { valor: cifra, confianza: 0.5, evidencia, aviso: `la cifra (${cifra}) no coincide con el valor en letras (${enLetras})` }
  return { valor, moneda: { valor: moneda, confianza: 0.95, evidencia: `${m[1]} ${m[2]}` }, indeterminado: false }
}

/** Sin cifra del contrato: moneda mencionada en otra cláusula (p. ej. el umbral de las garantías). */
function monedaMencionada(texto: string): Hallazgo<Moneda> {
  const m = /\b(COP|USD|PEN|PAB|HNL)\b\s*\$?\s*\d/.exec(texto)
  return m?.[1] ? { valor: m[1] as Moneda, confianza: 0.85, evidencia: recortar(m[0]) } : nada()
}

// ---------- plazo ----------

interface Plazo {
  inicio: Hallazgo<string>
  fin: Hallazgo<string>
}

const FECHA = /\((\d{1,2})\)\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/gi

function fechasEn(texto: string): { fecha: string; indice: number }[] {
  return [...texto.matchAll(FECHA)].map((m) => ({
    fecha: fechaDesdeTexto(Number(m[1]), m[2] ?? "", Number(m[3])),
    indice: m.index ?? 0,
  }))
}

function extraerPlazo(ps: string[], texto: string): Plazo {
  const p = clausula(ps, /\bPLAZO\b/)
  if (!p) return { inicio: nada(), fin: nada() }
  const evidencia = recortar(p)
  const fechas = fechasEn(p)
  const desde = p.search(/\bdesde\b/i)
  const hasta = p.search(/\bhasta\b/i)
  const inicio = desde >= 0 ? fechas.find((f) => f.indice > desde && (hasta < 0 || f.indice < hasta)) : undefined
  const fin = hasta >= 0 ? fechas.find((f) => f.indice > hasta) : undefined
  const meses = Number(/\((\d{1,3})\)\s+mes(?:es)?\b/i.exec(p)?.[1] ?? Number.NaN)

  const hInicio: Hallazgo<string> = inicio ? { valor: inicio.fecha, confianza: 0.95, evidencia } : nada()
  if (fin) return { inicio: hInicio, fin: { valor: fin.fecha, confianza: 0.95, evidencia } }
  if (inicio && Number.isFinite(meses))
    return { inicio: hInicio, fin: { valor: finDePlazo(inicio.fecha, meses), confianza: 0.85, evidencia, aviso: `fecha_fin derivada de ${meses} meses` } }
  if (Number.isFinite(meses) && /fecha de su firma|desde la firma/i.test(p)) return plazoDesdeFirma(texto, meses, evidencia)
  return { inicio: hInicio, fin: nada() }
}

/** Plazo contado desde la firma: fecha exacta si el documento la trae; si solo dice el mes, se aproxima. */
function plazoDesdeFirma(texto: string, meses: number, evidencia: string): Plazo {
  const exacta = /a los\s+[^()]*\((\d{1,2})\)\s+d[ií]as del mes de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(texto)
  if (exacta) {
    const firma = fechaDesdeTexto(Number(exacta[1]), exacta[2] ?? "", Number(exacta[3]))
    return {
      inicio: { valor: firma, confianza: 0.85, evidencia: recortar(exacta[0]) },
      fin: { valor: finDePlazo(firma, meses), confianza: 0.85, evidencia, aviso: `fecha_fin derivada de ${meses} meses desde la firma` },
    }
  }
  const mes = /en el mes de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(texto)
  const numeroMes = mes ? numeroDeMes(mes[1] ?? "") : null
  if (!mes || !numeroMes) return { inicio: nada(), fin: nada() }
  const anio = Number(mes[2])
  return {
    inicio: {
      valor: `${anio}-${String(numeroMes).padStart(2, "0")}-01`,
      confianza: 0.8,
      evidencia: recortar(mes[0]),
      aviso: "fecha_inicio: el documento solo indica el mes de la firma; se toma el día 1",
    },
    fin: {
      valor: finDeMes(anio, numeroMes + meses),
      confianza: 0.6,
      evidencia,
      aviso: `fecha_fin aproximada: ${meses} meses desde una firma sin día; se propone el último día del mes`,
    },
  }
}

// ---------- pólizas ----------

const TIPOS_POLIZA: [RegExp, string][] = [
  [/cumplimiento/i, "cumplimiento"],
  [/calidad/i, "calidad"],
  [/salarios|prestaciones sociales/i, "salarios_prestaciones"],
  [/responsabilidad civil/i, "responsabilidad_civil"],
  [/anticipo/i, "anticipo"],
  [/estabilidad/i, "estabilidad"],
]

interface Poliza {
  requiere: Hallazgo<boolean>
  tipo: Hallazgo<string>
}

function extraerPoliza(ps: string[]): Poliza {
  const p = clausula(ps, /GARANT[ÍI]AS|p[óo]liza/i)
  if (!p) return { requiere: { valor: false, confianza: 0.9, evidencia: "sin cláusula de garantías" }, tipo: { valor: "", confianza: 0.9 } }
  const evidencia = recortar(p)
  if (/para cada orden|cuyo valor supere|en caso de que/i.test(p)) {
    const aviso = "póliza condicional por orden de servicio: se gestiona en cada orden, no en el contrato marco"
    return { requiere: { valor: false, confianza: 0.85, evidencia, aviso }, tipo: { valor: "", confianza: 0.85, evidencia } }
  }
  const tipos = TIPOS_POLIZA.filter(([re]) => re.test(p)).map(([, t]) => t)
  return {
    requiere: { valor: true, confianza: 0.9, evidencia },
    tipo: tipos.length ? { valor: tipos.join(";"), confianza: 0.9, evidencia } : { valor: null, confianza: 0.5, evidencia },
  }
}

// ---------- ensamblado ----------

export function extraerContrato(texto: string): Extraccion {
  if (texto.trim() === "") throw new ErrorExtraccion("texto vacío: el adjunto no tiene contenido")
  const ps = parrafos(texto)
  const primera = ps[0] ?? ""
  const otrosi = extraerOtrosi(primera)
  const preambulo = ps.slice(0, 3).join(" ")
  const contraparte = extraerPartes(preambulo).find((p) => p.id !== NIT_PERIFERIA)
  const nombre = contraparte ? (grafiaNatural(texto, contraparte.nombre) ?? tituloSimple(contraparte.nombre)) : null

  const hallazgos: Record<Campo, Hallazgo<unknown>> = {
    id_contrato: extraerId(primera),
    cliente: contraparte && nombre
      ? { valor: nombre, confianza: nombre === tituloSimple(contraparte.nombre) ? 0.85 : 0.95, evidencia: recortar(contraparte.contexto) }
      : nada(),
    nit_cliente: contraparte ? { valor: contraparte.id, confianza: 0.95, evidencia: recortar(contraparte.contexto, 120) } : nada(),
    pais: contraparte ? paisDe(contraparte) : nada(),
    objeto: extraerObjeto(ps),
    valor: nada(),
    moneda: nada(),
    fecha_inicio: nada(),
    fecha_fin: nada(),
    requiere_poliza: nada(),
    tipo_poliza: nada(),
  }
  const monto = extraerMonto(ps, texto)
  const plazo = extraerPlazo(ps, texto)
  const poliza = extraerPoliza(ps)
  Object.assign(hallazgos, {
    valor: monto.valor,
    moneda: monto.moneda,
    fecha_inicio: plazo.inicio,
    fecha_fin: plazo.fin,
    requiere_poliza: poliza.requiere,
    tipo_poliza: poliza.tipo,
  })

  const valor = <T>(c: Campo) => hallazgos[c].valor as T | null
  const contrato: Contrato = {
    id_contrato: valor<string>("id_contrato"),
    cliente: valor<string>("cliente"),
    nit_cliente: valor<string>("nit_cliente"),
    pais: valor<Pais>("pais"),
    objeto: valor<string>("objeto"),
    valor: valor<number>("valor"),
    moneda: valor<Moneda>("moneda"),
    fecha_inicio: valor<string>("fecha_inicio"),
    fecha_fin: valor<string>("fecha_fin"),
    requiere_poliza: valor<boolean>("requiere_poliza"),
    tipo_poliza: valor<string>("tipo_poliza"),
    es_otrosi: otrosi.es,
    numero_otrosi: otrosi.numero,
    valor_indeterminado: monto.indeterminado,
  }
  const avisos = Object.values(hallazgos).flatMap((h) => (h.aviso ? [h.aviso] : []))
  if (contrato.fecha_inicio && contrato.fecha_fin && contrato.fecha_fin < contrato.fecha_inicio) {
    hallazgos.fecha_fin.confianza = 0.5
    avisos.push("fecha_fin anterior a fecha_inicio")
  }
  return {
    contrato,
    confianza: Object.fromEntries(CAMPOS.map((c) => [c, hallazgos[c].confianza])) as Record<Campo, number>,
    evidencia: Object.fromEntries(CAMPOS.flatMap((c) => (hallazgos[c].evidencia ? [[c, hallazgos[c].evidencia]] : []))),
    avisos,
  }
}

/** ¿El adjunto es un contrato u otrosí? Por nombre del archivo y por contenido (encabezado y partes). */
export function pareceContrato(nombreArchivo: string, texto: string): boolean {
  const encabezado = texto.trimStart().split("\n")[0] ?? ""
  const porContenido = /^(CONTRATO|OTROS[ÍI])(?=\s)/i.test(encabezado) && /CONTRATANTE|CONTRATISTA/.test(texto)
  return porContenido || (/contrato|otros[ií]/i.test(nombreArchivo) && texto.trim() === "")
}
