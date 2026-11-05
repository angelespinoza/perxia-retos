// Sesiones persistidas en el Storage (sessions/<id>.json) para sobrevivir entre instancias de la función.
import type { Mensaje, Uso } from "../llm/adapter.ts"
import type { Storage } from "./storage.ts"
import type { ConfirmacionTurno } from "./types.ts"

export interface EventoChat {
  ts: string
  tipo: "usuario" | "asistente" | "herramienta" | "error"
  texto?: string
  herramienta?: string
  args?: Record<string, unknown>
  ok?: boolean
  resumen?: string
  needsConfirmation?: boolean
}

export interface Sesion {
  id: string
  creada: string
  mensajes: Mensaje[]
  eventos: EventoChat[]
  pendiente: ConfirmacionTurno | null
  uso: Uso
}

const ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/

export function idValido(id: string): boolean {
  return ID_VALIDO.test(id)
}

export function nuevaSesion(id: string): Sesion {
  return { id, creada: new Date().toISOString(), mensajes: [], eventos: [], pendiente: null, uso: { entrada: 0, salida: 0 } }
}

export async function cargarSesion(storage: Storage, id: string): Promise<Sesion | null> {
  if (!idValido(id)) return null
  const texto = await storage.leerTexto(`sessions/${id}.json`)
  if (!texto) return null
  try {
    return JSON.parse(texto) as Sesion
  } catch {
    return null
  }
}

export async function guardarSesion(storage: Storage, sesion: Sesion): Promise<void> {
  await storage.escribir(`sessions/${sesion.id}.json`, JSON.stringify(sesion))
}
