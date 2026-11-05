// Interfaz del adaptador SAP (sección 7.4). La implementación simulada está en mock.ts; la real se diseña en SOLUCION.md.
import type { OrdenCompra } from "../domain/orden.ts"

export type { OrdenCompra }

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
