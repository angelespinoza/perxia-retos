// Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos neutros.

export type JsonSchema = Record<string, unknown>

export interface ToolSpec {
  nombre: string
  descripcion: string
  parametros: JsonSchema
}

export interface ToolCall {
  id: string
  nombre: string
  args: Record<string, unknown>
}

export interface ResultadoHerramienta {
  id: string
  nombre: string
  contenido: string
  esError: boolean
}

/** Contenido tal como lo devolvió el proveedor, para reenviarlo sin cambios en el siguiente request. */
export interface ContenidoNativo {
  proveedor: string
  contenido: unknown
}

export type Mensaje =
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: ToolCall[]; nativo?: ContenidoNativo }
  | { rol: "herramienta"; resultados: ResultadoHerramienta[] }

export interface Uso {
  entrada: number
  salida: number
}

export interface RespuestaLlm {
  texto: string
  llamadas: ToolCall[]
  uso: Uso
  nativo?: ContenidoNativo
  /** "rechazo": el proveedor declinó responder por política de seguridad. */
  fin: "fin" | "herramientas" | "limite" | "rechazo"
}

export interface OpcionesEnvio {
  system: string
  timeoutMs: number
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(mensajes: Mensaje[], herramientas: ToolSpec[], opciones: OpcionesEnvio): Promise<RespuestaLlm>
}

export class ErrorProveedor extends Error {
  constructor(
    mensaje: string,
    readonly reintentable: boolean,
  ) {
    super(mensaje)
    this.name = "ErrorProveedor"
  }
}

/** Normaliza los argumentos de una tool call (objeto o JSON en texto) a un objeto. */
export function argsSeguros(valor: unknown): Record<string, unknown> {
  if (typeof valor === "string") {
    try {
      const parseado: unknown = JSON.parse(valor)
      return typeof parseado === "object" && parseado !== null ? (parseado as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return typeof valor === "object" && valor !== null ? (valor as Record<string, unknown>) : {}
}
