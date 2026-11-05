// Ejecuta todos los casos llamando directamente a las herramientas, sin modelo ni clave.
// Uso: bun install && bun run demo.ts
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DIRECTORIO, fechaReferencia, registro } from "./src/agente.ts"
import { parsearResultado } from "./src/core/result.ts"
import { FsStorage } from "./src/core/storage.ts"
import type { ConfirmacionTurno, ToolCtx } from "./src/core/types.ts"

const storage = new FsStorage(join(DIRECTORIO, "out"))
const ctxBase: ToolCtx = {
  directory: DIRECTORIO,
  sessionId: "demo",
  fechaReferencia: fechaReferencia(),
  storage,
  confirmacion: null,
}

type Datos = Record<string, unknown>

async function llamar(nombre: string, args: Datos, ctx: ToolCtx = ctxBase) {
  const ej = await registro.ejecutar(nombre, args, ctx)
  const r = parsearResultado(ej.resultado)
  return { ok: r.ok, data: (r.ok ? r.data : {}) as Datos, error: r.ok ? "" : r.error }
}

const lista = (valor: unknown): Datos[] => (Array.isArray(valor) ? (valor as Datos[]) : [])
const etiquetas = (valor: unknown) => lista(valor).map((c) => String(c.etiqueta)).join(", ") || "ninguno"

async function procesarCaso(caso: string): Promise<void> {
  console.log(`\n=== ${caso} ===`)
  const solicitud = await llamar("proveedor_leer_solicitud", { caso })
  if (!solicitud.ok) return void console.log(`  leer_solicitud: ERROR ${solicitud.error}`)
  const campos = lista(solicitud.data.campos).map((c) => String(c.etiqueta))
  console.log(`  cliente: ${solicitud.data.cliente} · país: ${solicitud.data.pais} · formato: ${solicitud.data.formato}`)
  console.log(`  campos pedidos: ${campos.length} · soportes exigidos: ${lista(solicitud.data.soportes).length}`)

  const mapeo = await llamar("proveedor_mapear_campos", { caso, campos })
  if (mapeo.ok) {
    console.log(`  llenos: ${lista(mapeo.data.llenos).length}`)
    console.log(`  faltantes: ${etiquetas(mapeo.data.faltantes)}`)
    console.log(`  requiere_confirmacion: ${etiquetas(mapeo.data.requiere_confirmacion)}`)
  } else console.log(`  mapear_campos: ERROR ${mapeo.error}`)

  const formulario = await llamar("proveedor_generar_formulario", { caso })
  console.log(`  formulario: ${formulario.ok ? `${formulario.data.ruta}` : formulario.error}`)

  const paquete = await llamar("proveedor_armar_paquete", { caso })
  if (!paquete.ok) return void console.log(`  armar_paquete: ERROR ${paquete.error}`)
  const checklist = lista(paquete.data.checklist).map((s) => `${s.tipo}=${s.estado}`).join(", ")
  console.log(`  soportes: ${checklist}`)
  console.log(`  listo_para_firma: ${paquete.data.listo_para_firma}`)
}

async function copiarCarpeta(origen: string, destino: string): Promise<void> {
  await mkdir(destino, { recursive: true })
  for (const e of await readdir(origen, { withFileTypes: true })) {
    if (e.isDirectory()) await copiarCarpeta(join(origen, e.name), join(destino, e.name))
    else await writeFile(join(destino, e.name), await readFile(join(origen, e.name)))
  }
}

async function demostrarErrores(): Promise<void> {
  console.log("\n=== Manejo de errores (HU-5) ===")
  const inexistente = await llamar("proveedor_leer_solicitud", { caso: "co-no-existe" })
  console.log(`  caso inexistente → ${inexistente.error}`)

  // Copia temporal de los fixtures con una plantilla corrupta (los fixtures originales no se tocan).
  const raiz = join(DIRECTORIO, "out", "_demo-plantilla-corrupta")
  await copiarCarpeta(join(DIRECTORIO, "fixtures"), join(raiz, "fixtures"))
  await writeFile(join(raiz, "fixtures/reto-01/casos/co-industrias-delta/plantilla-celdas.json"), "{ esto no es JSON")
  const ctxCorrupto: ToolCtx = { ...ctxBase, directory: raiz, storage: new FsStorage(join(raiz, "out")) }
  const lectura = await llamar("proveedor_leer_solicitud", { caso: "co-industrias-delta" }, ctxCorrupto)
  console.log(`  plantilla corrupta → leer_solicitud ok=${lectura.ok}, advertencia: ${lista(lectura.data.advertencias).join("") || String(lectura.data.advertencias)}`)
  const form = await llamar("proveedor_generar_formulario", { caso: "co-industrias-delta" }, ctxCorrupto)
  console.log(`  plantilla corrupta → generar_formulario: ${form.error}`)
  const paquete = await llamar("proveedor_armar_paquete", { caso: "co-industrias-delta" }, ctxCorrupto)
  console.log(`  plantilla corrupta → armar_paquete ok=${paquete.ok}, listo_para_firma=${paquete.data.listo_para_firma} (continúa con el checklist)`)
}

async function demostrarConfirmacion(): Promise<void> {
  console.log("\n=== Confirmación humana (RN4) ===")
  const sin = await llamar("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true })
  console.log(`  envío sin confirmación del usuario → ${sin.error}`)
  const confirmacion: ConfirmacionTurno = {
    accion: "simular_envio",
    referencia: "co-industrias-delta",
    resumen: "El usuario respondió «envía».",
  }
  const con = await llamar("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true }, {
    ...ctxBase,
    confirmacion,
  })
  console.log(`  envío con confirmación del usuario → ${con.ok ? con.data.ruta : con.error}`)
}

async function main(): Promise<void> {
  await storage.borrarTodo()
  console.log(`Demo reto-01 · fecha de referencia ${ctxBase.fechaReferencia} · salida en out/`)
  const casos = await llamar("proveedor_listar_casos", {})
  for (const caso of lista(casos.data.casos).map(String)) await procesarCaso(caso)
  await demostrarErrores()
  await demostrarConfirmacion()
  console.log("\nListo. Revisa out/<caso>/ y out/log.jsonl.")
}

await main()
