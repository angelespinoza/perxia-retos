// Adaptador Anthropic (Messages API, bucle manual de herramientas).
import Anthropic from "@anthropic-ai/sdk"
import {
  ErrorProveedor,
  type LlmAdapter,
  type Mensaje,
  type OpcionesEnvio,
  type RespuestaLlm,
  type ToolCall,
  type ToolSpec,
} from "./adapter.ts"

type Esfuerzo = "low" | "medium" | "high"
type Bloque = Anthropic.Beta.Messages.BetaContentBlockParam
type MensajeApi = Anthropic.Beta.Messages.BetaMessageParam

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  private readonly client: Anthropic

  constructor(
    readonly model: string,
    apiKey: string,
    private readonly esfuerzo: Esfuerzo,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 })
  }

  async enviar(mensajes: Mensaje[], herramientas: ToolSpec[], opciones: OpcionesEnvio): Promise<RespuestaLlm> {
    try {
      const respuesta = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          system: opciones.system,
          messages: aMensajesApi(mensajes),
          tools: herramientas.map((h) => ({
            name: h.nombre,
            description: h.descripcion,
            input_schema: h.parametros as Anthropic.Beta.Messages.BetaTool.InputSchema,
          })),
          output_config: { effort: this.esfuerzo },
          // Caché automática del prefijo (herramientas + system + historial): cada iteración reusa lo anterior.
          cache_control: { type: "ephemeral" },
          // Si un clasificador de seguridad rechaza la solicitud, el servidor reintenta con otro modelo.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { timeout: opciones.timeoutMs },
      )
      return aRespuesta(respuesta)
    } catch (e) {
      throw traducirError(e)
    }
  }
}

export function aMensajesApi(mensajes: Mensaje[]): MensajeApi[] {
  const salida: MensajeApi[] = []
  const agregarUsuario = (bloques: Bloque[]) => {
    const ultimo = salida.at(-1)
    if (ultimo && ultimo.role === "user" && Array.isArray(ultimo.content)) ultimo.content.push(...bloques)
    else salida.push({ role: "user", content: bloques })
  }
  for (const m of mensajes) {
    if (m.rol === "usuario") agregarUsuario([{ type: "text", text: m.texto }])
    else if (m.rol === "herramienta")
      agregarUsuario(
        m.resultados.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.contenido,
          is_error: r.esError,
        })),
      )
    else salida.push({ role: "assistant", content: contenidoAsistente(m) })
  }
  return salida
}

function contenidoAsistente(m: Extract<Mensaje, { rol: "asistente" }>): Bloque[] {
  // El contenido nativo (incluidos bloques de razonamiento) se reenvía sin modificar.
  if (m.nativo?.proveedor === "anthropic") return m.nativo.contenido as Bloque[]
  const bloques: Bloque[] = []
  if (m.texto) bloques.push({ type: "text", text: m.texto })
  for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.args })
  return bloques
}

function aRespuesta(r: Anthropic.Beta.Messages.BetaMessage): RespuestaLlm {
  const llamadas: ToolCall[] = []
  const textos: string[] = []
  for (const b of r.content) {
    if (b.type === "text") textos.push(b.text)
    else if (b.type === "tool_use") llamadas.push({ id: b.id, nombre: b.name, args: b.input as Record<string, unknown> })
  }
  const fin =
    r.stop_reason === "refusal"
      ? "rechazo"
      : r.stop_reason === "max_tokens"
        ? "limite"
        : llamadas.length > 0
          ? "herramientas"
          : "fin"
  return {
    texto: textos.join("\n").trim(),
    llamadas,
    uso: {
      entrada: r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0),
      salida: r.usage.output_tokens,
    },
    nativo: { proveedor: "anthropic", contenido: r.content },
    fin,
  }
}

function traducirError(e: unknown): ErrorProveedor {
  if (e instanceof Anthropic.AuthenticationError) return new ErrorProveedor("La clave de Anthropic no es válida.", false)
  if (e instanceof Anthropic.RateLimitError) return new ErrorProveedor("Anthropic limitó la tasa de solicitudes.", true)
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ErrorProveedor("Anthropic no respondió a tiempo.", true)
  if (e instanceof Anthropic.APIConnectionError) return new ErrorProveedor("No hay conexión con Anthropic.", true)
  if (e instanceof Anthropic.APIError) return new ErrorProveedor(`Anthropic devolvió un error (${e.status ?? "sin estado"}).`, false)
  return new ErrorProveedor("Error inesperado al llamar a Anthropic.", false)
}
