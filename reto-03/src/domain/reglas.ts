// Reglas de control RC1–RC10 (sección 7.3) como funciones puras sobre el paquete y los maestros.
import type { CentroCosto, Maestros, Proveedor } from "./fixtures.ts"
import { fechaBogota, normalizarNombre, normalizarTexto, type Paquete } from "./paquete.ts"

export type CodigoRegla = "RC1" | "RC2" | "RC3" | "RC4" | "RC5" | "RC6" | "RC7" | "RC8" | "RC9" | "RC10"

export interface Hallazgo {
  regla: CodigoRegla
  detalle: string
  /** Qué hacer para resolverlo (bloqueos) o qué se está aceptando (confirmaciones). */
  accion_sugerida: string
  valores?: Record<string, string | number | null>
}

export interface Derivado {
  valor: string
  fuente: string
  regla: CodigoRegla | null
  detalle: string
}

export interface Derivados {
  proveedor?: { codigo_sap: string; nit: string; nombre: string; resuelto_por: "nit" | "nombre"; fuente: string }
  indicador_iva?: Derivado
  condiciones_pago?: Derivado
  aprobador?: { email: string; nombre: string | null; tope: number; fuente: string }
}

export interface ResultadoValidacion {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
}

const TOLERANCIA_COTIZACION = 0.02
const TOLERANCIA_TOTAL = 1

export const formatoCop = (n: number) => new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(n)

/** Resultado de una regla: hallazgos que agrega y, si aplica, un valor derivado. */
interface Evaluacion {
  bloqueo?: Hallazgo
  confirmacion?: Hallazgo
}

// ---------- RC1: proveedor existe y está activo ----------

export function rc1(p: Paquete, proveedores: Proveedor[]): { proveedor: Proveedor | null; resuelto_por: "nit" | "nombre"; bloqueo?: Hallazgo } {
  const { proveedor_nit: nit, proveedor_nombre: nombre } = p.solicitud
  const resuelto_por = nit ? "nit" : "nombre"
  const proveedor = nit
    ? proveedores.find((x) => x.nit === nit)
    : proveedores.find((x) => normalizarNombre(x.nombre) === normalizarNombre(nombre))
  if (!proveedor)
    return {
      proveedor: null,
      resuelto_por,
      bloqueo: {
        regla: "RC1",
        detalle: nit
          ? `El proveedor con NIT ${nit} (${nombre}) no existe en el maestro de proveedores.`
          : `El proveedor «${nombre}» no existe en el maestro de proveedores (búsqueda por nombre, la solicitud no trae NIT).`,
        accion_sugerida: "Solicitar el alta del proveedor en SAP (RUT, certificación bancaria) antes de crear la OC.",
        valores: { nit: nit ?? null, nombre },
      },
    }
  if (!proveedor.activo)
    return {
      proveedor,
      resuelto_por,
      bloqueo: {
        regla: "RC1",
        detalle: `El proveedor ${proveedor.nombre} (código SAP ${proveedor.codigo_sap}) está inactivo.`,
        accion_sugerida: "Pedir a datos maestros la reactivación del proveedor o elegir otro proveedor activo.",
        valores: { codigo_sap: proveedor.codigo_sap },
      },
    }
  return { proveedor, resuelto_por }
}

// ---------- RC4: subárea del centro ----------

export function rc4(p: Paquete, centros: CentroCosto[]): { centro: CentroCosto | null; bloqueo?: Hallazgo } {
  const { centro_costo, subarea } = p.solicitud
  const centro = centros.find((c) => c.centro_costo === centro_costo) ?? null
  if (!centro)
    return {
      centro,
      bloqueo: {
        regla: "RC4",
        detalle: `El centro de costo ${centro_costo} no existe en el maestro.`,
        accion_sugerida: `Pedir al solicitante el centro de costo correcto (válidos: ${centros.map((c) => c.centro_costo).join(", ")}).`,
      },
    }
  const valida = centro.subareas.some((s) => normalizarTexto(s) === normalizarTexto(subarea))
  if (valida) return { centro }
  return {
    centro,
    bloqueo: {
      regla: "RC4",
      detalle: `La subárea «${subarea}» no pertenece al centro ${centro_costo}.`,
      accion_sugerida: `Pedir al solicitante una subárea válida de ${centro_costo}: ${centro.subareas.join(", ")}.`,
    },
  }
}

// ---------- RC2 y RC3: aprobación y tope ----------

function sugerirAprobador(centro: CentroCosto, total: number): string {
  const suficientes = centro.aprobadores.filter((a) => a.tope >= total)
  if (suficientes.length > 0)
    return `Pedir la aprobación a ${suficientes.map((a) => `${a.email} (tope ${formatoCop(a.tope)})`).join(" o ")}.`
  const lista = centro.aprobadores.map((a) => `${a.email} (tope ${formatoCop(a.tope)})`).join(", ")
  return `Pedir la aprobación a ${lista}, pero su tope es insuficiente para ${formatoCop(total)}: escalar a un nivel superior.`
}

export function rc2(p: Paquete, centro: CentroCosto | null): { aprobador: CentroCosto["aprobadores"][number] | null; bloqueo?: Hallazgo } {
  const a = p.aprobacion
  const accionBase = centro ? sugerirAprobador(centro, p.solicitud.valor_total) : "Corregir primero el centro de costo."
  if (!a)
    return { aprobador: null, bloqueo: { regla: "RC2", detalle: "No llegó el correo de aprobación del líder.", accion_sugerida: accionBase } }
  if (!a.aprobado)
    return {
      aprobador: null,
      bloqueo: { regla: "RC2", detalle: `El correo de ${a.de} no contiene una aprobación explícita («Aprobado»).`, accion_sugerida: accionBase },
    }
  if (!centro) return { aprobador: null }
  const aprobador = centro.aprobadores.find((x) => x.email.toLowerCase() === a.de.toLowerCase()) ?? null
  if (aprobador) return { aprobador }
  return {
    aprobador: null,
    bloqueo: {
      regla: "RC2",
      detalle: `${a.de} no es aprobador del centro ${centro.centro_costo}.`,
      accion_sugerida: accionBase,
      valores: { aprobo: a.de, centro_costo: centro.centro_costo },
    },
  }
}

export function rc3(p: Paquete, centro: CentroCosto | null, aprobador: CentroCosto["aprobadores"][number] | null): Evaluacion {
  if (!aprobador || !centro || p.solicitud.valor_total <= aprobador.tope) return {}
  return {
    bloqueo: {
      regla: "RC3",
      detalle: `El valor ${formatoCop(p.solicitud.valor_total)} supera el tope de ${aprobador.email} (${formatoCop(aprobador.tope)}) en ${centro.centro_costo}.`,
      accion_sugerida: sugerirAprobador(centro, p.solicitud.valor_total),
      valores: { valor_total: p.solicitud.valor_total, tope: aprobador.tope },
    },
  }
}

// ---------- RC5: cotización vs solicitud ----------

export function rc5(p: Paquete): Evaluacion {
  const s = p.solicitud
  if (!p.cotizacion)
    return {
      confirmacion: {
        regla: "RC5",
        detalle: "No llegó la cotización del proveedor: no se puede contrastar el valor de la solicitud.",
        accion_sugerida: `Confirmar que se crea la OC por ${formatoCop(s.valor_total)} ${s.moneda} sin cotización.`,
        valores: { solicitud: s.valor_total, cotizacion: null },
      },
    }
  const diferencia = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
  if (diferencia <= TOLERANCIA_COTIZACION) return {}
  const pct = Math.round(diferencia * 1000) / 10
  return {
    confirmacion: {
      regla: "RC5",
      detalle: `La cotización (${formatoCop(p.cotizacion.total)}) difiere ${pct} % de la solicitud (${formatoCop(s.valor_total)}); el máximo es 2 %.`,
      accion_sugerida: `Confirmar que la OC se crea con el valor de la solicitud (${formatoCop(s.valor_total)} ${s.moneda}).`,
      valores: { solicitud: s.valor_total, cotizacion: p.cotizacion.total, diferencia_pct: pct },
    },
  }
}

// ---------- RC6 y RC7: IVA y condiciones de pago ----------

export function rc6(p: Paquete, proveedor: Proveedor | null, maestros: Maestros): Evaluacion & { derivado?: Derivado } {
  const codigo = p.solicitud.indicador_iva
  if (codigo) {
    if (maestros.indicadoresIva.some((i) => i.codigo === codigo)) return {}
    return {
      bloqueo: {
        regla: "RC6",
        detalle: `El indicador de IVA «${codigo}» no existe en el maestro.`,
        accion_sugerida: `Pedir al solicitante un indicador válido: ${maestros.indicadoresIva.map((i) => i.codigo).join(", ")}.`,
      },
    }
  }
  if (!proveedor) return {}
  const iva = maestros.indicadoresIva.find((i) => i.codigo === proveedor.indicador_iva_default)
  const derivado: Derivado = {
    valor: proveedor.indicador_iva_default,
    fuente: "maestro.proveedores",
    regla: "RC6",
    detalle: `La solicitud no informa IVA; se usa el del proveedor: ${proveedor.indicador_iva_default}${iva ? ` (${iva.descripcion})` : ""}.`,
  }
  return {
    derivado,
    confirmacion: {
      regla: "RC6",
      detalle: derivado.detalle,
      accion_sugerida: `Confirmar el indicador de IVA ${proveedor.indicador_iva_default}.`,
      valores: { indicador_iva: proveedor.indicador_iva_default },
    },
  }
}

export function rc7(p: Paquete, proveedor: Proveedor | null, maestros: Maestros): Evaluacion & { derivado?: Derivado } {
  const codigo = p.solicitud.condiciones_pago
  if (codigo) {
    if (maestros.condicionesPago.some((c) => c.codigo === codigo)) return {}
    return {
      bloqueo: {
        regla: "RC7",
        detalle: `La condición de pago «${codigo}» no existe en el maestro.`,
        accion_sugerida: `Pedir una condición válida: ${maestros.condicionesPago.map((c) => c.codigo).join(", ")}.`,
      },
    }
  }
  if (!proveedor) return {}
  const condicion = maestros.condicionesPago.find((c) => c.codigo === proveedor.condiciones_pago_default)
  return {
    derivado: {
      valor: proveedor.condiciones_pago_default,
      fuente: "maestro.proveedores",
      regla: "RC7",
      detalle: `La solicitud no informa condiciones de pago; se usan las del proveedor: ${proveedor.condiciones_pago_default}${condicion ? ` (${condicion.descripcion})` : ""}.`,
    },
  }
}

// ---------- RC8 y RC9: fechas ----------

export function rc8(p: Paquete): Evaluacion & { retroactiva: boolean } {
  const f = p.factura
  if (!f || f.fecha >= p.solicitud.fecha_solicitud) return { retroactiva: false }
  return {
    retroactiva: true,
    confirmacion: {
      regla: "RC8",
      detalle: `OC retroactiva: la factura ${f.numero} es del ${f.fecha}, anterior a la solicitud (${p.solicitud.fecha_solicitud}).`,
      accion_sugerida: "Confirmar que se crea la OC sobre una factura ya emitida; quedará marcada retroactiva = true en el control.",
      valores: { factura: f.fecha, solicitud: p.solicitud.fecha_solicitud },
    },
  }
}

export function rc9(p: Paquete): Evaluacion {
  if (!p.aprobacion) return {}
  const fecha = fechaBogota(p.aprobacion.fecha)
  if (fecha >= p.solicitud.fecha_solicitud) return {}
  return {
    confirmacion: {
      regla: "RC9",
      detalle: `La aprobación (${fecha}) es anterior a la solicitud (${p.solicitud.fecha_solicitud}).`,
      accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
      valores: { aprobacion: fecha, solicitud: p.solicitud.fecha_solicitud },
    },
  }
}

// ---------- RC10: aritmética de la solicitud ----------

export function rc10(p: Paquete): Evaluacion {
  const { cantidad, valor_unitario, valor_total } = p.solicitud
  const calculado = cantidad * valor_unitario
  if (Math.abs(calculado - valor_total) <= TOLERANCIA_TOTAL) return {}
  return {
    bloqueo: {
      regla: "RC10",
      detalle: `cantidad × valor_unitario = ${formatoCop(calculado)}, distinto de valor_total ${formatoCop(valor_total)}.`,
      accion_sugerida: "Pedir al solicitante corregir cantidad, valor unitario o total en el Excel de solicitud.",
      valores: { calculado, valor_total },
    },
  }
}

// ---------- evaluación completa ----------

export function validarPaquete(p: Paquete, maestros: Maestros): ResultadoValidacion {
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Derivados = {}
  const anotar = (e: Evaluacion) => {
    if (e.bloqueo) bloqueos.push(e.bloqueo)
    if (e.confirmacion) confirmaciones.push(e.confirmacion)
  }

  const r1 = rc1(p, maestros.proveedores)
  anotar(r1)
  if (r1.proveedor && !r1.bloqueo)
    derivados.proveedor = {
      codigo_sap: r1.proveedor.codigo_sap,
      nit: r1.proveedor.nit,
      nombre: r1.proveedor.nombre,
      resuelto_por: r1.resuelto_por,
      fuente: "maestro.proveedores",
    }
  const proveedor = r1.bloqueo ? null : r1.proveedor

  const r4 = rc4(p, maestros.centros)
  const r2 = rc2(p, r4.centro)
  anotar(r2)
  anotar(rc3(p, r4.centro, r2.aprobador))
  anotar(r4)
  if (r2.aprobador && !r2.bloqueo)
    derivados.aprobador = {
      email: r2.aprobador.email,
      nombre: r2.aprobador.nombre ?? null,
      tope: r2.aprobador.tope,
      fuente: "maestro.centros-costo",
    }

  anotar(rc5(p))
  const r6 = rc6(p, proveedor, maestros)
  anotar(r6)
  if (r6.derivado) derivados.indicador_iva = r6.derivado
  const r7 = rc7(p, proveedor, maestros)
  anotar(r7)
  if (r7.derivado) derivados.condiciones_pago = r7.derivado
  const r8 = rc8(p)
  anotar(r8)
  anotar(rc9(p))
  anotar(rc10(p))

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva: r8.retroactiva }
}
