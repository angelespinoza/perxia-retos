/// <reference types="bun" />
// Dominio: parsers, normalizadores, RC1–RC10 (una prueba por regla), payload y SAP simulado.
import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FsStorage } from "../src/core/storage.ts"
import { ErrorFixture, leerArchivosCaso, leerMaestros } from "../src/domain/fixtures.ts"
import { construirOrden, derivarUnidad, hashPayload, jsonCanonico, truncarDescripcion } from "../src/domain/orden.ts"
import {
  armarPaquete,
  esAprobacion,
  fechaBogota,
  normalizarNit,
  normalizarNombre,
  type Paquete,
  parsearCotizacion,
  parsearMonto,
} from "../src/domain/paquete.ts"
import { type CodigoRegla, rc1, rc10, rc2, rc3, rc4, rc5, rc6, rc7, rc8, rc9, validarPaquete } from "../src/domain/reglas.ts"
import { MockSap } from "../src/sap/mock.ts"

const dir = process.cwd()
const maestros = await leerMaestros(dir)
const paquete = async (caso: string) => armarPaquete(await leerArchivosCaso(dir, caso))
const base = await paquete("sol-001")
const con = (cambios: Partial<Paquete["solicitud"]>, resto: Partial<Paquete> = {}): Paquete => ({
  ...base,
  ...resto,
  solicitud: { ...base.solicitud, ...cambios },
})
const centro = (cc: string) => maestros.centros.find((c) => c.centro_costo === cc) ?? null

describe("parsers y normalizadores", () => {
  test("cotización: total, NIT sin DV, referencia y validez", () => {
    const c = base.cotizacion
    expect(c?.total).toBe(11_400_000)
    expect(c?.nit).toBe("900555111")
    expect(c?.numero).toBe("COT-TS-2026-0451")
    expect(c?.validez_hasta).toBe("2026-09-17")
  })

  test("factura del caso retroactivo", async () => {
    expect((await paquete("sol-005")).factura).toEqual({ numero: "FC-88231", fecha: "2026-08-10", total: 3_200_000 })
  })

  test("monto en formato colombiano y monto no numérico", () => {
    expect(parsearMonto("COP 1.850.000", "x")).toBe(1_850_000)
    expect(parsearMonto("1.234,5", "x")).toBe(1234.5)
    expect(() => parsearMonto("ocho millones", "x")).toThrow(ErrorFixture)
    expect(() => parsearCotizacion("COTIZACIÓN X\nsin total")).toThrow("TOTAL")
  })

  test("nombres comparables sin tildes ni sufijos societarios", () => {
    expect(normalizarNombre("TecnoSuministros S.A.S.")).toBe("tecnosuministros")
    expect(normalizarNombre("Papelería Central Ltda.")).toBe("papeleria central")
    expect(normalizarNombre("Mobiliario Andino S.A.")).toBe("mobiliario andino")
    expect(normalizarNit("900.555.111-2")).toBe("900555111")
  })

  test("aprobación explícita y negada; fecha en hora de Bogotá", () => {
    expect(esAprobacion("Aprobado por 25 millones según la solicitud.")).toBe(true)
    expect(esAprobacion("No aprobado, falta presupuesto.")).toBe(false)
    expect(esAprobacion("Revisemos la próxima semana.")).toBe(false)
    expect(fechaBogota("2026-08-21T03:00:00Z")).toBe("2026-08-20")
  })

  test("adjunto ausente se reporta en faltantes, sin excepción", () => {
    const p = armarPaquete({ correo: { id: "c", de: "a", asunto: "s", fecha: "f", adjuntos: ["factura.pdf"] }, solicitud: base.solicitud, cotizacionTexto: null, aprobacion: null, facturaTexto: null })
    expect(p.cotizacion).toBeNull()
    expect(p.faltantes).toEqual(["cotizacion.pdf", "aprobacion.eml", "factura.pdf"])
  })
})

describe("reglas de control", () => {
  test("RC1: NIT inexistente, proveedor inactivo y resolución por nombre", async () => {
    expect(rc1(await paquete("sol-002"), maestros.proveedores).bloqueo?.detalle).toContain("901999000")
    expect(rc1(con({ proveedor_nit: "901777888" }), maestros.proveedores).bloqueo?.detalle).toContain("inactivo")
    const porNombre = rc1(await paquete("sol-006"), maestros.proveedores)
    expect(porNombre.resuelto_por).toBe("nombre")
    expect(porNombre.proveedor?.codigo_sap).toBe("100234")
  })

  test("RC2: aprobador fuera del centro sugiere a quién pedir y si hay que escalar", async () => {
    const p = await paquete("sol-003")
    const r = rc2(p, centro("CC-2020"))
    expect(r.bloqueo?.regla).toBe("RC2")
    expect(r.bloqueo?.accion_sugerida).toContain("rtorres@periferia-ficticia.com")
    expect(r.bloqueo?.accion_sugerida).toContain("escalar")
    expect(rc2({ ...base, aprobacion: null }, centro("CC-1010")).bloqueo?.detalle).toContain("No llegó")
  })

  test("RC3: valor por encima del tope del aprobador", () => {
    const p = con({ cantidad: 1, valor_unitario: 60_000_000, valor_total: 60_000_000 })
    const r2 = rc2(p, centro("CC-1010"))
    const r = rc3(p, centro("CC-1010"), r2.aprobador)
    expect(r.bloqueo?.regla).toBe("RC3")
    expect(r.bloqueo?.accion_sugerida).toContain("dgarcia@periferia-ficticia.com")
  })

  test("RC4: subárea que no pertenece al centro", () => {
    expect(rc4(con({ subarea: "Marketing" }), maestros.centros).bloqueo?.regla).toBe("RC4")
    expect(rc4(con({ centro_costo: "CC-9999" }), maestros.centros).bloqueo?.detalle).toContain("no existe")
    expect(rc4(base, maestros.centros).bloqueo).toBeUndefined()
  })

  test("RC5: diferencia mayor a 2 % y cotización ausente piden confirmación con ambos valores", async () => {
    const r = rc5(await paquete("sol-004"))
    expect(r.confirmacion?.valores).toEqual({ solicitud: 25_000_000, cotizacion: 26_500_000, diferencia_pct: 6 })
    expect(rc5({ ...base, cotizacion: null }).confirmacion?.detalle).toContain("No llegó la cotización")
    expect(rc5(base).confirmacion).toBeUndefined()
  })

  test("RC6: IVA ausente se deriva del proveedor y se confirma", async () => {
    const p = await paquete("sol-006")
    const r = rc6(p, rc1(p, maestros.proveedores).proveedor, maestros)
    expect(r.derivado?.valor).toBe("C1")
    expect(r.confirmacion?.regla).toBe("RC6")
    expect(rc6(con({ indicador_iva: "C9" }), null, maestros).bloqueo?.regla).toBe("RC6")
  })

  test("RC7: condiciones de pago ausentes solo se informan", async () => {
    const p = await paquete("sol-006")
    const r = rc7(p, rc1(p, maestros.proveedores).proveedor, maestros)
    expect(r.derivado?.valor).toBe("Z030")
    expect(r.confirmacion).toBeUndefined()
  })

  test("RC8: factura anterior a la solicitud marca retroactiva", async () => {
    const r = rc8(await paquete("sol-005"))
    expect(r.retroactiva).toBe(true)
    expect(r.confirmacion?.regla).toBe("RC8")
    expect(rc8(base).retroactiva).toBe(false)
  })

  test("RC9: aprobación anterior a la solicitud", () => {
    const anterior = { ...base, aprobacion: base.aprobacion && { ...base.aprobacion, fecha: "2026-08-19T23:00:00-05:00" } }
    expect(rc9(anterior).confirmacion?.regla).toBe("RC9")
    expect(rc9(base).confirmacion).toBeUndefined()
  })

  test("RC10: cantidad × valor unitario debe igualar el total (± 1)", () => {
    expect(rc10(con({ valor_total: 11_400_001 })).bloqueo).toBeUndefined()
    expect(rc10(con({ valor_total: 11_400_002 })).bloqueo?.regla).toBe("RC10")
  })

  test("tabla de resultados esperados del SDD", async () => {
    const esperado: Record<string, { apta: boolean; bloqueos: CodigoRegla[]; confirmaciones: CodigoRegla[]; retroactiva: boolean }> = {
      "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false },
      "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false },
      "sol-003": { apta: false, bloqueos: ["RC2"], confirmaciones: [], retroactiva: false },
      "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false },
      "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true },
      "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false },
    }
    for (const [caso, e] of Object.entries(esperado)) {
      const v = validarPaquete(await paquete(caso), maestros)
      expect({ apta: v.apta, bloqueos: v.bloqueos.map((b) => b.regla), confirmaciones: v.confirmaciones.map((c) => c.regla), retroactiva: v.retroactiva }).toEqual(e)
    }
  })
})

describe("payload de la OC", () => {
  test("descripción a 40 caracteres en límite de palabra y unidad derivada", () => {
    expect(truncarDescripcion("Bolsa de 100 horas de arquitectura de nube para migración")).toBe("Bolsa de 100 horas de arquitectura")
    expect(truncarDescripcion("Corta")).toBe("Corta")
    expect(derivarUnidad("Bolsa de 100 horas")).toBe("H")
    expect(derivarUnidad("Soporte mensual")).toBe("MES")
    expect(derivarUnidad("Licencias, vigencia 12 meses")).toBe("UN")
  })

  test("sol-004 se arma con los valores de la solicitud y deja la diferencia como excepción", async () => {
    const p = await paquete("sol-004")
    const { orden, trazabilidad } = construirOrden(p, validarPaquete(p, maestros), "a".repeat(64))
    expect(orden.posiciones[0]?.precio_unitario).toBe(250_000)
    expect(orden.posiciones[0]?.unidad).toBe("H")
    expect(orden.excepciones).toEqual([expect.objectContaining({ codigo: "RC5", confirmado_por: null })])
    expect(trazabilidad["proveedor.codigo_sap"]?.fuente).toBe("maestro.proveedores")
    expect(trazabilidad["posiciones[0].precio_unitario"]?.fuente).toBe("solicitud")
    expect(trazabilidad["referencia.cotizacion_ref"]?.fuente).toBe("cotizacion")
  })

  test("sol-006: IVA y condiciones de pago con fuente derivado", async () => {
    const p = await paquete("sol-006")
    const { orden, trazabilidad } = construirOrden(p, validarPaquete(p, maestros), "b".repeat(64))
    expect(orden.condiciones_pago).toBe("Z030")
    expect(orden.proveedor.nit).toBe("900555111")
    expect(trazabilidad["posiciones[0].indicador_iva"]?.fuente).toBe("derivado")
    expect(trazabilidad.condiciones_pago?.fuente).toBe("derivado")
  })

  test("el hash no depende del orden de las claves", async () => {
    const p = await paquete("sol-001")
    const { orden } = construirOrden(p, validarPaquete(p, maestros), "c".repeat(64))
    const reordenado = Object.fromEntries(Object.entries(orden).reverse()) as typeof orden
    expect(jsonCanonico(reordenado)).toBe(jsonCanonico(orden))
    expect(hashPayload(reordenado)).toBe(hashPayload(orden))
  })
})

describe("SAP simulado", () => {
  test("numera desde 4500000001 y es idempotente por solicitud_id", async () => {
    const storage = new FsStorage(await mkdtemp(join(tmpdir(), "reto03-sap-")))
    const sap = new MockSap(storage, dir, () => new Date("2026-09-03T12:00:00Z"))
    const p1 = await paquete("sol-001")
    const p4 = await paquete("sol-004")
    const o1 = construirOrden(p1, validarPaquete(p1, maestros), "d".repeat(64)).orden
    const o4 = construirOrden(p4, validarPaquete(p4, maestros), "e".repeat(64)).orden
    expect(await sap.crearOrden(o1)).toEqual({ numero_oc: "4500000001", fecha: "2026-09-03T12:00:00.000Z" })
    expect((await sap.crearOrden(o1)).numero_oc).toBe("4500000001")
    expect((await sap.crearOrden(o4)).numero_oc).toBe("4500000002")
    expect(await sap.buscarOrdenPorReferencia("SOL-2026-001")).toEqual({ numero_oc: "4500000001" })
    expect(await sap.ordenes()).toHaveLength(2)
    expect(await sap.consultarProveedor("901777888")).toEqual({ codigo_sap: "100402", activo: false })
    expect(await sap.consultarProveedor("000")).toBeNull()
  })
})
