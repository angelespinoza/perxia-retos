// Estado del buzón en out/ (en la web, dentro del espacio de la sesión): procesados, copia del maestro y análisis.
import type { ToolCtx } from "../core/types.ts"
import { type Fila, siguienteAuto, type Validacion } from "./clasificacion.ts"
import { parsearCsv, type Tabla } from "./csv.ts"
import { type Extraccion, extraerContrato } from "./extraccion.ts"
import { type Adjunto, type Correo, documentoContrato, leerAdjuntos, leerCorreo, leerMaestroFixture, motivoSinContrato } from "./fixtures.ts"

export const RUTA_MAESTRO = "sharepoint/maestro-contratos.csv"
export const RUTA_HISTORIAL = "sharepoint/historial.jsonl"
export const RUTA_PROCESADOS = "procesados.json"
export const RUTA_ALERTAS = "alertas.md"

export interface Procesado {
  clasificacion: string
  accion: string
  id_contrato: string
  fecha: string
  motivo?: string
}

export async function leerProcesados(ctx: ToolCtx): Promise<Record<string, Procesado>> {
  const texto = await ctx.storage.leerTexto(RUTA_PROCESADOS)
  return texto ? (JSON.parse(texto) as Record<string, Procesado>) : {}
}

export async function marcarProcesado(ctx: ToolCtx, id: string, p: Procesado): Promise<void> {
  const actuales = await leerProcesados(ctx)
  await ctx.storage.escribir(RUTA_PROCESADOS, JSON.stringify({ ...actuales, [id]: p }, null, 2))
}

/** Copia de trabajo del maestro; el fixture nunca se modifica (RN6). */
export async function leerMaestro(ctx: ToolCtx): Promise<Tabla> {
  return parsearCsv((await ctx.storage.leerTexto(RUTA_MAESTRO)) ?? (await leerMaestroFixture(ctx.directory)))
}

/** La primera escritura copia el fixture a out/sharepoint/ (RN6). */
export async function asegurarMaestro(ctx: ToolCtx): Promise<Tabla> {
  const copia = await ctx.storage.leerTexto(RUTA_MAESTRO)
  if (copia) return parsearCsv(copia)
  const original = await leerMaestroFixture(ctx.directory)
  await ctx.storage.escribir(RUTA_MAESTRO, original)
  return parsearCsv(original)
}


export interface Analisis {
  correo: Correo
  documento: Adjunto | null
  extraccion: Extraccion | null
  motivo?: string
}

export async function analizar(ctx: ToolCtx, id: string, maestro: Fila[]): Promise<Analisis> {
  const correo = await leerCorreo(ctx.directory, id)
  const adjuntos = await leerAdjuntos(ctx.directory, correo)
  const documento = documentoContrato(adjuntos)
  if (!documento) return { correo, documento, extraccion: null, motivo: motivoSinContrato(adjuntos) }
  const extraccion = extraerContrato(documento.texto)
  if (!extraccion.contrato.id_contrato) {
    const anio = (extraccion.contrato.fecha_inicio ?? correo.fecha).slice(0, 4)
    extraccion.contrato.id_contrato = siguienteAuto(maestro, anio)
    extraccion.confianza.id_contrato = 0.5
    extraccion.avisos.push("el documento no trae número de contrato: se asigna un identificador AUTO")
  }
  return { correo, documento, extraccion }
}

export function textoRevision(v: Validacion): string {
  return v.requiere_revision.map((c) => `${c} (${v.motivos_revision[c] ?? "revisar"})`).join(", ")
}
