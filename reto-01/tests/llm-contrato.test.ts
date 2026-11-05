/// <reference types="bun" />
// Los tres adaptadores traducen el mismo historial neutro sin perder llamadas ni resultados.
import { describe, expect, test } from "bun:test"
import type { Mensaje } from "../src/llm/adapter.ts"
import { aMensajesApi as anthropic } from "../src/llm/anthropic.ts"
import { aContenidos as gemini } from "../src/llm/gemini.ts"
import { crearAdapter } from "../src/llm/index.ts"
import { aMensajesApi as openai } from "../src/llm/openai.ts"

const historial: Mensaje[] = [
  { rol: "usuario", texto: "Procesa ec-corp-andina" },
  { rol: "asistente", texto: "", llamadas: [{ id: "t1", nombre: "proveedor_leer_solicitud", args: { caso: "ec-corp-andina" } }] },
  { rol: "herramienta", resultados: [{ id: "t1", nombre: "proveedor_leer_solicitud", contenido: '{"ok":true,"data":{}}', esError: false }] },
  { rol: "usuario", texto: "envía" },
]

describe("contrato de adaptadores LLM", () => {
  test("Anthropic: tool_use y tool_result con el mismo id; usuario consecutivo agrupado", () => {
    const m = anthropic(historial)
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"])
    expect(JSON.stringify(m[1])).toContain('"tool_use"')
    expect(JSON.stringify(m[2])).toContain('"tool_use_id":"t1"')
    expect(JSON.stringify(m[2])).toContain("envía")
  })

  test("OpenAI: tool_calls en el asistente y mensaje rol tool con tool_call_id", () => {
    const m = openai(historial)
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "tool", "user"])
    expect(JSON.stringify(m[1])).toContain('"id":"t1"')
    expect(JSON.stringify(m[2])).toContain('"tool_call_id":"t1"')
  })

  test("Gemini: functionCall en el modelo y functionResponse en el usuario", () => {
    const c = gemini(historial)
    expect(c.map((x) => x.role)).toEqual(["user", "model", "user"])
    expect(JSON.stringify(c[1])).toContain('"functionCall"')
    expect(JSON.stringify(c[2])).toContain('"functionResponse"')
    expect(JSON.stringify(c[2])).toContain("envía")
  })

  test("selección por LLM_PROVIDER y errores claros de configuración", () => {
    expect(crearAdapter({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "x" })).toEqual({ error: "Falta la variable LLM_MODEL para el proveedor openai." })
    expect(crearAdapter({ LLM_PROVIDER: "gemini" })).toEqual({ error: "Falta la variable GEMINI_API_KEY para el proveedor gemini." })
    const a = crearAdapter({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "x", LLM_MODEL: "modelo-x" })
    expect("adapter" in a && a.adapter.provider).toBe("gemini")
    const b = crearAdapter({ ANTHROPIC_API_KEY: "x" })
    expect("adapter" in b && b.adapter.model).toBe("claude-opus-5-5")
  })
})
