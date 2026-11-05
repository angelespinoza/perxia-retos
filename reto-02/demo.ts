// Procesa los 6 mensajes del buzón llamando directamente a las herramientas, sin modelo ni clave.
// Uso: bun install && bun run demo.ts
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DIRECTORIO, fechaReferencia, registro } from "./src/agente.ts"
import { parsearResultado } from "./src/core/result.ts"
import { FsStorage } from "./src/core/storage.ts"
import type { ConfirmacionTurno, ToolCtx } from "./src/core/types.ts"

const storage = new FsStorage(join(DIRECTORIO, "out"))
const hoy = fechaReferencia()
const ctxBase: ToolCtx = { directory: DIRECTORIO, sessionId: "demo", fechaReferencia: hoy, storage, confirmacion: null }

type Datos = Record<string, unknown>

async function llamar(nombre: string, args: Datos, ctx: ToolCtx = ctxBase) {
  const ej = await registro.ejecutar(nombre, args, ctx)
  const r = parsearResultado(ej.resultado)
  return { ok: r.ok, data: (r.ok ? r.data : {}) as Datos, error: r.ok ? "" : r.error }
}

const lista = (v: unknown): Datos[] => (Array.isArray(v) ? (v as Datos[]) : [])
const texto = (v: unknown) => (Array.isArray(v) && v.length ? v.join(", ") : "—")

function describirCambios(cambios: unknown): string {
  if (!cambios || typeof cambios !== "object") return ""
  return Object.entries(cambios as Record<string, [string, string]>)
    .map(([campo, [antes, despues]]) => `${campo} ${antes} → ${despues}`)
    .join("; ")
}

/** Extraer → validar → registrar, como lo haría el agente. Devuelve la validación para la segunda pasada. */
async function procesar(id: string, ctx: ToolCtx = ctxBase): Promise<Datos | null> {
  console.log(`\n=== ${id} ===`)
  const ext = await llamar("contratos_extraer", { mensaje_id: id }, ctx)
  if (!ext.ok) return void console.log(`  extraer: ERROR ${ext.error} → se continúa con el siguiente mensaje`), null
  const contrato = (ext.data.contrato ?? {}) as Datos
  const val = await llamar("contratos_validar", { mensaje_id: id, contrato }, ctx)
  if (!val.ok) return void console.log(`  validar: ERROR ${val.error}`), null
  const d = val.data
  const ref = d.id_contrato ? ` (${d.id_contrato}${contrato.cliente ? ` · ${contrato.cliente}` : ""}${contrato.moneda ? ` · ${contrato.moneda} ${contrato.valor}` : ""})` : ""
  console.log(`  clasificación: ${d.clasificacion}${ref}`)
  if (d.motivo) console.log(`  motivo: ${d.motivo}`)
  const motivos = (d.motivos_revision ?? {}) as Record<string, string>
  console.log(`  revisión: ${lista(d.requiere_revision).length ? (d.requiere_revision as string[]).map((c) => `${c} (${motivos[c]})`).join(", ") : "—"}`)
  for (const aviso of lista(d.avisos)) console.log(`  aviso: ${aviso}`)
  const reg = await llamar("contratos_registrar", { mensaje_id: id, contrato }, ctx)
  if (!reg.ok) console.log(`  acción: NO REGISTRADO → ${reg.error}`)
  else {
    const r = reg.data
    const detalle = r.accion === "insertado" ? `estado_poliza ${r.estado_poliza}` : describirCambios(r.cambios) || String(r.motivo ?? "")
    console.log(`  acción: ${r.accion}${detalle ? ` · ${detalle}` : ""}${r.ruta_archivo ? ` · ${r.ruta_archivo}` : ""}`)
  }
  return d
}

async function segundaPasada(): Promise<void> {
  console.log("\n=== Segunda pasada: msg-006 con confirmación del usuario ===")
  const valores = { valor: 0, fecha_fin: "2027-08-31" }
  const sin = await llamar("contratos_registrar", { mensaje_id: "msg-006", contrato: valores, confirmado: true })
  console.log(`  confirmado: true sin confirmación en el chat → ${sin.error}`)
  const confirmacion: ConfirmacionTurno = {
    accion: "registrar",
    referencia: "msg-006",
    resumen: "El usuario respondió «confirmo el valor 0 y la fecha fin 2027-08-31».",
  }
  const con = await llamar("contratos_registrar", { mensaje_id: "msg-006", contrato: valores, confirmado: true }, { ...ctxBase, confirmacion })
  if (!con.ok) return void console.log(`  ERROR ${con.error}`)
  console.log(`  acción: ${con.data.accion} ${con.data.id_contrato} · confirmados: ${describirCambios(con.data.valores_confirmados)} · ${con.data.ruta_archivo}`)
}

async function reporteAlertas(): Promise<void> {
  console.log(`\n=== Alertas (hoy = ${hoy}) ===`)
  const a = await llamar("contratos_alertas", { hoy })
  if (!a.ok) return void console.log(`  ERROR ${a.error}`)
  const ids = (v: unknown, extra: (c: Datos) => string) => lista(v).map((c) => `${c.id_contrato} (${extra(c)})`).join(", ") || "—"
  console.log(`  vencen en ≤ 60 días: ${ids(a.data.vencen, (c) => String(c.fecha_fin))}`)
  console.log(`  pólizas pendientes: ${ids(a.data.polizas_pendientes, (c) => String(c.estado_poliza))}`)
  console.log(`  registrados desde el corte: ${ids(a.data.registrados_desde_corte, (c) => String(c.fecha_registro))}`)
  console.log(`  actualizados desde el corte: ${ids(a.data.actualizados_desde_corte, (c) => texto(c.campos))}`)
  console.log(`  vencidos sin cierre: ${ids(a.data.vencidos_sin_cierre, (c) => String(c.fecha_fin))}`)
  console.log(`  reporte: ${a.data.ruta}`)
}

/** Copia con permisos nuevos (los fixtures vienen de solo lectura y out/ se borra en cada demo). */
async function copiarCarpeta(origen: string, destino: string): Promise<void> {
  await mkdir(destino, { recursive: true })
  for (const e of await readdir(origen, { withFileTypes: true })) {
    if (e.isDirectory()) await copiarCarpeta(join(origen, e.name), join(destino, e.name))
    else await writeFile(join(destino, e.name), await readFile(join(origen, e.name)))
  }
}

/** HU-6: copia temporal del buzón con mensajes malos; el lote sigue con el siguiente mensaje. */
async function demostrarErrores(): Promise<void> {
  console.log("\n=== Manejo de errores (HU-6) ===")
  const raiz = join(DIRECTORIO, "out", "_demo-errores")
  await copiarCarpeta(join(DIRECTORIO, "fixtures"), join(raiz, "fixtures"))
  const buzon = join(raiz, "fixtures/reto-02/buzon")
  const malo = async (id: string, contenido: string) => {
    await mkdir(join(buzon, id), { recursive: true })
    const correo = { id, de: "lgomez@periferia-ficticia.com", para: "contratos@periferia-ficticia.com", asunto: "Prueba", fecha: "2026-09-01T10:00:00-05:00", cuerpo: "", adjuntos: ["contrato.txt"] }
    await writeFile(join(buzon, id, "correo.json"), JSON.stringify(correo))
    await writeFile(join(buzon, id, "contrato.txt"), contenido)
  }
  const plantilla = (valor: string, plazo: string) =>
    `CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2026-090\n\nEntre los suscritos, EMPRESA PRUEBA S.A.S., identificada con NIT 800.111.222-3, quien en adelante se denominará EL CONTRATANTE, y PERIFERIA IT GROUP S.A.S., identificada con NIT 900.123.456-7, EL CONTRATISTA:\n\nPRIMERA. OBJETO. Servicios de prueba.\n\nSEGUNDA. VALOR. El valor total es de ${valor}.\n\nTERCERA. PLAZO. ${plazo}\n`
  await malo("msg-e01", "")
  await malo("msg-e02", plantilla("CIEN MILLONES DE PESOS (COP $100.000.000)", "Desde el primero (1) de enero de 2027 hasta el treinta y uno (31) de febrero de 2027."))
  await malo("msg-e03", plantilla("CINCUENTA MIL EUROS (EUR 50.000)", "Desde el primero (1) de enero de 2027 hasta el treinta (30) de junio de 2027."))
  const ctx: ToolCtx = { ...ctxBase, directory: raiz, storage: new FsStorage(join(raiz, "out")) }
  for (const id of ["msg-e01", "msg-e02", "msg-e03", "msg-002"]) {
    const r = await llamar("contratos_extraer", { mensaje_id: id }, ctx)
    console.log(`  ${id} → ${r.ok ? `ok (${(r.data.contrato as Datos).id_contrato}): el lote continúa` : r.error}`)
  }
  const fecha = await llamar("contratos_alertas", { hoy: "2026-02-30" }, ctx)
  console.log(`  alertas con hoy = 2026-02-30 → ${fecha.error}`)
  const inexistente = await llamar("contratos_extraer", { mensaje_id: "msg-999" })
  console.log(`  mensaje inexistente → ${inexistente.error}`)
}

async function main(): Promise<void> {
  await storage.borrarTodo()
  console.log(`Demo reto-02 · hoy = ${hoy} · salida en out/`)
  const buzon = await llamar("contratos_leer_buzon", {})
  const mensajes = lista(buzon.data.mensajes)
  console.log(`Buzón: ${mensajes.length} mensajes pendientes`)
  for (const m of mensajes) console.log(`  ${m.id} · ${m.de} · «${m.asunto}» · tiene_contrato: ${m.tiene_contrato}`)
  for (const m of mensajes) await procesar(String(m.id))
  await segundaPasada()
  await reporteAlertas()
  const pendientes = await llamar("contratos_leer_buzon", {})
  console.log(`\nBuzón tras procesar: ${lista(pendientes.data.mensajes).length} pendientes, ${pendientes.data.ya_procesados} procesados`)
  await demostrarErrores()
  console.log("\nListo. Revisa out/sharepoint/, out/alertas.md, out/procesados.json y out/log.jsonl.")
}

await main()
