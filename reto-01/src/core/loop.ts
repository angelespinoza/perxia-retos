// Ciclo del agente: prompt → modelo → herramientas → respuesta, con topes de iteraciones, tokens y tiempo.
import { ErrorProveedor, type LlmAdapter, type ResultadoHerramienta } from "../llm/adapter.ts"
import { NOMBRE_PSEUDO, resolverConfirmacion } from "./confirm.ts"
import { enmascarar } from "./log.ts"
import type { Ejecucion, Registro } from "./registry.ts"
import type { EventoChat, Sesion } from "./session.ts"
import type { ConfirmacionTurno, ToolCtx } from "./types.ts"

export interface ConfigCiclo {
  maxIteraciones: number
  maxTokensSesion: number
  timeoutMs: number
  /** Tiempo total del turno; en Vercel la función tiene 300 s. */
  presupuestoMs: number
}

export interface LlamadaVisible {
  herramienta: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  ms: number
}

export interface RespuestaTurno {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  pendiente: ConfirmacionTurno | null
  error: boolean
}

export interface ParametrosTurno {
  sesion: Sesion
  mensaje: string
  adapter: LlmAdapter | null
  errorConfiguracion?: string
  registro: Registro
  system: string
  ctxBase: Omit<ToolCtx, "confirmacion" | "sessionId">
  config: ConfigCiclo
}

export function leerConfigCiclo(env = process.env): ConfigCiclo {
  const entero = (valor: string | undefined, defecto: number) => {
    const n = Number(valor)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : defecto
  }
  return {
    maxIteraciones: entero(env.MAX_ITERACIONES, 25),
    maxTokensSesion: entero(env.MAX_TOKENS_SESION, 400_000),
    timeoutMs: entero(env.LLM_TIMEOUT_MS, 60_000),
    presupuestoMs: entero(env.PRESUPUESTO_TURNO_MS, 270_000),
  }
}

export async function ejecutarTurno(p: ParametrosTurno): Promise<RespuestaTurno> {
  const { sesion, registro, config } = p
  const inicio = Date.now()
  const llamadas: Ejecucion[] = []
  const confirmacion = resolverConfirmacion(sesion.pendiente, p.mensaje)
  sesion.pendiente = null
  sesion.mensajes.push({ rol: "usuario", texto: p.mensaje })
  evento(sesion, { tipo: "usuario", texto: p.mensaje })

  const terminar = (reply: string, extra: Partial<RespuestaTurno> = {}): RespuestaTurno => {
    const respuesta: RespuestaTurno = {
      reply,
      toolCalls: llamadas.map(visible),
      needsConfirmation: false,
      pendiente: null,
      error: false,
      ...extra,
    }
    evento(sesion, {
      tipo: respuesta.error ? "error" : "asistente",
      texto: reply,
      needsConfirmation: respuesta.needsConfirmation,
    })
    return respuesta
  }

  if (!p.adapter) return terminar(p.errorConfiguracion ?? "El modelo no está configurado.", { error: true })
  if (sesion.uso.entrada + sesion.uso.salida >= config.maxTokensSesion)
    return terminar("Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para continuar.", { error: true })

  const ctx: ToolCtx = { ...p.ctxBase, sessionId: sesion.id, confirmacion }

  for (let i = 0; i < config.maxIteraciones; i++) {
    if (Date.now() - inicio > config.presupuestoMs) return terminar(cierreParcial(llamadas, "el tiempo máximo del turno"))
    let r
    try {
      r = await p.adapter.enviar(sesion.mensajes, registro.specs(), { system: p.system, timeoutMs: config.timeoutMs })
    } catch (e) {
      const detalle = e instanceof ErrorProveedor ? e.message : "Error inesperado del proveedor del modelo."
      return terminar(`${detalle} La sesión sigue activa: puedes reintentar el mensaje.`, { error: true })
    }
    sesion.uso.entrada += r.uso.entrada
    sesion.uso.salida += r.uso.salida
    sesion.mensajes.push({ rol: "asistente", texto: r.texto, llamadas: r.llamadas, nativo: r.nativo })

    if (r.fin === "rechazo")
      return terminar(r.texto || "El proveedor del modelo declinó responder esta solicitud.", { error: true })
    if (r.llamadas.length === 0) return terminar(r.texto || "(sin respuesta del modelo)")

    const resultados: ResultadoHerramienta[] = []
    let pendiente: ConfirmacionTurno | null = null
    for (const llamada of r.llamadas) {
      const ej = await registro.ejecutar(llamada.nombre, llamada.args, ctx)
      llamadas.push(ej)
      evento(sesion, { tipo: "herramienta", herramienta: ej.herramienta, args: argsVisibles(ej.args), ok: ej.ok, resumen: ej.resumen })
      resultados.push({ id: llamada.id, nombre: llamada.nombre, contenido: ej.resultado, esError: !ej.ok })
      if (llamada.nombre === NOMBRE_PSEUDO && ej.ok) pendiente = pendienteDe(llamada.args)
    }
    sesion.mensajes.push({ rol: "herramienta", resultados })

    if (pendiente) {
      sesion.pendiente = pendiente
      return terminar(preguntaConfirmacion(r.texto, pendiente), { needsConfirmation: true, pendiente })
    }
  }
  return terminar(cierreParcial(llamadas, `el tope de ${config.maxIteraciones} pasos`))
}

function pendienteDe(args: Record<string, unknown>): ConfirmacionTurno {
  const texto = (v: unknown) => (typeof v === "string" ? v : "")
  return { accion: texto(args.accion), referencia: texto(args.referencia), resumen: texto(args.resumen) }
}

function preguntaConfirmacion(texto: string, pendiente: ConfirmacionTurno): string {
  if (texto.includes("?")) return texto
  const pregunta = `¿Confirmas ${pendiente.accion} para ${pendiente.referencia}? ${pendiente.resumen}`.trim()
  return texto ? `${texto}\n\n${pregunta}` : pregunta
}

function cierreParcial(llamadas: Ejecucion[], motivo: string): string {
  const hechas = llamadas.map((l) => `- ${l.herramienta}: ${l.ok ? "ok" : "error"} (${l.resumen})`).join("\n")
  return [
    `Me detuve al alcanzar ${motivo}.`,
    hechas ? `Lo que alcancé a hacer:\n${hechas}` : "No alcancé a ejecutar herramientas.",
    "Lo que falta: escribe «continúa» para seguir desde aquí.",
  ].join("\n\n")
}

function visible(e: Ejecucion): LlamadaVisible {
  return { herramienta: e.herramienta, args: argsVisibles(e.args), ok: e.ok, resumen: e.resumen, ms: e.ms }
}

function argsVisibles(args: Record<string, unknown>): Record<string, unknown> {
  return enmascarar(args) as Record<string, unknown>
}

function evento(sesion: Sesion, datos: Omit<EventoChat, "ts">): void {
  sesion.eventos.push({ ts: new Date().toISOString(), ...datos })
}
