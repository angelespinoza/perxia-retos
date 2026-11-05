// Registro de herramientas: nombres <archivo>_<export>, JSON Schema desde zod, validación y ejecución segura.
import { z } from "zod"
import type { ToolSpec } from "../llm/adapter.ts"
import { verificarConfirmacion } from "./confirm.ts"
import { registrarLlamada, resumirArgs } from "./log.ts"
import { fail, parsearResultado, resumir, safe } from "./result.ts"
import type { Efecto, ToolCtx } from "./types.ts"

interface ToolGenerica {
  description: string
  args: z.ZodRawShape
  efecto?: Efecto
  execute: (args: never, ctx: ToolCtx) => Promise<string>
}

export interface HerramientaRegistrada {
  nombre: string
  efecto: Efecto
  schema: z.ZodObject<z.ZodRawShape>
  spec: ToolSpec
  tool: ToolGenerica
}

export interface Ejecucion {
  herramienta: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  resultado: string
  ms: number
}

export interface Registro {
  herramientas: HerramientaRegistrada[]
  specs(): ToolSpec[]
  ejecutar(nombre: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<Ejecucion>
}

function esTool(valor: unknown): valor is ToolGenerica {
  if (typeof valor !== "object" || valor === null) return false
  const v = valor as Record<string, unknown>
  return typeof v.description === "string" && typeof v.args === "object" && typeof v.execute === "function"
}

function formatearIssues(error: z.ZodError): string {
  return error.issues.map((i) => `'${i.path.join(".") || "args"}': ${i.message}`).join("; ")
}

/** `modulos` = { archivo: módulo importado }. Cada export que cumple el contrato queda como `<archivo>_<export>`. */
export function crearRegistro(modulos: Record<string, Record<string, unknown>>): Registro {
  const herramientas: HerramientaRegistrada[] = []
  for (const [archivo, modulo] of Object.entries(modulos)) {
    for (const [exportado, valor] of Object.entries(modulo)) {
      if (!esTool(valor)) continue
      const nombre = `${archivo}_${exportado}`
      const schema = z.object(valor.args)
      const parametros = z.toJSONSchema(schema) as Record<string, unknown>
      herramientas.push({
        nombre,
        efecto: valor.efecto ?? "lectura",
        schema,
        spec: { nombre, descripcion: valor.description, parametros },
        tool: valor,
      })
    }
  }

  return {
    herramientas,
    specs: () => herramientas.map((h) => h.spec),
    async ejecutar(nombre, args, ctx) {
      const inicio = Date.now()
      const h = herramientas.find((x) => x.nombre === nombre)
      const resultado = await ejecutarValidado(h, nombre, args, ctx)
      const parseado = parsearResultado(resultado)
      const ejecucion: Ejecucion = {
        herramienta: nombre,
        args,
        ok: parseado.ok,
        resumen: resumir(parseado),
        resultado,
        ms: Date.now() - inicio,
      }
      const caso = casoParaLog(args, parseado)
      await registrarLlamada(
        ctx.storage,
        {
          ts: new Date().toISOString(),
          sessionId: ctx.sessionId,
          herramienta: nombre,
          args_resumen: resumirArgs(args),
          ok: ejecucion.ok,
          resumen: ejecucion.resumen,
          ms: ejecucion.ms,
        },
        caso,
      ).catch(() => undefined)
      return ejecucion
    },
  }
}

/** RN5: log por caso, salvo cuando el caso no existe (no se crean carpetas para casos inválidos). */
function casoParaLog(args: Record<string, unknown>, resultado: { ok: boolean; error?: string }): string | null {
  const caso = typeof args.caso === "string" ? args.caso : null
  if (!caso || !/^[a-z0-9][a-z0-9-]*$/.test(caso)) return null
  if (!resultado.ok && /^(caso inexistente|nombre de caso inválido)/.test(resultado.error ?? "")) return null
  return caso
}

async function ejecutarValidado(
  h: HerramientaRegistrada | undefined,
  nombre: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  if (!h) return fail(`herramienta desconocida: ${nombre}`)
  const validacion = h.schema.safeParse(args)
  if (!validacion.success) return fail(`argumentos inválidos: ${formatearIssues(validacion.error)}`)
  const bloqueo = verificarConfirmacion(args, ctx)
  if (bloqueo) return fail(bloqueo)
  const ejecutar = h.tool.execute as (a: unknown, c: ToolCtx) => Promise<string>
  return safe(() => ejecutar(validacion.data, ctx))
}
