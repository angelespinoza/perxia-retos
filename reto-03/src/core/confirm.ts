// Puerta de confirmación humana (CA3 / RN4): garantizada en código, no solo en el prompt.
//
// Reglas:
// - Los verbos de orden («envía», «registra», «crea») son pedidos, no confirmaciones.
// - La pregunta de confirmación la arma el código a partir de la acción pendiente (con advertencia
//   si el paquete u OC no está listo), no el modelo.
// - Solo confirman el botón Confirmar o un «sí» / «confirmo» en el turno siguiente a esa pregunta.
import { z } from "zod"
import { fail, ok } from "./result.ts"
import type { ConfirmacionTurno, ToolCtx } from "./types.ts"

export const NOMBRE_PSEUDO = "agente_solicitar_confirmacion"

/** Lo que el reto sabe de cada acción: si el usuario debe pedirla y cómo se pregunta. */
export interface PoliticaConfirmacion {
  /** Acciones que el agente solo puede proponer si el usuario las pidió en su mensaje (texto normalizado). */
  requierePedido?: Record<string, RegExp>
  /** Pregunta y advertencia armadas desde el estado real; `error` si la acción no se puede confirmar todavía. */
  describir(p: ConfirmacionTurno, ctx: ToolCtx): Promise<{ pregunta: string; advertencia?: string } | { error: string }>
}

/** Pseudo-herramienta: al llamarla con éxito el ciclo termina el turno y espera la respuesta del usuario. */
export function crearSolicitarConfirmacion(politica: PoliticaConfirmacion, ejemploAccion: string, ejemploReferencia: string) {
  return {
    description:
      "Deja una acción externa pendiente de confirmación del usuario y termina el turno. El sistema escribe la pregunta; tú solo escribe el resumen.",
    args: {
      accion: z.string().describe(`Acción que requiere confirmación, por ejemplo '${ejemploAccion}'`),
      referencia: z.string().describe(`Caso o mensaje sobre el que se actuará, por ejemplo '${ejemploReferencia}'`),
      resumen: z.string().describe("Una o dos frases con lo que pasará si el usuario confirma"),
    },
    efecto: "lectura" as const,
    async execute(args: { accion: string; referencia: string; resumen: string }, ctx: ToolCtx) {
      // Fuera del ciclo propio (por ejemplo, modulo/ en otra plataforma) no hay mensaje del usuario y no se exige el pedido.
      const patron = politica.requierePedido?.[args.accion]
      if (patron && ctx.mensajeUsuario !== undefined && !pidioAccion(ctx.mensajeUsuario, patron))
        return fail(
          `el usuario no pidió ${args.accion} en su último mensaje: no dejes la acción pendiente. Termina el turno con el resumen y una pregunta abierta sobre el siguiente paso`,
        )
      const descripcion = await politica.describir({ ...args }, ctx)
      if ("error" in descripcion) return fail(descripcion.error)
      return ok({ estado: "esperando_confirmacion", accion: args.accion, referencia: args.referencia, ...descripcion })
    },
  }
}

export function normalizarTexto(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
}

const NEGACION = /^(no|nop|cancela|cancelar|espera|todavia no|aun no|detente|para)\b/

/** «sí» o «confirmo» (con o sin más texto). Una pregunta, una negación o un verbo de orden no confirman. */
export function esAfirmativo(mensaje: string): boolean {
  const texto = normalizarTexto(mensaje)
  if (texto.includes("?") || NEGACION.test(texto)) return false
  if (/\bconfirmo\b/.test(texto) || /^confirmado\b/.test(texto)) return true
  // «sí» con tilde al inicio; «si» sin tilde solo si va solo (para no confundirlo con el condicional).
  return /^sí(?!\p{L})/u.test(mensaje.trim().toLowerCase()) || /^si\s*([,.!]|$)/.test(texto)
}

/** El mensaje pide la acción (por ejemplo «envía») y no la niega («no envíes», «no enviar»). */
export function pidioAccion(mensaje: string, patron: RegExp): boolean {
  const texto = normalizarTexto(mensaje)
  const global = new RegExp(patron.source, patron.flags.includes("g") ? patron.flags : `${patron.flags}g`)
  for (const m of texto.matchAll(global)) {
    const antes = texto.slice(Math.max(0, m.index - 30), m.index)
    if (!/\b(no|sin|nunca|ni)\s+(\w+\s+){0,3}$/.test(antes)) return true
  }
  return false
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

/** Error si la herramienta afirma `confirmado: true` sin una confirmación válida de esa acción y referencia. */
export function verificarConfirmacion(args: Record<string, unknown>, ctx: ToolCtx, accion?: string): string | null {
  if (args.confirmado !== true) return null
  const referencia = referenciaDe(args)
  const c = ctx.confirmacion
  if (c && (!referencia || c.referencia === referencia) && (!accion || c.accion === accion)) return null
  return "requiere confirmación explícita: llama a agente_solicitar_confirmacion y espera a que el usuario responda «sí» o «confirmo»"
}

/** Texto que el código agrega al final del turno: advertencia (si la hay) y la pregunta. */
export function textoPregunta(p: ConfirmacionTurno): string {
  const partes = []
  if (p.advertencia) partes.push(`**⚠️ ATENCIÓN:** ${p.advertencia}`)
  partes.push(`**Confirmación requerida.** ${p.pregunta ?? `¿Confirmas ${p.accion} para ${p.referencia}?`}`)
  partes.push("Responde «sí» o «confirmo», o usa el botón Confirmar. Cualquier otra respuesta la deja sin ejecutar.")
  return partes.join("\n\n")
}
