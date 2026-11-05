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
import type { LlmAdapter, RespuestaLlm, ToolCall } from "../src/llm/adapter.ts"

const config: ConfigCiclo = { maxIteraciones: 25, maxTokensSesion: 1_000_000, timeoutMs: 1000, presupuestoMs: 60_000 }
const ids = ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"]

function respuesta(llamadas: ToolCall[], texto = ""): RespuestaLlm {
  return { texto, llamadas, uso: { entrada: 10, salida: 5 }, fin: llamadas.length ? "herramientas" : "fin" }
}

function adaptadorGuionado(guion: RespuestaLlm[]): LlmAdapter {
  return {
    provider: "simulado",
    model: "guion",
    async enviar() {
      const siguiente = guion.shift()
      if (!siguiente) throw new Error("guion agotado")
      return siguiente
    },
  }
}

const llamada = (id: string, nombre: string, args: Record<string, unknown>): ToolCall => ({ id, nombre, args })
const porMensaje = (prefijo: string, nombre: string, args: (m: string) => Record<string, unknown>, lista = ids) =>
  lista.map((m) => llamada(`${prefijo}-${m}`, nombre, args(m)))

async function entorno() {
  const storage = new FsStorage(await mkdtemp(join(tmpdir(), "reto02-")))
  return { storage, ctxBase: { directory: process.cwd(), fechaReferencia: "2026-09-03", storage } }
}

describe("confirmación humana (CA3 / RN5)", () => {
  test("detecta la confirmación del PRD y las negativas", () => {
    expect(esAfirmativo("confirmo el valor 0 y la fecha fin 2027-08-31")).toBe(true)
    expect(esAfirmativo("Sí, regístralo")).toBe(true)
    expect(esAfirmativo("no registres nada dudoso")).toBe(false)
    expect(esAfirmativo("¿qué falta?")).toBe(false)
  })

  test("flujo de la sección 11: registra lo limpio, pide confirmación de msg-006 y lo registra tras «confirmo»", async () => {
    const { storage, ctxBase } = await entorno()
    const sesion = nuevaSesion("prueba")
    const limpios = ids.filter((m) => m !== "msg-006")
    const adapter = adaptadorGuionado([
      respuesta([llamada("1", "contratos_leer_buzon", {})]),
      respuesta(porMensaje("e", "contratos_extraer", (m) => ({ mensaje_id: m }))),
      respuesta(porMensaje("v", "contratos_validar", (m) => ({ mensaje_id: m, contrato: {} }))),
      respuesta(porMensaje("r", "contratos_registrar", (m) => ({ mensaje_id: m, contrato: {} }), limpios)),
      respuesta([llamada("a", "contratos_alertas", { hoy: "2026-09-03" })]),
      respuesta(
        [llamada("c", "agente_solicitar_confirmacion", { accion: "registrar", referencia: "msg-006", resumen: "valor 0 y fecha fin 2027-08-31" })],
        "Procesé 6 mensajes: 2 nuevos, 1 actualización, 1 duplicado y 1 rechazado. msg-006 requiere revisión de valor y fecha_fin. ¿Confirmas el valor 0 y la fecha fin 2027-08-31?",
      ),
      respuesta([llamada("6", "contratos_registrar", { mensaje_id: "msg-006", contrato: { valor: 0, fecha_fin: "2027-08-31" }, confirmado: true })]),
      respuesta([llamada("a2", "contratos_alertas", { hoy: "2026-09-03" })]),
      respuesta([], "Listo: CM-2026-03 quedó registrado."),
    ])
    const base = { sesion, adapter, registro, system: "prueba", ctxBase, config }

    const t1 = await ejecutarTurno({ ...base, mensaje: "Procesa el buzón con fecha de hoy 2026-09-03. No registres nada dudoso sin preguntarme." })
    expect(t1.needsConfirmation).toBe(true)
    expect(t1.pendiente?.referencia).toBe("msg-006")
    expect(t1.toolCalls.filter((t) => t.herramienta === "contratos_registrar").every((t) => t.ok)).toBe(true)
    const maestro1 = (await storage.leerTexto("sharepoint/maestro-contratos.csv")) ?? ""
    expect(maestro1).toContain("CT-2026-015")
    expect(maestro1).not.toContain("CM-2026-03")

    const t2 = await ejecutarTurno({ ...base, mensaje: "confirmo el valor 0 y la fecha fin 2027-08-31" })
    expect(t2.toolCalls[0]?.ok).toBe(true)
    expect(await storage.leerTexto("sharepoint/maestro-contratos.csv")).toContain("CM-2026-03")
    expect(await storage.leerTexto("alertas.md")).toContain("CM-2026-03")
  })

  test("confirmado: true sin confirmación del usuario se rechaza y no escribe", async () => {
    const { storage, ctxBase } = await entorno()
    const adapter = adaptadorGuionado([
      respuesta([llamada("1", "contratos_registrar", { mensaje_id: "msg-006", contrato: { valor: 0 }, confirmado: true })]),
      respuesta([], "No pude registrar."),
    ])
    const t = await ejecutarTurno({ sesion: nuevaSesion("x"), mensaje: "registra msg-006", adapter, registro, system: "", ctxBase, config })
    expect(t.toolCalls[0]?.ok).toBe(false)
    expect(t.toolCalls[0]?.resumen).toContain("requiere confirmación explícita")
    expect(await storage.leer("sharepoint/maestro-contratos.csv")).toBeNull()
  })
})

describe("topes y errores (CA1 / CA5)", () => {
  test("al llegar al tope de iteraciones responde con lo hecho y lo que falta", async () => {
    const { ctxBase } = await entorno()
    const guion = Array.from({ length: 3 }, (_, i) => respuesta([llamada(`${i}`, "contratos_leer_buzon", {})]))
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
    const ctx = { directory: process.cwd(), sessionId: "s", fechaReferencia: "2026-09-03", storage, confirmacion: null }
    const ej = await registro.ejecutar("contratos_alertas", { hoy: "3 de septiembre" }, ctx)
    expect(ej.ok).toBe(false)
    expect(ej.resumen).toContain("argumentos inválidos")
    const moneda = await registro.ejecutar("contratos_validar", { mensaje_id: "msg-001", contrato: { moneda: "EUR" } }, ctx)
    expect(moneda.ok).toBe(false)
  })
})
