// Ensambla el agente: herramientas registradas y system prompt (comportamiento + conocimiento).
import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { solicitar_confirmacion } from "./confirmacion.ts"
import { crearRegistro } from "./core/registry.ts"
import * as contratos from "./tools/contratos.ts"

/** Raíz del proyecto (donde viven agent/, fixtures/ y src/knowledge/), calculada desde este archivo:
 * en Vercel el directorio de trabajo no coincide con la carpeta del reto. */
export const DIRECTORIO = process.env.APP_DIR || dirname(dirname(fileURLToPath(import.meta.url)))

const agente = { solicitar_confirmacion }

export const registro = crearRegistro({ contratos, agente })

/** agent/prompt.md (comportamiento) + src/knowledge/*.md (conocimiento del proceso). */
export async function cargarSystemPrompt(directory = DIRECTORIO): Promise<string> {
  const prompt = await readFile(join(directory, "agent/prompt.md"), "utf8")
  const carpeta = join(directory, "src/knowledge")
  const archivos = (await readdir(carpeta)).filter((f) => f.endsWith(".md")).sort()
  const conocimiento = await Promise.all(archivos.map((f) => readFile(join(carpeta, f), "utf8")))
  const fecha = `Fecha de referencia del sistema (hoy, si la analista no indica otra): ${fechaReferencia()}.`
  return [prompt, ...conocimiento, fecha].join("\n\n---\n\n")
}

export function fechaReferencia(env = process.env): string {
  const valor = env.FECHA_REFERENCIA ?? ""
  return /^\d{4}-\d{2}-\d{2}$/.test(valor) ? valor : "2026-09-03"
}
