// Persistencia de out/ y de las sesiones. Disco en local; Vercel Blob privado en Vercel.
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative } from "node:path"
import { del, get, list, put } from "@vercel/blob"

export interface Storage {
  readonly tipo: "disco" | "blob"
  leer(ruta: string): Promise<Uint8Array | null>
  leerTexto(ruta: string): Promise<string | null>
  escribir(ruta: string, contenido: string | Uint8Array): Promise<void>
  anexar(ruta: string, linea: string): Promise<void>
  listar(prefijo: string): Promise<string[]>
  /** Borra estos archivos (los que no existen se ignoran). */
  borrar(rutas: string[]): Promise<void>
  borrarTodo(): Promise<void>
}

/** Rechaza rutas absolutas o que intenten salir de out/. */
export function rutaSegura(ruta: string): string {
  const limpia = normalize(ruta).replace(/^(\.\/)+/, "")
  if (isAbsolute(limpia) || limpia.startsWith("..") || limpia.includes("\0")) {
    throw new Error(`ruta no permitida: ${ruta}`)
  }
  return limpia
}

export class FsStorage implements Storage {
  readonly tipo = "disco" as const
  constructor(private readonly raiz: string) {}

  private abs(ruta: string): string {
    return join(this.raiz, rutaSegura(ruta))
  }

  async leer(ruta: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.abs(ruta)))
    } catch {
      return null
    }
  }

  async leerTexto(ruta: string): Promise<string | null> {
    const bytes = await this.leer(ruta)
    return bytes ? new TextDecoder().decode(bytes) : null
  }

  async escribir(ruta: string, contenido: string | Uint8Array): Promise<void> {
    const destino = this.abs(ruta)
    await mkdir(dirname(destino), { recursive: true })
    await writeFile(destino, contenido)
  }

  async anexar(ruta: string, linea: string): Promise<void> {
    const destino = this.abs(ruta)
    await mkdir(dirname(destino), { recursive: true })
    await appendFile(destino, linea.endsWith("\n") ? linea : `${linea}\n`)
  }

  async listar(prefijo: string): Promise<string[]> {
    const archivos: string[] = []
    const recorrer = async (dir: string): Promise<void> => {
      const entradas = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entradas) {
        const ruta = join(dir, e.name)
        if (e.isDirectory()) await recorrer(ruta)
        else if (e.isFile()) archivos.push(relative(this.raiz, ruta))
      }
    }
    await recorrer(this.abs(prefijo || "."))
    return archivos.sort()
  }

  async borrar(rutas: string[]): Promise<void> {
    await Promise.all(rutas.map((r) => rm(this.abs(r), { force: true })))
  }

  async borrarTodo(): Promise<void> {
    await rm(this.raiz, { recursive: true, force: true })
    await mkdir(this.raiz, { recursive: true })
  }
}

/** Vercel Blob privado. `anexar` es leer-modificar-escribir: válido para la demo de un usuario. */
export class BlobStorage implements Storage {
  readonly tipo = "blob" as const
  constructor(private readonly prefijo = "out/") {}

  private clave(ruta: string): string {
    return `${this.prefijo}${rutaSegura(ruta)}`
  }

  async leer(ruta: string): Promise<Uint8Array | null> {
    const res = await get(this.clave(ruta), { access: "private", useCache: false }).catch(() => null)
    if (!res || res.statusCode !== 200) return null
    return new Uint8Array(await new Response(res.stream).arrayBuffer())
  }

  async leerTexto(ruta: string): Promise<string | null> {
    const bytes = await this.leer(ruta)
    return bytes ? new TextDecoder().decode(bytes) : null
  }

  async escribir(ruta: string, contenido: string | Uint8Array): Promise<void> {
    const cuerpo = typeof contenido === "string" ? contenido : Buffer.from(contenido)
    await put(this.clave(ruta), cuerpo, { access: "private", addRandomSuffix: false, allowOverwrite: true })
  }

  async anexar(ruta: string, linea: string): Promise<void> {
    const actual = (await this.leerTexto(ruta)) ?? ""
    await this.escribir(ruta, `${actual}${linea.endsWith("\n") ? linea : `${linea}\n`}`)
  }

  async listar(prefijo: string): Promise<string[]> {
    const rutas: string[] = []
    let cursor: string | undefined
    do {
      const pagina = await list({ prefix: prefijo ? this.clave(prefijo) : this.prefijo, cursor })
      rutas.push(...pagina.blobs.map((b) => b.pathname.slice(this.prefijo.length)))
      cursor = pagina.hasMore ? pagina.cursor : undefined
    } while (cursor)
    return rutas.sort()
  }

  async borrar(rutas: string[]): Promise<void> {
    if (rutas.length > 0) await del(rutas.map((r) => this.clave(r)))
  }

  async borrarTodo(): Promise<void> {
    await this.borrar(await this.listar(""))
  }
}

/** Espacio propio de una sesión web: out/<sessionId>/... Parte vacío, así cada sesión empieza de cero
 * (buzón sin procesar, copia limpia del maestro, sin OC previas). demo.ts usa el Storage base (out/). */
export class EspacioStorage implements Storage {
  readonly tipo: Storage["tipo"]
  private readonly prefijo: string
  constructor(
    private readonly base: Storage,
    espacio: string,
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(espacio)) throw new Error(`espacio inválido: ${espacio}`)
    this.tipo = base.tipo
    this.prefijo = `${espacio}/`
  }

  private ruta(r: string): string {
    return `${this.prefijo}${rutaSegura(r)}`
  }

  leer(r: string) {
    return this.base.leer(this.ruta(r))
  }
  leerTexto(r: string) {
    return this.base.leerTexto(this.ruta(r))
  }
  escribir(r: string, contenido: string | Uint8Array) {
    return this.base.escribir(this.ruta(r), contenido)
  }
  anexar(r: string, linea: string) {
    return this.base.anexar(this.ruta(r), linea)
  }
  async listar(prefijo: string): Promise<string[]> {
    const rutas = await this.base.listar(prefijo ? this.ruta(prefijo) : this.prefijo)
    return rutas.filter((r) => r.startsWith(this.prefijo)).map((r) => r.slice(this.prefijo.length))
  }
  borrar(rutas: string[]) {
    return this.base.borrar(rutas.map((r) => this.ruta(r)))
  }
  async borrarTodo(): Promise<void> {
    await this.borrar(await this.listar(""))
  }
}

export function crearStorage(directory: string): Storage {
  if (process.env.BLOB_READ_WRITE_TOKEN) return new BlobStorage()
  const raiz = process.env.OUT_DIR || join(directory, "out")
  return new FsStorage(isAbsolute(raiz) ? raiz : join(directory, raiz))
}
