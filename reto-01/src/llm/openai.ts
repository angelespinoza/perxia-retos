// Adaptador OpenAI (Chat Completions con function calling).
import OpenAI from "openai"
import {
  argsSeguros,
  ErrorProveedor,
  type LlmAdapter,
  type Mensaje,
  type OpcionesEnvio,
  type RespuestaLlm,
  type ToolSpec,
} from "./adapter.ts"

type MensajeApi = OpenAI.Chat.Completions.ChatCompletionMessageParam

export class OpenAIAdapter implements LlmAdapter {
  readonly provider = "openai"
  private readonly client: OpenAI

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new OpenAI({ apiKey, maxRetries: 2 })
  }

  async enviar(mensajes: Mensaje[], herramientas: ToolSpec[], opciones: OpcionesEnvio): Promise<RespuestaLlm> {
    try {
      const respuesta = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [{ role: "system", content: opciones.system }, ...aMensajesApi(mensajes)],
          tools: herramientas.map((h) => ({
            type: "function" as const,
            function: { name: h.nombre, description: h.descripcion, parameters: h.parametros },
          })),
          max_completion_tokens: 16000,
        },
        { timeout: opciones.timeoutMs },
      )
      const eleccion = respuesta.choices[0]
      if (!eleccion) throw new ErrorProveedor("OpenAI devolvió una respuesta vacía.", true)
      const llamadas = (eleccion.message.tool_calls ?? []).flatMap((t) =>
        t.type === "function" ? [{ id: t.id, nombre: t.function.name, args: argsSeguros(t.function.arguments) }] : [],
      )
      return {
        texto: (eleccion.message.content ?? eleccion.message.refusal ?? "").trim(),
        llamadas,
        uso: { entrada: respuesta.usage?.prompt_tokens ?? 0, salida: respuesta.usage?.completion_tokens ?? 0 },
        fin: eleccion.message.refusal
          ? "rechazo"
          : eleccion.finish_reason === "length"
            ? "limite"
            : llamadas.length > 0
              ? "herramientas"
              : "fin",
      }
    } catch (e) {
      throw traducirError(e)
    }
  }
}

export function aMensajesApi(mensajes: Mensaje[]): MensajeApi[] {
  return mensajes.flatMap((m): MensajeApi[] => {
    if (m.rol === "usuario") return [{ role: "user", content: m.texto }]
    if (m.rol === "herramienta")
      return m.resultados.map((r) => ({ role: "tool" as const, tool_call_id: r.id, content: r.contenido }))
    return [
      {
        role: "assistant",
        content: m.texto || null,
        ...(m.llamadas.length > 0
          ? {
              tool_calls: m.llamadas.map((l) => ({
                id: l.id,
                type: "function" as const,
                function: { name: l.nombre, arguments: JSON.stringify(l.args) },
              })),
            }
          : {}),
      },
    ]
  })
}

function traducirError(e: unknown): ErrorProveedor {
  if (e instanceof ErrorProveedor) return e
  if (e instanceof OpenAI.AuthenticationError) return new ErrorProveedor("La clave de OpenAI no es válida.", false)
  if (e instanceof OpenAI.RateLimitError) return new ErrorProveedor("OpenAI limitó la tasa de solicitudes.", true)
  if (e instanceof OpenAI.APIConnectionTimeoutError) return new ErrorProveedor("OpenAI no respondió a tiempo.", true)
  if (e instanceof OpenAI.APIConnectionError) return new ErrorProveedor("No hay conexión con OpenAI.", true)
  if (e instanceof OpenAI.APIError) return new ErrorProveedor(`OpenAI devolvió un error (${e.status ?? "sin estado"}).`, false)
  return new ErrorProveedor("Error inesperado al llamar a OpenAI.", false)
}
