// Adaptador Google Gemini (generateContent con function calling).
import { type Content, FinishReason, GoogleGenAI, type Part } from "@google/genai"
import {
  ErrorProveedor,
  type LlmAdapter,
  type Mensaje,
  type OpcionesEnvio,
  type RespuestaLlm,
  type ToolCall,
  type ToolSpec,
} from "./adapter.ts"

export class GeminiAdapter implements LlmAdapter {
  readonly provider = "gemini"
  private readonly client: GoogleGenAI

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new GoogleGenAI({ apiKey })
  }

  async enviar(mensajes: Mensaje[], herramientas: ToolSpec[], opciones: OpcionesEnvio): Promise<RespuestaLlm> {
    try {
      const respuesta = await this.client.models.generateContent({
        model: this.model,
        contents: aContenidos(mensajes),
        config: {
          systemInstruction: opciones.system,
          maxOutputTokens: 16000,
          httpOptions: { timeout: opciones.timeoutMs },
          tools: [
            {
              functionDeclarations: herramientas.map((h) => ({
                name: h.nombre,
                description: h.descripcion,
                parametersJsonSchema: sanear(h.parametros),
              })),
            },
          ],
        },
      })
      const candidato = respuesta.candidates?.[0]
      const partes = candidato?.content?.parts ?? []
      const llamadas: ToolCall[] = partes.flatMap((p, i) =>
        p.functionCall?.name
          ? [{ id: p.functionCall.id ?? `gemini-${Date.now()}-${i}`, nombre: p.functionCall.name, args: p.functionCall.args ?? {} }]
          : [],
      )
      const texto = partes
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("\n")
        .trim()
      const motivo = candidato?.finishReason
      return {
        texto,
        llamadas,
        uso: {
          entrada: respuesta.usageMetadata?.promptTokenCount ?? 0,
          salida: respuesta.usageMetadata?.candidatesTokenCount ?? 0,
        },
        // Se guarda el contenido original para reenviar las firmas de razonamiento de cada functionCall.
        nativo: candidato?.content ? { proveedor: "gemini", contenido: candidato.content } : undefined,
        fin:
          motivo === FinishReason.SAFETY || motivo === FinishReason.PROHIBITED_CONTENT
            ? "rechazo"
            : motivo === FinishReason.MAX_TOKENS
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

export function aContenidos(mensajes: Mensaje[]): Content[] {
  const salida: Content[] = []
  const agregar = (role: "user" | "model", partes: Part[]) => {
    const ultimo = salida.at(-1)
    if (ultimo && ultimo.role === role && role === "user") ultimo.parts = [...(ultimo.parts ?? []), ...partes]
    else salida.push({ role, parts: partes })
  }
  for (const m of mensajes) {
    if (m.rol === "usuario") agregar("user", [{ text: m.texto }])
    else if (m.rol === "herramienta")
      agregar(
        "user",
        m.resultados.map((r) => ({
          functionResponse: { id: r.id, name: r.nombre, response: { resultado: r.contenido } },
        })),
      )
    else if (m.nativo?.proveedor === "gemini") salida.push(m.nativo.contenido as Content)
    else {
      const partes: Part[] = []
      if (m.texto) partes.push({ text: m.texto })
      for (const l of m.llamadas) partes.push({ functionCall: { id: l.id, name: l.nombre, args: l.args } })
      salida.push({ role: "model", parts: partes })
    }
  }
  return salida
}

/** Quita metadatos de JSON Schema que Gemini no necesita. */
function sanear(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _omitido, ...resto } = schema
  return resto
}

function traducirError(e: unknown): ErrorProveedor {
  if (e instanceof ErrorProveedor) return e
  const mensaje = e instanceof Error ? e.message : ""
  if (/API key|PERMISSION_DENIED|401|403/i.test(mensaje)) return new ErrorProveedor("La clave de Gemini no es válida.", false)
  if (/429|RESOURCE_EXHAUSTED/i.test(mensaje)) return new ErrorProveedor("Gemini limitó la tasa de solicitudes.", true)
  if (/timeout|aborted/i.test(mensaje)) return new ErrorProveedor("Gemini no respondió a tiempo.", true)
  return new ErrorProveedor("Gemini devolvió un error.", false)
}
