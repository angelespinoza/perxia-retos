// Ensambla el agente: herramientas registradas y system prompt (comportamiento + conocimiento).
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import * as agente from "./core/confirm.ts"
import { crearRegistro } from "./core/registry.ts"
import * as proveedor from "./tools/proveedor.ts"

/** Raíz del proyecto: donde viven agent/, fixtures/ y src/knowledge/. */
export const DIRECTORIO = process.env.APP_DIR || process.cwd()

export const registro = crearRegistro({ proveedor, agente })

/** agent/prompt.md (comportamiento) + src/knowledge/*.md (conocimiento del proceso). */
export async function cargarSystemPrompt(directory = DIRECTORIO): Promise<string> {
  const prompt = await readFile(join(directory, "agent/prompt.md"), "utf8")
  const carpeta = join(directory, "src/knowledge")
  const archivos = (await readdir(carpeta)).filter((f) => f.endsWith(".md")).sort()
  const conocimiento = await Promise.all(archivos.map((f) => readFile(join(carpeta, f), "utf8")))
  return [prompt, ...conocimiento].join("\n\n---\n\n")
}

export function fechaReferencia(env = process.env): string {
  const valor = env.FECHA_REFERENCIA ?? ""
  return /^\d{4}-\d{2}-\d{2}$/.test(valor) ? valor : "2026-09-03"
}
