// Tipos compartidos del núcleo: contrato de herramientas (sección 6.2 del PRD).
import type { z } from "zod"
import type { Storage } from "./storage.ts"

export type Efecto = "lectura" | "escritura" | "externa"

export interface ConfirmacionTurno {
  accion: string
  referencia: string
  resumen: string
}

export interface ToolCtx {
  /** Raíz del proyecto; las rutas se resuelven desde aquí, nunca absolutas. */
  directory: string
  sessionId: string
  /** Fecha usada para vigencias (YYYY-MM-DD). */
  fechaReferencia: string
  /** Destino de out/: disco en local, Vercel Blob en producción. */
  storage: Storage
  /** Confirmación del usuario vigente en este turno, si la hay. */
  confirmacion: ConfirmacionTurno | null
}

export interface Tool<S extends z.ZodRawShape> {
  description: string
  args: S
  efecto?: Efecto
  execute(args: z.output<z.ZodObject<S>>, ctx: ToolCtx): Promise<string>
}

/** Ayuda de tipado: conserva la forma { description, args, execute } del PRD. */
export function defineTool<S extends z.ZodRawShape>(tool: Tool<S>): Tool<S> {
  return tool
}
