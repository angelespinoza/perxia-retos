/// <reference types="bun" />
// Prueba el ciclo del agente con un adaptador simulado que reproduce el flujo de la sección 11 del PRD.
import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fechaReferencia, registro } from "../src/agente.ts"
import { esAfirmativo, pidioAccion } from "../src/core/confirm.ts"
import { ejecutarTurno, type ConfigCiclo } from "../src/core/loop.ts"
import { nuevaSesion } from "../src/core/session.ts"
import { EspacioStorage, FsStorage, type Storage } from "../src/core/storage.ts"
import type { LlmAdapter, Mensaje, RespuestaLlm, ToolCall } from "../src/llm/adapter.ts"

const config: ConfigCiclo = { maxIteraciones: 25, maxTokensSesion: 1_000_000, timeoutMs: 1000, presupuestoMs: 60_000 }
const caso = "ec-corp-andina"

function respuesta(llamadas: ToolCall[], texto = ""): RespuestaLlm {
  return { texto, llamadas, uso: { entrada: 10, salida: 5 }, fin: llamadas.length ? "herramientas" : "fin" }
}

/** Devuelve las respuestas en orden, una por llamada a enviar(). */
function adaptadorGuionado(guion: RespuestaLlm[]): LlmAdapter & { vistos: Mensaje[][] } {
  const vistos: Mensaje[][] = []
  return {
    provider: "simulado",
    model: "guion",
    vistos,
    async enviar(mensajes) {
      vistos.push(structuredClone(mensajes))
      const siguiente = guion.shift()
      if (!siguiente) throw new Error("guion agotado")
      return siguiente
    },
  }
}

const llamada = (id: string, nombre: string, args: Record<string, unknown>): ToolCall => ({ id, nombre, args })

async function entorno() {
  const storage = new FsStorage(await mkdtemp(join(tmpdir(), "reto01-")))
  return { storage, ctxBase: { directory: process.cwd(), fechaReferencia: "2026-09-03", storage } }
}

describe("confirmación humana (CA3 / RN4)", () => {
  test("solo «sí» o «confirmo» confirman; los verbos de orden son pedidos", () => {
    expect(esAfirmativo("Sí, confirmo.")).toBe(true)
    expect(esAfirmativo("sí")).toBe(true)
    expect(esAfirmativo("si")).toBe(true)
    expect(esAfirmativo("confirmo")).toBe(true)
    expect(esAfirmativo("confirmo el valor 0 y la fecha fin 2027-08-31")).toBe(true)
    expect(esAfirmativo("envía")).toBe(false)
    expect(esAfirmativo("envíalo ya")).toBe(false)
    expect(esAfirmativo("dale")).toBe(false)
    expect(esAfirmativo("ok")).toBe(false)
    expect(esAfirmativo("si llega el RUT mañana, lo reenvías")).toBe(false)
    expect(esAfirmativo("no envíes nada todavía")).toBe(false)
    expect(esAfirmativo("¿sí está listo?")).toBe(false)
    expect(esAfirmativo("¿qué falta?")).toBe(false)
  })

  test("detecta si el usuario pidió el envío", () => {
    const patron = /\b(envia|envialo|enviar|manda)\b/
    expect(pidioAccion("envía", patron)).toBe(true)
    expect(pidioAccion("Ahora envíalo, por favor", patron)).toBe(true)
    expect(pidioAccion('Procesa el caso "ec-corp-andina". No envíes nada todavía.', patron)).toBe(false)
    expect(pidioAccion("Procesa el caso, sin enviar nada", patron)).toBe(false)
    expect(pidioAccion("no lo vayas a enviar", patron)).toBe(false)
    expect(pidioAccion("no sé, envíalo", patron)).toBe(true)
  })

  test("flujo del PRD: procesar sin pendiente, «envía» pide confirmación con advertencia y «sí» envía", async () => {
    const { storage, ctxBase } = await entorno()
    const sesion = nuevaSesion("prueba")
    const adapter = adaptadorGuionado([
      respuesta([llamada("1", "proveedor_leer_solicitud", { caso })]),
      respuesta([llamada("2", "proveedor_mapear_campos", { caso, campos: [] })]),
      respuesta([llamada("3", "proveedor_generar_formulario", { caso }), llamada("4", "proveedor_armar_paquete", { caso })]),
      // El modelo intenta dejar el envío pendiente aunque el usuario no lo pidió: el código lo rechaza.
      respuesta([llamada("5", "agente_solicitar_confirmacion", { accion: "simular_envio", referencia: caso, resumen: "Se enviaría el paquete." })]),
      respuesta([], "Resumen: 13 campos llenos, 1 faltante y 1 por confirmar. Falta un soporte. ¿Qué quieres hacer?"),
      // Turno 2: «envía» es un pedido; el agente deja la acción pendiente.
      respuesta([llamada("6", "agente_solicitar_confirmacion", { accion: "simular_envio", referencia: caso, resumen: "Se enviaría el paquete." })]),
      respuesta([], "El paquete de ec-corp-andina tiene pendientes de soportes."),
      // Turno 3: «sí» en respuesta a la pregunta confirma.
      respuesta([llamada("7", "proveedor_simular_envio", { caso, confirmado: true })]),
      respuesta([], "Listo: quedó ENVIO-SIMULADO.md."),
    ])
    const base = { sesion, adapter, registro, system: "prueba", ctxBase, config }

    const t1 = await ejecutarTurno({ ...base, mensaje: `Procesa el caso "${caso}". No envíes nada todavía.` })
    expect(t1.needsConfirmation).toBe(false)
    expect(sesion.pendiente).toBeNull()
    expect(t1.toolCalls.find((t) => t.herramienta === "agente_solicitar_confirmacion")?.ok).toBe(false)
    expect(t1.reply).toContain("13 campos llenos")
    expect(await storage.leer(`${caso}/ENVIO-SIMULADO.md`)).toBeNull()
    const borrador = await storage.leerTexto(`${caso}/paquete/borrador-correo.md`)
    expect(borrador).toContain("BORRADOR — no enviar")
    expect(borrador).not.toContain("firmado")

    const t2 = await ejecutarTurno({ ...base, mensaje: "envía" })
    expect(t2.needsConfirmation).toBe(true)
    expect(t2.pendiente?.advertencia).toContain("NO está listo para firma")
    expect(t2.reply).toContain("ATENCIÓN")
    expect(t2.reply).toContain("¿Confirmas el envío simulado")
    expect(await storage.leer(`${caso}/ENVIO-SIMULADO.md`)).toBeNull()

    const t3 = await ejecutarTurno({ ...base, mensaje: "Sí, confirmo." })
    expect(t3.toolCalls[0]?.ok).toBe(true)
    expect(await storage.leerTexto(`${caso}/ENVIO-SIMULADO.md`)).toContain("Corporación Andina")
  })

  test("«envía» en respuesta a la pregunta no confirma", async () => {
    const { storage, ctxBase } = await entorno()
    const sesion = nuevaSesion("orden")
    const adapter = adaptadorGuionado([
      respuesta([llamada("1", "proveedor_armar_paquete", { caso })]),
      respuesta([llamada("2", "agente_solicitar_confirmacion", { accion: "simular_envio", referencia: caso, resumen: "Se enviaría." })]),
      respuesta([], "Arme el paquete de ec-corp-andina; tiene soportes pendientes que conviene revisar antes de enviar."),
      respuesta([llamada("3", "proveedor_simular_envio", { caso, confirmado: true })]),
      respuesta([], "No pude enviar."),
    ])
    const base = { sesion, adapter, registro, system: "", ctxBase, config }
    expect((await ejecutarTurno({ ...base, mensaje: "arma el paquete y envíalo" })).needsConfirmation).toBe(true)
    const t2 = await ejecutarTurno({ ...base, mensaje: "envía" })
    expect(t2.toolCalls[0]?.ok).toBe(false)
    expect(t2.toolCalls[0]?.resumen).toContain("requiere confirmación explícita")
    expect(await storage.leer(`${caso}/ENVIO-SIMULADO.md`)).toBeNull()
  })

  test("sin confirmación pendiente, confirmado:true se rechaza", async () => {
    const { storage, ctxBase } = await entorno()
    const adapter = adaptadorGuionado([
      respuesta([llamada("1", "proveedor_armar_paquete", { caso })]),
      respuesta([llamada("2", "proveedor_simular_envio", { caso, confirmado: true })]),
      respuesta([], "No pude enviar."),
    ])
    const t = await ejecutarTurno({ sesion: nuevaSesion("x"), mensaje: "envía", adapter, registro, system: "", ctxBase, config })
    expect(t.toolCalls[1]?.ok).toBe(false)
    expect(t.toolCalls[1]?.resumen).toContain("requiere confirmación explícita")
    expect(await storage.leer(`${caso}/ENVIO-SIMULADO.md`)).toBeNull()
  })

  test("no se puede pedir confirmación de un paquete que no se armó", async () => {
    const { ctxBase } = await entorno()
    const adapter = adaptadorGuionado([
      respuesta([llamada("1", "agente_solicitar_confirmacion", { accion: "simular_envio", referencia: caso, resumen: "x" })]),
      respuesta([], "Primero hay que armar el paquete."),
    ])
    const t = await ejecutarTurno({ sesion: nuevaSesion("y"), mensaje: "envía", adapter, registro, system: "", ctxBase, config })
    expect(t.needsConfirmation).toBe(false)
    expect(t.toolCalls[0]?.resumen).toContain("primero arma el paquete")
  })
})

describe("estado por sesión y paquete (A1)", () => {
  const ctx = (storage: Storage, sessionId: string) => ({
    directory: process.cwd(), sessionId, fechaReferencia: "2026-09-03", storage, confirmacion: null,
  })

  test("cada sesión tiene su propio espacio out/<sessionId>/ que parte de cero", async () => {
    const base = new FsStorage(await mkdtemp(join(tmpdir(), "reto01-esp-")))
    const a = new EspacioStorage(base, "sesion-a")
    const b = new EspacioStorage(base, "sesion-b")
    expect((await registro.ejecutar("proveedor_armar_paquete", { caso }, ctx(a, "sesion-a"))).ok).toBe(true)
    expect((await a.listar(`${caso}/`)).length).toBeGreaterThan(0)
    expect(await b.listar("")).toEqual([])
    expect(await base.leer(`sesion-a/${caso}/paquete/checklist.md`)).not.toBeNull()
    expect(await base.leer(`${caso}/paquete/checklist.md`)).toBeNull()
    expect(() => new EspacioStorage(base, "../fuera")).toThrow()
  })

  test("rearmar el paquete borra el ENVIO-SIMULADO.md anterior", async () => {
    const { storage } = await entorno()
    const c = ctx(storage, "s")
    await registro.ejecutar("proveedor_armar_paquete", { caso }, c)
    const confirmacion = { accion: "simular_envio", referencia: caso, resumen: "" }
    expect((await registro.ejecutar("proveedor_simular_envio", { caso, confirmado: true }, { ...c, confirmacion })).ok).toBe(true)
    expect(await storage.leer(`${caso}/ENVIO-SIMULADO.md`)).not.toBeNull()
    await registro.ejecutar("proveedor_armar_paquete", { caso }, c)
    expect(await storage.leer(`${caso}/ENVIO-SIMULADO.md`)).toBeNull()
  })

  test("una confirmación de otra acción no autoriza el envío", async () => {
    const { storage } = await entorno()
    const c = ctx(storage, "s")
    await registro.ejecutar("proveedor_armar_paquete", { caso }, c)
    const otra = { accion: "otra_cosa", referencia: caso, resumen: "" }
    expect((await registro.ejecutar("proveedor_simular_envio", { caso, confirmado: true }, { ...c, confirmacion: otra })).ok).toBe(false)
  })

  test("armar_paquete devuelve el borrador, sin datos bancarios", async () => {
    const { storage } = await entorno()
    const ej = await registro.ejecutar("proveedor_armar_paquete", { caso: "co-industrias-delta" }, ctx(storage, "s"))
    const datos = (JSON.parse(ej.resultado) as { data: { borrador_correo: string } }).data
    expect(datos.borrador_correo).toContain("Asunto: RE:")
    expect(datos.borrador_correo).not.toContain("03100012345")
  })
})

describe("fecha de referencia (HU-4)", () => {
  test("por defecto es la fecha de ejecución; FECHA_REFERENCIA la fija", () => {
    expect(fechaReferencia({}, new Date("2026-11-05T03:00:00Z"))).toBe("2026-11-04") // 22:00 en Bogotá
    expect(fechaReferencia({ FECHA_REFERENCIA: "2026-09-03" })).toBe("2026-09-03")
    expect(fechaReferencia({ FECHA_REFERENCIA: "mañana" }, new Date("2026-11-04T15:00:00Z"))).toBe("2026-11-04")
  })
})

describe("topes y errores (CA1 / CA5)", () => {
  test("al llegar al tope de iteraciones responde con lo hecho y lo que falta", async () => {
    const { ctxBase } = await entorno()
    const guion = Array.from({ length: 3 }, (_, i) => respuesta([llamada(`${i}`, "proveedor_listar_casos", {})]))
    const t = await ejecutarTurno({
      sesion: nuevaSesion("tope"),
      mensaje: "hola",
      adapter: adaptadorGuionado(guion),
      registro,
      system: "",
      ctxBase,
      config: { ...config, maxIteraciones: 3 },
    })
    expect(t.reply).toContain("tope de 3 pasos")
    expect(t.reply).toContain("Lo que falta")
  })

  test("un error del proveedor se informa y la sesión sigue", async () => {
    const { ctxBase } = await entorno()
    const sesion = nuevaSesion("err")
    const t = await ejecutarTurno({ sesion, mensaje: "hola", adapter: adaptadorGuionado([]), registro, system: "", ctxBase, config })
    expect(t.error).toBe(true)
    expect(t.reply).toContain("La sesión sigue activa")
    expect(sesion.mensajes).toHaveLength(1)
  })

  test("argumentos inválidos vuelven al modelo como error, sin lanzar", async () => {
    const { storage } = await entorno()
    const ej = await registro.ejecutar("proveedor_leer_solicitud", { caso: 42 }, {
      directory: process.cwd(), sessionId: "s", fechaReferencia: "2026-09-03", storage, confirmacion: null,
    })
    expect(ej.ok).toBe(false)
    expect(ej.resumen).toContain("argumentos inválidos")
  })
})
