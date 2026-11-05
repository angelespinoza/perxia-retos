// Reporte de alertas (HU-5): vencimientos, pólizas pendientes y registros desde el corte. Funciones puras.
import type { Fila } from "./clasificacion.ts"
import { diasEntre, sumarDias } from "./texto.ts"

export const FECHA_CORTE = "2026-05-30"
export const DIAS_AVISO = 60

export interface ContratoAlerta {
  id_contrato: string
  cliente: string
  fecha_fin: string
  dias: number
  comercial: string
  tipo_poliza?: string
  estado_poliza?: string
  fecha_registro?: string
  fuente?: string
}

export interface Actualizacion {
  id_contrato: string
  fecha: string
  campos: string[]
  mensaje_id: string
}

export interface Alertas {
  hoy: string
  vencen: ContratoAlerta[]
  polizas_pendientes: ContratoAlerta[]
  registrados_desde_corte: ContratoAlerta[]
  actualizados_desde_corte: Actualizacion[]
  vencidos_sin_cierre: ContratoAlerta[]
}

function aAlerta(f: Fila, hoy: string): ContratoAlerta {
  return {
    id_contrato: f.id_contrato ?? "",
    cliente: f.cliente ?? "",
    fecha_fin: f.fecha_fin ?? "",
    dias: f.fecha_fin ? diasEntre(hoy, f.fecha_fin) : Number.NaN,
    comercial: f.comercial ?? "",
    tipo_poliza: f.tipo_poliza ?? "",
    estado_poliza: f.estado_poliza ?? "",
    fecha_registro: f.fecha_registro ?? "",
    fuente: f.fuente ?? "",
  }
}

const porFin = (a: ContratoAlerta, b: ContratoAlerta) => a.fecha_fin.localeCompare(b.fecha_fin) || a.id_contrato.localeCompare(b.id_contrato)

export function calcularAlertas(maestro: Fila[], hoy: string, actualizaciones: Actualizacion[] = []): Alertas {
  const todas = maestro.map((f) => aAlerta(f, hoy))
  const vigentes = todas.filter((a) => a.dias >= 0)
  return {
    hoy,
    vencen: vigentes.filter((a) => a.dias <= DIAS_AVISO).sort(porFin),
    polizas_pendientes: maestro
      .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
      .map((f) => aAlerta(f, hoy))
      .sort(porFin),
    registrados_desde_corte: todas
      .filter((a) => (a.fecha_registro ?? "") >= FECHA_CORTE)
      .sort((a, b) => (a.fecha_registro ?? "").localeCompare(b.fecha_registro ?? "") || a.id_contrato.localeCompare(b.id_contrato)),
    actualizados_desde_corte: actualizaciones.filter((a) => a.fecha >= FECHA_CORTE),
    vencidos_sin_cierre: todas.filter((a) => a.dias < 0).sort(porFin),
  }
}

function tabla(cabecera: string[], filas: string[][]): string {
  if (filas.length === 0) return "_Ninguno._"
  return [`| ${cabecera.join(" | ")} |`, `| ${cabecera.map(() => "---").join(" | ")} |`, ...filas.map((f) => `| ${f.join(" | ")} |`)].join("\n")
}

export function alertasMarkdown(a: Alertas, rutaMaestro: string): string {
  const limite = sumarDias(a.hoy, DIAS_AVISO)
  return [
    `# Alertas de contratos — ${a.hoy}`,
    "",
    `Fuente: \`${rutaMaestro}\`. Generado por el agente de registro de contratos.`,
    "",
    `## 1. Vencen en ≤ ${DIAS_AVISO} días (hasta ${limite})`,
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días", "Comercial"], a.vencen.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(c.dias), c.comercial || "—"])),
    "",
    "## 2. Pólizas pendientes (requiere_poliza = true y estado_poliza ≠ vigente)",
    "",
    tabla(
      ["Contrato", "Cliente", "Tipo de póliza", "Estado", "Fecha fin"],
      a.polizas_pendientes.map((c) => [c.id_contrato, c.cliente, (c.tipo_poliza ?? "").replace(/;/g, ", "), c.estado_poliza ?? "", c.fecha_fin]),
    ),
    "",
    `## 3. Registrados desde el corte (${FECHA_CORTE}) — gap cubierto`,
    "",
    tabla(
      ["Contrato", "Cliente", "Fecha registro", "Fuente", "Comercial"],
      a.registrados_desde_corte.map((c) => [c.id_contrato, c.cliente, c.fecha_registro ?? "", c.fuente ?? "", c.comercial || "—"]),
    ),
    "",
    "Actualizados desde el corte (según `historial.jsonl`):",
    "",
    tabla(["Contrato", "Fecha", "Campos", "Mensaje"], a.actualizados_desde_corte.map((u) => [u.id_contrato, u.fecha, u.campos.join(", "), u.mensaje_id])),
    "",
    "## Vencidos sin cierre",
    "",
    "Contratos con fecha fin anterior a hoy que siguen en el maestro: confirmar si terminaron, se prorrogaron o falta un otrosí.",
    "",
    tabla(["Contrato", "Cliente", "Fecha fin", "Días vencido", "Comercial"], a.vencidos_sin_cierre.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, String(-c.dias), c.comercial || "—"])),
    "",
  ].join("\n")
}
