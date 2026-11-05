// SAP simulado sobre out/sap/: proveedores del maestro y órdenes en ordenes.jsonl, numeradas desde 4500000001.
import type { Storage } from "../core/storage.ts"
import { leerMaestros } from "../domain/fixtures.ts"
import type { OrdenCompra, SapAdapter } from "./adapter.ts"

export const ARCHIVO_ORDENES = "sap/ordenes.jsonl"
export const PRIMER_NUMERO = 4_500_000_001

export interface OrdenRegistrada {
  numero_oc: string
  fecha: string
  orden: OrdenCompra
}

export class MockSap implements SapAdapter {
  constructor(
    private readonly storage: Storage,
    private readonly directory: string,
    private readonly reloj: () => Date = () => new Date(),
  ) {}

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const { proveedores } = await leerMaestros(this.directory)
    const p = proveedores.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async ordenes(): Promise<OrdenRegistrada[]> {
    const texto = (await this.storage.leerTexto(ARCHIVO_ORDENES)) ?? ""
    return texto
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as OrdenRegistrada)
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const encontrada = (await this.ordenes()).find((o) => o.orden.referencia.solicitud_id === solicitud_id)
    return encontrada ? { numero_oc: encontrada.numero_oc } : null
  }

  /** Idempotente por solicitud_id: si ya existe, devuelve la misma OC y no escribe otra. */
  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const existentes = await this.ordenes()
    const previa = existentes.find((o) => o.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
    if (previa) return { numero_oc: previa.numero_oc, fecha: previa.fecha }
    const ultimo = existentes.reduce((max, o) => Math.max(max, Number(o.numero_oc)), PRIMER_NUMERO - 1)
    const registro: OrdenRegistrada = { numero_oc: String(ultimo + 1), fecha: this.reloj().toISOString(), orden }
    await this.storage.anexar(ARCHIVO_ORDENES, JSON.stringify(registro))
    return { numero_oc: registro.numero_oc, fecha: registro.fecha }
  }
}
