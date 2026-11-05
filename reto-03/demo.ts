// Ejecuta los 6 casos llamando directamente a las herramientas, sin modelo ni clave.
// Uso: bun install && bun run demo.ts
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DIRECTORIO, fechaReferencia, registro } from "./src/agente.ts"
import { parsearResultado } from "./src/core/result.ts"
import { FsStorage } from "./src/core/storage.ts"
import type { ConfirmacionTurno, ToolCtx } from "./src/core/types.ts"

const storage = new FsStorage(join(DIRECTORIO, "out"))
const ctxBase: ToolCtx = { directory: DIRECTORIO, sessionId: "demo", fechaReferencia: fechaReferencia(), storage, confirmacion: null }

type Datos = Record<string, unknown>

async function llamar(nombre: string, args: Datos, ctx: ToolCtx = ctxBase) {
  const ej = await registro.ejecutar(nombre, args, ctx)
  const r = parsearResultado(ej.resultado)
  return { ok: r.ok, data: (r.ok ? r.data : {}) as Datos, error: r.ok ? "" : r.error }
}

const lista = (valor: unknown): Datos[] => (Array.isArray(valor) ? (valor as Datos[]) : [])
const reglas = (valor: unknown) => lista(valor).map((h) => `${h.regla} (${h.detalle})`)

function imprimirLista(titulo: string, items: string[]): void {
  if (items.length === 0) return void console.log(`  ${titulo}: —`)
  console.log(`  ${titulo}:`)
  for (const i of items) console.log(`    - ${i}`)
}

async function crear(caso: string, extra: Datos = {}, ctx: ToolCtx = ctxBase): Promise<string> {
  const r = await llamar("oc_crear", { caso, ...extra }, ctx)
  if (!r.ok) return `no creada → ${r.error}`
  return `OC ${r.data.numero_oc} (idempotente: ${r.data.idempotente})`
}

async function procesarCaso(caso: string): Promise<void> {
  console.log(`\n=== ${caso} ===`)
  const paquete = await llamar("oc_leer_paquete", { caso })
  if (!paquete.ok) return void console.log(`  leer_paquete: ERROR ${paquete.error}`)
  const solicitud = paquete.data.solicitud as Datos
  console.log(`  ${solicitud.solicitud_id} · ${solicitud.proveedor_nombre} · ${solicitud.valor_total} ${solicitud.moneda} · ${solicitud.centro_costo}/${solicitud.subarea}`)

  const v = await llamar("oc_validar", { caso })
  if (!v.ok) return void console.log(`  validar: ERROR ${v.error}`)
  console.log(`  apta: ${v.data.apta} · retroactiva: ${v.data.retroactiva}`)
  imprimirLista("bloqueos", lista(v.data.bloqueos).map((b) => `${b.regla}: ${b.detalle} → ${b.accion_sugerida}`))
  imprimirLista("confirmaciones", reglas(v.data.confirmaciones))
  const derivados = v.data.derivados as Datos
  const nombres = Object.entries(derivados)
    .filter(([k]) => k === "indicador_iva" || k === "condiciones_pago")
    .map(([k, d]) => `${k}=${(d as Datos).valor}`)
  const prov = derivados.proveedor as Datos | undefined
  if (prov) nombres.unshift(`proveedor ${prov.codigo_sap} (por ${prov.resuelto_por})`)
  imprimirLista("derivados", nombres)

  if (!v.data.apta) return void console.log(`  resultado: ${await crear(caso)}`)
  const evidencia = await llamar("oc_generar_evidencia", { caso })
  console.log(`  evidencia: ${evidencia.ok ? `${evidencia.data.ruta} (sha256 ${String(evidencia.data.sha256).slice(0, 12)}…)` : evidencia.error}`)
  const payload = await llamar("oc_construir_payload", { caso })
  if (!payload.ok) return void console.log(`  construir_payload: ERROR ${payload.error}`)
  const posicion = lista((payload.data.payload as Datos).posiciones)[0] ?? {}
  console.log(`  payload: «${posicion.descripcion}» · ${posicion.cantidad} ${posicion.unidad} × ${posicion.precio_unitario} · IVA ${posicion.indicador_iva}`)
  console.log(`  resultado: ${await crear(caso, { payload: payload.data.payload })}`)

  if (caso === "sol-001") console.log(`  idempotencia (segunda ejecución): ${await crear(caso)}`)
  if (caso === "sol-004") {
    console.log(`  confirmado: true sin que el usuario confirme: ${await crear(caso, { confirmado: true })}`)
    const confirmacion: ConfirmacionTurno = { accion: "crear_oc", referencia: caso, resumen: "La analista respondió «confirmo»." }
    console.log(`  tras «confirmo» de la analista: ${await crear(caso, { confirmado: true }, { ...ctxBase, confirmacion })}`)
  }
}

async function copiarCarpeta(origen: string, destino: string): Promise<void> {
  await mkdir(destino, { recursive: true })
  for (const e of await readdir(origen, { withFileTypes: true })) {
    if (e.isDirectory()) await copiarCarpeta(join(origen, e.name), join(destino, e.name))
    else await writeFile(join(destino, e.name), await readFile(join(origen, e.name)))
  }
}

/** HU-6 sobre una copia de los fixtures (los originales no se tocan). */
async function demostrarErrores(): Promise<void> {
  console.log("\n=== Manejo de errores (HU-6) ===")
  console.log(`  caso inexistente → ${(await llamar("oc_leer_paquete", { caso: "sol-999" })).error}`)

  const raiz = join(DIRECTORIO, "out", "_demo-errores")
  await copiarCarpeta(join(DIRECTORIO, "fixtures"), join(raiz, "fixtures"))
  const sol = (caso: string, archivo: string) => join(raiz, "fixtures/reto-03/solicitudes", caso, archivo)
  const ctx: ToolCtx = { ...ctxBase, directory: raiz, storage: new FsStorage(join(raiz, "out")) }

  console.log(`  pasos fuera de orden → ${(await llamar("oc_construir_payload", { caso: "sol-006" }, ctx)).error}`)

  await writeFile(sol("sol-001", "solicitud.json"), "{ esto no es JSON")
  console.log(`  JSON malformado → ${(await llamar("oc_leer_paquete", { caso: "sol-001" }, ctx)).error}`)

  const s2 = JSON.parse(await readFile(sol("sol-002", "solicitud.json"), "utf8")) as Datos
  await writeFile(sol("sol-002", "solicitud.json"), JSON.stringify({ ...s2, valor_total: "ocho millones" }))
  console.log(`  monto no numérico → ${(await llamar("oc_leer_paquete", { caso: "sol-002" }, ctx)).error}`)

  await rm(sol("sol-003", "aprobacion.json"))
  await rm(sol("sol-003", "cotizacion.txt"))
  const incompleto = await llamar("oc_leer_paquete", { caso: "sol-003" }, ctx)
  console.log(`  adjuntos ausentes → ok=${incompleto.ok}, faltantes: ${lista(incompleto.data.faltantes).join(", ") || String(incompleto.data.faltantes)}`)
  await rm(sol("sol-003", "solicitud.json"))
  console.log(`  paquete sin solicitud → ${(await llamar("oc_leer_paquete", { caso: "sol-003" }, ctx)).error}`)
}

async function main(): Promise<void> {
  await storage.borrarTodo()
  console.log("Demo reto-03 · Órdenes de Compra SAP · salida en out/")
  const casos = await llamar("oc_listar_casos", {})
  for (const caso of lista(casos.data.casos).map(String)) await procesarCaso(caso)
  await demostrarErrores()
  console.log("\n=== out/control.csv ===")
  console.log((await storage.leerTexto("control.csv"))?.trim().replace(/,\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, ",<ts>"))
  console.log("\nListo. Revisa out/<caso>/, out/sap/ordenes.jsonl, out/control.csv y out/log.jsonl.")
}

await main()
