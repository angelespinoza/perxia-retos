// Lectura de fixtures/reto-02/ (solo lectura): buzón, comerciales y maestro congelado.
import { readdir, readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { z } from "zod"
import { pareceContrato } from "./extraccion.ts"

export const RAIZ_FIXTURES = "fixtures/reto-02"

export class ErrorFixture extends Error {
  constructor(mensaje: string) {
    super(mensaje)
    this.name = "ErrorFixture"
  }
}

const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Correo = z.infer<typeof CorreoSchema>

const ComercialSchema = z.array(z.object({ email: z.string(), nombre: z.string(), region: z.string() }))
export type Comercial = z.infer<typeof ComercialSchema>[number]

const ID_MENSAJE = /^[a-z0-9][a-z0-9-]*$/

export function validarMensajeId(id: string): void {
  if (!ID_MENSAJE.test(id)) throw new ErrorFixture(`identificador de mensaje inválido: ${id}`)
}

export async function listarMensajes(directory: string): Promise<string[]> {
  const entradas = await readdir(join(directory, RAIZ_FIXTURES, "buzon"), { withFileTypes: true })
  return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

export async function leerCorreo(directory: string, id: string): Promise<Correo> {
  validarMensajeId(id)
  const texto = await readFile(join(directory, RAIZ_FIXTURES, "buzon", id, "correo.json"), "utf8").catch(() => null)
  if (texto === null) throw new ErrorFixture(`mensaje inexistente: ${id}`)
  const correo = CorreoSchema.safeParse(JSON.parse(texto))
  if (!correo.success) throw new ErrorFixture(`correo.json de ${id} no tiene el formato esperado`)
  return correo.data
}

export interface Adjunto {
  nombre: string
  extension: string
  texto: string
}

export async function leerAdjuntos(directory: string, correo: Correo): Promise<Adjunto[]> {
  return Promise.all(
    correo.adjuntos.map(async (nombre) => {
      if (!/^[\w.-]+$/.test(nombre)) throw new ErrorFixture(`nombre de adjunto inválido: ${nombre}`)
      const texto = await readFile(join(directory, RAIZ_FIXTURES, "buzon", correo.id, nombre), "utf8").catch(() => "")
      return { nombre, extension: extname(nombre) || ".txt", texto }
    }),
  )
}

/** Primer adjunto que es un contrato u otrosí; null si el mensaje no trae ninguno. */
export function documentoContrato(adjuntos: Adjunto[]): Adjunto | null {
  return adjuntos.find((a) => pareceContrato(a.nombre, a.texto)) ?? null
}

export function motivoSinContrato(adjuntos: Adjunto[]): string {
  if (adjuntos.length === 0) return "el correo no trae adjuntos"
  const descripcion = adjuntos.map((a) => {
    const encabezado = (a.texto.trimStart().split("\n")[0] ?? "").trim()
    return `${a.nombre}${encabezado ? ` («${encabezado.slice(0, 60)}»)` : ""}`
  })
  return `sin adjunto de contrato: ${descripcion.join(", ")} no es un contrato ni un otrosí`
}

export async function leerComerciales(directory: string): Promise<Comercial[]> {
  return ComercialSchema.parse(JSON.parse(await readFile(join(directory, RAIZ_FIXTURES, "comerciales.json"), "utf8")))
}

export async function leerMaestroFixture(directory: string): Promise<string> {
  return readFile(join(directory, RAIZ_FIXTURES, "maestro-contratos.csv"), "utf8")
}
