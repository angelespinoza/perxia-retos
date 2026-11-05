// Utilidades puras de texto en español: normalización, números en letras, montos, fechas, slug y similitud.

export class ErrorExtraccion extends Error {
  constructor(mensaje: string) {
    super(mensaje)
    this.name = "ErrorExtraccion"
  }
}

export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export type Moneda = (typeof MONEDAS)[number]

export function esMoneda(valor: string): valor is Moneda {
  return (MONEDAS as readonly string[]).includes(valor)
}

/** Minúsculas y sin tildes, para comparar sin depender de mayúsculas ni acentos. */
export function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
}

// ---------- números en letras ----------

const UNIDADES: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500,
  seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
}

/** "DOSCIENTOS SESENTA Y CINCO MILLONES DE PESOS" → 265000000. Ignora palabras que no son números. */
export function numeroEnLetras(texto: string): number | null {
  let total = 0
  let actual = 0
  let encontrado = false
  for (const palabra of normalizar(texto).split(/[^a-z]+/)) {
    if (palabra in UNIDADES) {
      actual += UNIDADES[palabra] ?? 0
      encontrado = true
    } else if (palabra === "mil") {
      actual = (actual || 1) * 1000
      encontrado = true
    } else if (palabra === "millon" || palabra === "millones") {
      total += (actual || 1) * 1_000_000
      actual = 0
      encontrado = true
    }
  }
  return encontrado ? total + actual : null
}

// ---------- montos ----------

/** Cifra según la convención de la moneda: COP usa punto de miles; USD, PEN, PAB y HNL usan coma de miles. */
export function parsearCifra(cifra: string, moneda: Moneda): number {
  const limpia = cifra.replace(/[$\s]/g, "")
  const puntoMiles = moneda === "COP"
  const patron = puntoMiles ? /^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/ : /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/
  if (!patron.test(limpia)) throw new ErrorExtraccion(`monto con formato inválido para ${moneda}: ${cifra}`)
  const sinMiles = puntoMiles ? limpia.replace(/\./g, "").replace(",", ".") : limpia.replace(/,/g, "")
  return Number(sinMiles)
}

// ---------- fechas ----------

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

export function esFechaIso(valor: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor)
  if (!m) return false
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const fecha = new Date(Date.UTC(a, mes - 1, d))
  return fecha.getUTCFullYear() === a && fecha.getUTCMonth() === mes - 1 && fecha.getUTCDate() === d
}

function iso(a: number, mes: number, d: number): string {
  return `${a}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

/** Día, nombre del mes y año en español → YYYY-MM-DD. Lanza "fecha inválida" si no existe. */
export function fechaDesdeTexto(dia: number, mes: string, anio: number): string {
  const numeroMes = MESES[normalizar(mes)]
  const fecha = numeroMes ? iso(anio, numeroMes, dia) : ""
  if (!numeroMes || !esFechaIso(fecha)) throw new ErrorExtraccion(`fecha inválida: ${dia} de ${mes} de ${anio}`)
  return fecha
}

export function numeroDeMes(mes: string): number | null {
  return MESES[normalizar(mes)] ?? null
}

/** Último día del mes (mes 1-12; admite desbordes, p. ej. 20 = agosto del año siguiente). */
export function finDeMes(anio: number, mes: number): string {
  const fecha = new Date(Date.UTC(anio, mes, 0))
  return iso(fecha.getUTCFullYear(), fecha.getUTCMonth() + 1, fecha.getUTCDate())
}

/** Plazo de n meses desde `inicio` (incluido): inicio + n meses − 1 día. */
export function finDePlazo(inicio: string, meses: number): string {
  const [a, m, d] = inicio.split("-").map(Number) as [number, number, number]
  const objetivo = new Date(Date.UTC(a, m - 1 + meses, 1))
  const ultimo = new Date(Date.UTC(objetivo.getUTCFullYear(), objetivo.getUTCMonth() + 1, 0)).getUTCDate()
  const fecha = new Date(Date.UTC(objetivo.getUTCFullYear(), objetivo.getUTCMonth(), Math.min(d, ultimo)))
  fecha.setUTCDate(fecha.getUTCDate() - 1)
  return fecha.toISOString().slice(0, 10)
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000)
}

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

// ---------- nombres, slug y similitud ----------

const SUFIJOS_SOCIETARIOS = /\b(s\.?\s?a\.?\s?s\.?|s\.?\s?a\.?\s?c\.?|s\.?\s?a\.?|s\.?\s?de\s?r\.?\s?l\.?|ltda\.?|e\.?\s?i\.?\s?r\.?\s?l\.?)\s*$/i

/** "Industrias Delta S.A.S." → "industrias-delta" (sin forma societaria), igual que las carpetas del maestro. */
export function slug(nombre: string): string {
  const base = normalizar(nombre).replace(SUFIJOS_SOCIETARIOS, "")
  return base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sin-cliente"
}

const VACIAS = new Set([
  "de", "la", "el", "los", "las", "y", "e", "o", "u", "a", "en", "para", "por", "con", "del", "al", "un", "una",
  "su", "sus", "que", "se", "lo",
])

export function tokens(texto: string): Set<string> {
  return new Set(normalizar(texto).split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !VACIAS.has(t)))
}

/** Similitud de Jaccard entre los tokens significativos de dos textos (0 a 1). */
export function jaccard(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 && tb.size === 0) return 1
  let comunes = 0
  for (const t of ta) if (tb.has(t)) comunes++
  return comunes / (ta.size + tb.size - comunes)
}
