/// <reference types="bun" />
// Prueba el ciclo del agente con un adaptador simulado que reproduce el flujo de la sección 11 del PRD.
import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registro } from "../src/agente.ts"
import { esAfirmativo } from "../src/core/confirm.ts"
import { ejecutarTurno, type ConfigCiclo } from "../src/core/loop.ts"
import { nuevaSesion } from "../src/core/session.ts"
import { FsStorage } from "../src/core/storage.ts"
import type { LlmAdapter, Mensaje, RespuestaLlm, ToolCall } from "../src/llm/adapter.ts"

const config: ConfigCiclo = { maxIteraciones: 25, maxTokensSesion: 1_000_000, timeoutMs: 1000, presupuestoMs: 60_000 }
const caso = "sol-004"

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
  const storage = new FsStorage(await mkdtemp(join(tmpdir(), "reto03-")))
  return { storage, ctxBase: { directory: process.cwd(), fechaReferencia: "2026-09-03", storage } }
}

const pasosHastaPayload = (c: string) => [
  respuesta([llamada("1", "oc_leer_paquete", { caso: c })]),
  respuesta([llamada("2", "oc_validar", { caso: c })]),
  respuesta([llamada("3", "oc_generar_evidencia", { caso: c }), llamada("4", "oc_construir_payload", { caso: c })]),
]

describe("confirmación humana (CA3)", () => {
  test("detecta confirmaciones y negaciones", () => {
    expect(esAfirmativo("confirmo")).toBe(true)
    expect(esAfirmativo("Sí, créala.")).toBe(true)
    expect(esAfirmativo("no la crees todavía")).toBe(false)
    expect(esAfirmativo("¿por qué difiere la cotización?")).toBe(false)
  })

  test("flujo del PRD: sol-004 pide confirmación y solo crea la OC tras «confirmo»", async () => {
    const { storage, ctxBase } = await entorno()
    const sesion = nuevaSesion("prueba")
    const adapter = adaptadorGuionado([
      ...pasosHastaPayload(caso),
      respuesta([
        llamada("5", "agente_solicitar_confirmacion", { accion: "crear_oc", referencia: caso, resumen: "Se crearía la OC por 25.000.000 COP." }),
      ]),
      // Pidió confirmación sin resumen: el ciclo hace una llamada más solo para redactarlo.
      respuesta([], "| Campo | Valor |\n| --- | --- |\n| Proveedor | 100310 Cloud Andina |\n\nRC5: solicitud 25.000.000 vs cotización 26.500.000. ¿Confirmas la creación?"),
      respuesta([llamada("6", "oc_crear", { caso, confirmado: true })]),
      respuesta([], "OC 4500000001 creada."),
    ])
    const base = { sesion, adapter, registro, system: "prueba", ctxBase, config }

    const t1 = await ejecutarTurno({
      ...base,
      mensaje: `Procesa la solicitud "${caso}". Muéstrame la OC y no la crees hasta que yo lo confirme.`,
    })
    expect(t1.needsConfirmation).toBe(true)
    expect(t1.pendiente?.referencia).toBe(caso)
    expect(t1.reply).toContain("26.500.000")
    expect(t1.toolCalls.map((t) => t.herramienta)).toEqual([
      "oc_leer_paquete",
      "oc_validar",
      "oc_generar_evidencia",
      "oc_construir_payload",
      "agente_solicitar_confirmacion",
    ])
    expect(t1.toolCalls.every((t) => t.ok)).toBe(true)
    expect(await storage.leer("sap/ordenes.jsonl")).toBeNull()

    const t2 = await ejecutarTurno({ ...base, mensaje: "confirmo" })
    expect(t2.toolCalls[0]?.ok).toBe(true)
    expect(t2.toolCalls[0]?.resumen).toContain("numero_oc: 4500000001")
    expect(await storage.leerTexto("sap/ordenes.jsonl")).toContain("SOL-2026-004")
    const control = (await storage.leerTexto("control.csv")) ?? ""
    expect(control).toContain("SOL-2026-004,creada,4500000001,false,,RC5,")
    expect(await storage.leerTexto(`${caso}/oc.json`)).toContain("analista (sesión prueba)")
  })

  test("sin confirmación pendiente, confirmado:true se rechaza y no se crea la OC", async () => {
    const { storage, ctxBase } = await entorno()
    const adapter = adaptadorGuionado([
      ...pasosHastaPayload(caso),
      respuesta([llamada("5", "oc_crear", { caso, confirmado: true })]),
      respuesta([], "No pude crear la OC."),
    ])
    const t = await ejecutarTurno({ sesion: nuevaSesion("x"), mensaje: "crea la OC de sol-004", adapter, registro, system: "", ctxBase, config })
    expect(t.toolCalls[4]?.ok).toBe(false)
    expect(t.toolCalls[4]?.resumen).toContain("requiere confirmación explícita")
    expect(await storage.leer("sap/ordenes.jsonl")).toBeNull()
  })

  test("sin confirmado, una OC con confirmaciones queda pendiente en el control", async () => {
    const { storage, ctxBase } = await entorno()
    const adapter = adaptadorGuionado([...pasosHastaPayload("sol-005"), respuesta([llamada("5", "oc_crear", { caso: "sol-005" })]), respuesta([], "Falta confirmar.")])
    const t = await ejecutarTurno({ sesion: nuevaSesion("p"), mensaje: "procesa sol-005", adapter, registro, system: "", ctxBase, config })
    expect(t.toolCalls[4]?.ok).toBe(false)
    expect(await storage.leerTexto("control.csv")).toContain("SOL-2026-005,pendiente,,true,,RC8,")
  })

  test("sol-001 se crea sin intervención humana y la segunda vez es idempotente", async () => {
    const { ctxBase } = await entorno()
    const adapter = adaptadorGuionado([
      ...pasosHastaPayload("sol-001"),
      respuesta([llamada("5", "oc_crear", { caso: "sol-001" })]),
      respuesta([llamada("6", "oc_crear", { caso: "sol-001" })]),
      respuesta([], "OC 4500000001."),
    ])
    const t = await ejecutarTurno({ sesion: nuevaSesion("i"), mensaje: "procesa sol-001", adapter, registro, system: "", ctxBase, config })
    expect(t.toolCalls[4]?.resumen).toContain("idempotente: false")
    expect(t.toolCalls[5]?.resumen).toContain("numero_oc: 4500000001")
    expect(t.toolCalls[5]?.resumen).toContain("idempotente: true")
  })
})

describe("orden de pasos y errores (CA1 / CA5 / HU-6)", () => {
  test("un paso fuera de orden responde qué falta", async () => {
    const { storage } = await entorno()
    const ctx = { directory: process.cwd(), sessionId: "s", fechaReferencia: "2026-09-03", storage, confirmacion: null }
    const ej = await registro.ejecutar("oc_construir_payload", { caso: "sol-001" }, ctx)
    expect(ej.ok).toBe(false)
    expect(ej.resumen).toContain("primero llama a oc_validar")
  })

  test("un payload modificado por el modelo se rechaza", async () => {
    const { storage } = await entorno()
    const ctx = { directory: process.cwd(), sessionId: "s", fechaReferencia: "2026-09-03", storage, confirmacion: null }
    for (const h of ["oc_leer_paquete", "oc_validar", "oc_generar_evidencia", "oc_construir_payload"])
      await registro.ejecutar(h, { caso: "sol-001" }, ctx)
    const payload = JSON.parse((await storage.leerTexto("sol-001/payload.json")) ?? "{}") as Record<string, unknown>
    payload.moneda = "USD"
    const ej = await registro.ejecutar("oc_crear", { caso: "sol-001", payload }, ctx)
    expect(ej.ok).toBe(false)
    expect(ej.resumen).toContain("no coincide")
    expect(await storage.leer("sap/ordenes.jsonl")).toBeNull()
  })

  test("al llegar al tope de iteraciones responde con lo hecho y lo que falta", async () => {
    const { ctxBase } = await entorno()
    const guion = Array.from({ length: 3 }, (_, i) => respuesta([llamada(`${i}`, "oc_listar_casos", {})]))
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

  test("argumentos inválidos y caso inexistente vuelven al modelo como error, sin lanzar", async () => {
    const { storage } = await entorno()
    const ctx = { directory: process.cwd(), sessionId: "s", fechaReferencia: "2026-09-03", storage, confirmacion: null }
    const invalido = await registro.ejecutar("oc_leer_paquete", { caso: 42 }, ctx)
    expect(invalido.resumen).toContain("argumentos inválidos")
    const inexistente = await registro.ejecutar("oc_leer_paquete", { caso: "sol-999" }, ctx)
    expect(inexistente.ok).toBe(false)
    expect(inexistente.resumen).toContain("caso inexistente")
  })
})
