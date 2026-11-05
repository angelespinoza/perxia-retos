// Puerta de confirmación humana (CA3 / RN4): garantizada en código, no solo en el prompt.
import { z } from "zod"
import { ok } from "./result.ts"
import type { ConfirmacionTurno, ToolCtx } from "./types.ts"

export const NOMBRE_PSEUDO = "agente_solicitar_confirmacion"

/** Pseudo-herramienta: al llamarla el ciclo termina el turno y espera la respuesta del usuario. */
export const solicitar_confirmacion = {
  description:
    "Pide al usuario confirmación explícita antes de una acción externa (enviar, registrar, crear) y termina el turno.",
  args: {
    accion: z.string().describe("Acción que requiere confirmación, por ejemplo 'registrar'"),
    referencia: z.string().describe("Caso o mensaje sobre el que se actuará, por ejemplo 'msg-006'"),
    resumen: z.string().describe("Una o dos frases con lo que pasará si el usuario confirma"),
  },
  efecto: "lectura" as const,
  async execute(args: { accion: string; referencia: string; resumen: string }, _ctx: ToolCtx) {
    return ok({ estado: "esperando_confirmacion", accion: args.accion, referencia: args.referencia })
  },
}

const NEGACION = /^(no|nop|cancela|cancelar|espera|todavia no|aun no|detente|para)\b/
const AFIRMACION =
  /\b(si|confirmo|confirmado|confirma|procede|proceder|adelante|ok|okay|dale|envia|enviar|enviala|envialo|registra|registralo|crea|crear|creala|de acuerdo|correcto|hazlo|aprobado|apruebo|autorizo)\b/

export function normalizarTexto(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
}

export function esAfirmativo(mensaje: string): boolean {
  const texto = normalizarTexto(mensaje)
  if (NEGACION.test(texto)) return false
  return AFIRMACION.test(texto)
}

/** La confirmación vale solo para el turno inmediatamente posterior a la pregunta. */
export function resolverConfirmacion(
  pendiente: ConfirmacionTurno | null,
  mensajeUsuario: string,
): ConfirmacionTurno | null {
  return pendiente && esAfirmativo(mensajeUsuario) ? pendiente : null
}

function referenciaDe(args: Record<string, unknown>): string | null {
  for (const clave of ["caso", "mensaje_id", "referencia"]) {
    const valor = args[clave]
    if (typeof valor === "string") return valor
  }
  return null
}

/** Devuelve un error si la herramienta afirma `confirmado: true` sin confirmación válida en este turno. */
export function verificarConfirmacion(args: Record<string, unknown>, ctx: ToolCtx): string | null {
  if (args.confirmado !== true) return null
  const referencia = referenciaDe(args)
  if (ctx.confirmacion && (!referencia || ctx.confirmacion.referencia === referencia)) return null
  return "requiere confirmación explícita: llama a agente_solicitar_confirmacion y espera la respuesta del usuario"
}
