// Ensambla el agente: herramientas registradas y system prompt (comportamiento + conocimiento).
import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { solicitar_confirmacion } from "./confirmacion.ts"
import { crearRegistro } from "./core/registry.ts"
import * as proveedor from "./tools/proveedor.ts"

/** Raíz del proyecto (donde viven agent/, fixtures/ y src/knowledge/), calculada desde este archivo:
 * en Vercel el directorio de trabajo no coincide con la carpeta del reto. */
export const DIRECTORIO = process.env.APP_DIR || dirname(dirname(fileURLToPath(import.meta.url)))

const agente = { solicitar_confirmacion }

export const registro = crearRegistro({ proveedor, agente })

/** agent/prompt.md (comportamiento) + src/knowledge/*.md (conocimiento del proceso). */
export async function cargarSystemPrompt(directory = DIRECTORIO): Promise<string> {
  const prompt = await readFile(join(directory, "agent/prompt.md"), "utf8")
  const carpeta = join(directory, "src/knowledge")
  const archivos = (await readdir(carpeta)).filter((f) => f.endsWith(".md")).sort()
  const conocimiento = await Promise.all(archivos.map((f) => readFile(join(carpeta, f), "utf8")))
  return [prompt, ...conocimiento].join("\n\n---\n\n")
}

/** HU-4: la vigencia se evalúa a la fecha de ejecución (hoy, hora de Colombia). FECHA_REFERENCIA la fija si se necesita. */
export function fechaReferencia(env = process.env, ahora = new Date()): string {
  const valor = env.FECHA_REFERENCIA ?? ""
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora)
}
