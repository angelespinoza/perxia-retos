// Genera modulo/ desde las mismas fuentes que usa la aplicación (sin copias divergentes).
// Uso: bun run build:modulo        → escribe modulo/
//      bun run build:modulo --check → falla si modulo/ no coincide con las fuentes
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const raiz = process.cwd()
const leer = (ruta: string) => readFile(join(raiz, ruta), "utf8")

async function conocimiento(): Promise<string> {
  const carpeta = join(raiz, "src/knowledge")
  const archivos = (await readdir(carpeta)).filter((f) => f.endsWith(".md")).sort()
  return (await Promise.all(archivos.map((f) => readFile(join(carpeta, f), "utf8")))).join("\n\n")
}

async function generar(): Promise<Record<string, string>> {
  const prompt = await leer("agent/prompt.md")
  return {
    "modulo/agent.md": [
      "---",
      "description: Prepara formularios de registro como proveedor desde el repositorio maestro y arma el paquete para firma; nunca envía sin confirmación.",
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
      "---",
      "",
      prompt,
    ].join("\n"),
    "modulo/tools/proveedor.ts": [
      "// Mismas herramientas que usa la aplicación: re-export de src/tools/proveedor.ts, importable sin el servidor.",
      'export * from "../../src/tools/proveedor.ts"',
      'export { solicitar_confirmacion } from "../../src/core/confirm.ts"',
      "",
    ].join("\n"),
    "modulo/skill/registro-proveedor/SKILL.md": [
      "---",
      "name: registro-proveedor",
      "description: Conocimiento del proceso de registro como proveedor de Periferia (estados de campo, reglas RN1-RN5, soportes, formatos y paquete para firma).",
      "---",
      "",
      await conocimiento(),
    ].join("\n"),
  }
}

const archivos = await generar()
if (process.argv.includes("--check")) {
  const distintos: string[] = []
  for (const [ruta, contenido] of Object.entries(archivos)) {
    const actual = await readFile(join(raiz, ruta), "utf8").catch(() => null)
    if (actual !== contenido) distintos.push(ruta)
  }
  if (distintos.length > 0) {
    console.error(`modulo/ no coincide con las fuentes: ${distintos.join(", ")}. Ejecuta bun run build:modulo.`)
    process.exit(1)
  }
  console.log("modulo/ coincide con las fuentes.")
} else {
  for (const [ruta, contenido] of Object.entries(archivos)) {
    await mkdir(dirname(join(raiz, ruta)), { recursive: true })
    await writeFile(join(raiz, ruta), contenido)
  }
  console.log(`modulo/ generado: ${Object.keys(archivos).join(", ")}`)
}
