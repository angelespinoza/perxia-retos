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
  test("detecta confirmaciones y negaciones", () => {
    expect(esAfirmativo("envía")).toBe(true)
    expect(esAfirmativo("Sí, confirmo.")).toBe(true)
    expect(esAfirmativo("confirmo el valor 0 y la fecha fin 2027-08-31")).toBe(true)
    expect(esAfirmativo("no envíes nada todavía")).toBe(false)
    expect(esAfirmativo("¿qué falta?")).toBe(false)
  })

  test("flujo del PRD: procesar, pedir confirmación y enviar solo tras «envía»", async () => {
    const { storage, ctxBase } = await entorno()
    const sesion = nuevaSesion("prueba")
    const adapter = adaptadorGuionado([
      respuesta([llamada("1", "proveedor_leer_solicitud", { caso })]),
      respuesta([llamada("2", "proveedor_mapear_campos", { caso, campos: [] })]),
      respuesta([llamada("3", "proveedor_generar_formulario", { caso }), llamada("4", "proveedor_armar_paquete", { caso })]),
      respuesta([llamada("5", "agente_solicitar_confirmacion", { accion: "simular_envio", referencia: caso, resumen: "Se enviaría el paquete." })]),
      // Pidió confirmación sin resumen: el ciclo hace una llamada más solo para redactarlo.
      respuesta([], "Resumen: 13 campos llenos, 1 faltante y 1 por confirmar. Falta un soporte. ¿Confirmas el envío simulado?"),
      respuesta([llamada("6", "proveedor_simular_envio", { caso, confirmado: true })]),
      respuesta([], "Listo: quedó ENVIO-SIMULADO.md."),
    ])
    const base = { sesion, adapter, registro, system: "prueba", ctxBase, config }

    const t1 = await ejecutarTurno({ ...base, mensaje: `Procesa el caso "${caso}". No envíes nada todavía.` })
    expect(t1.needsConfirmation).toBe(true)
    expect(t1.reply).toContain("13 campos llenos")
    expect(t1.reply).toContain("?")
    expect(t1.toolCalls.map((t) => t.herramienta)).toContain("proveedor_armar_paquete")
    expect(await storage.leer(`${caso}/ENVIO-SIMULADO.md`)).toBeNull()

    const t2 = await ejecutarTurno({ ...base, mensaje: "envía" })
    expect(t2.toolCalls[0]?.ok).toBe(true)
    expect(await storage.leerTexto(`${caso}/ENVIO-SIMULADO.md`)).toContain("Corporación Andina")
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
