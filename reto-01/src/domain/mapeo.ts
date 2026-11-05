// Mapeo determinista de etiquetas del cliente a claves del maestro (HU-2, RN1, RN2).
import type { Glosario, Maestro } from "./fixtures.ts"

export type EstadoCampo = "lleno" | "faltante" | "requiere_confirmacion"
export type ValorCampo = string | number | boolean

export interface CampoMapeado {
  etiqueta: string
  estado: EstadoCampo
  confianza: number
  clave?: string
  ruta_maestro?: string
  valor?: ValorCampo
  nota?: string
}

/** RN1: identificador tributario por país. */
export const IDENTIFICADOR_POR_PAIS: Record<string, string> = { CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" }

/** Etiquetas que no dicen qué identificador piden: siempre se confirman (HU-1). */
const ETIQUETAS_AMBIGUAS = new Set(["identificacion tributaria", "numero de identificacion fiscal"])

const UMBRAL_LLENO = 0.8
const UMBRAL_PROPUESTA = 0.5
const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "o", "para", "por", "a", "en", "e", "al"])

export function normalizarEtiqueta(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function tokens(texto: string): Set<string> {
  return new Set(normalizarEtiqueta(texto).split(" ").filter((t) => t && !STOPWORDS.has(t)))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let comunes = 0
  for (const t of a) if (b.has(t)) comunes++
  return comunes / (a.size + b.size - comunes)
}

/** Busca la clave del maestro para una etiqueta: exacta (1.0) o por similitud de palabras. */
export function buscarClave(etiqueta: string, glosario: Glosario): { clave: string; confianza: number } | null {
  const objetivo = normalizarEtiqueta(etiqueta)
  let mejor: { clave: string; confianza: number } | null = null
  for (const [sinonimo, clave] of Object.entries(glosario)) {
    if (normalizarEtiqueta(sinonimo) === objetivo) return { clave, confianza: 1 }
    const confianza = Math.round(jaccard(tokens(sinonimo), tokens(etiqueta)) * 100) / 100
    if (!mejor || confianza > mejor.confianza) mejor = { clave, confianza }
  }
  return mejor
}

export function resolverRuta(maestro: Maestro, ruta: string): unknown {
  let actual: unknown = maestro
  for (const parte of ruta.split(".")) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return undefined
    actual = (actual as Record<string, unknown>)[parte]
  }
  return actual
}

function comoValor(valor: unknown): ValorCampo | undefined {
  if (typeof valor === "string") return valor.trim() === "" ? undefined : valor
  if (typeof valor === "number" || typeof valor === "boolean") return valor
  return undefined
}

function notaContexto(clave: string, maestro: Maestro): string | undefined {
  if (clave === "ingresos_ultimo_ano.valor") {
    const moneda = resolverRuta(maestro, "ingresos_ultimo_ano.moneda")
    const ano = resolverRuta(maestro, "ingresos_ultimo_ano.ano")
    return `valor en ${String(moneda ?? "COP")} del año ${String(ano ?? "")}`.trim()
  }
  return undefined
}

export function mapearCampo(etiqueta: string, pais: string, maestro: Maestro, glosario: Glosario): CampoMapeado {
  const encontrado = buscarClave(etiqueta, glosario)
  if (!encontrado || encontrado.confianza < UMBRAL_PROPUESTA)
    return { etiqueta, estado: "faltante", confianza: encontrado?.confianza ?? 0, nota: "sin equivalente en el maestro" }

  const { clave, confianza } = encontrado
  const valor = comoValor(resolverRuta(maestro, clave))
  if (valor === undefined)
    return { etiqueta, estado: "faltante", confianza, clave, nota: `el maestro no tiene valor para ${clave}` }

  const base: CampoMapeado = { etiqueta, estado: "lleno", confianza, clave, ruta_maestro: clave, valor }
  const contexto = notaContexto(clave, maestro)
  if (contexto) base.nota = contexto

  if (confianza < UMBRAL_LLENO)
    return { ...base, estado: "requiere_confirmacion", nota: `mapeo aproximado (confianza ${confianza}) a ${clave}` }

  if (clave === "nit") {
    const equivalente = IDENTIFICADOR_POR_PAIS[pais.toUpperCase()] ?? "identificador tributario"
    if (pais.toUpperCase() !== "CO")
      return {
        ...base,
        estado: "requiere_confirmacion",
        nota: `identificador extranjero: el cliente pide ${equivalente}; Periferia solo tiene NIT colombiano`,
      }
    if (ETIQUETAS_AMBIGUAS.has(normalizarEtiqueta(etiqueta)))
      return { ...base, estado: "requiere_confirmacion", nota: `etiqueta ambigua: en ${pais} equivale a ${equivalente}` }
  }
  return base
}

export interface ResultadoMapeo {
  llenos: CampoMapeado[]
  faltantes: CampoMapeado[]
  requiere_confirmacion: CampoMapeado[]
}

export function mapearCampos(etiquetas: string[], pais: string, maestro: Maestro, glosario: Glosario): CampoMapeado[] {
  return etiquetas.map((e) => mapearCampo(e, pais, maestro, glosario))
}

export function agrupar(campos: CampoMapeado[]): ResultadoMapeo {
  return {
    llenos: campos.filter((c) => c.estado === "lleno"),
    faltantes: campos.filter((c) => c.estado === "faltante"),
    requiere_confirmacion: campos.filter((c) => c.estado === "requiere_confirmacion"),
  }
}

/** Detecta etiquetas que piden un identificador tributario y propone el equivalente del país (HU-1). */
export function camposAmbiguos(etiquetas: string[], pais: string, glosario: Glosario): { etiqueta: string; propuesta: string }[] {
  const equivalente = IDENTIFICADOR_POR_PAIS[pais.toUpperCase()] ?? "identificador tributario"
  return etiquetas.flatMap((etiqueta) => {
    const clave = buscarClave(etiqueta, glosario)
    const esIdentificador = clave?.clave === "nit" && clave.confianza >= UMBRAL_LLENO
    const ambigua = ETIQUETAS_AMBIGUAS.has(normalizarEtiqueta(etiqueta))
    if (!esIdentificador || (!ambigua && pais.toUpperCase() === "CO")) return []
    return [{ etiqueta, propuesta: `${equivalente} (${pais.toUpperCase()}); Periferia tiene NIT colombiano` }]
  })
}
