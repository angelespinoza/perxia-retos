// Elige el adaptador según LLM_PROVIDER. Cambiar de proveedor no toca el ciclo del agente.
import type { LlmAdapter } from "./adapter.ts"
import { AnthropicAdapter } from "./anthropic.ts"
import { GeminiAdapter } from "./gemini.ts"
import { OpenAIAdapter } from "./openai.ts"

export type Proveedor = "anthropic" | "openai" | "gemini"

export interface ConfigLlm {
  provider: Proveedor
  model: string
}

const MODELO_POR_DEFECTO: Partial<Record<Proveedor, string>> = { anthropic: "claude-opus-5-5" }
const VARIABLE_CLAVE: Record<Proveedor, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
}

export function leerConfigLlm(env = process.env): ConfigLlm {
  const valor = (env.LLM_PROVIDER ?? "anthropic").toLowerCase()
  const provider: Proveedor = valor === "openai" || valor === "gemini" ? valor : "anthropic"
  return { provider, model: env.LLM_MODEL || MODELO_POR_DEFECTO[provider] || "" }
}

/** Devuelve el adaptador o un mensaje claro de qué falta configurar. */
export function crearAdapter(env = process.env): { adapter: LlmAdapter } | { error: string } {
  const { provider, model } = leerConfigLlm(env)
  const clave = env[VARIABLE_CLAVE[provider]]
  if (!clave) return { error: `Falta la variable ${VARIABLE_CLAVE[provider]} para el proveedor ${provider}.` }
  if (!model) return { error: `Falta la variable LLM_MODEL para el proveedor ${provider}.` }
  if (provider === "openai") return { adapter: new OpenAIAdapter(model, clave) }
  if (provider === "gemini") return { adapter: new GeminiAdapter(model, clave) }
  const esfuerzo = env.LLM_EFFORT === "low" || env.LLM_EFFORT === "high" ? env.LLM_EFFORT : "medium"
  return { adapter: new AnthropicAdapter(model, clave, esfuerzo) }
}
