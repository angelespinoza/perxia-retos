import { describe, expect, test } from "bun:test"
import { generarBorradorCorreo } from "../src/domain/documentos.ts"
import { leerGlosario, leerIndiceSoportes, leerMaestro, leerSolicitud } from "../src/domain/fixtures.ts"
import { agrupar, mapearCampo, mapearCampos } from "../src/domain/mapeo.ts"
import { evaluarSoportes, listoParaFirma } from "../src/domain/soportes.ts"

const dir = process.cwd()
const maestro = await leerMaestro(dir)
const glosario = await leerGlosario(dir)

describe("mapeo de campos (HU-2)", () => {
  test("sinónimo exacto del glosario queda lleno con su ruta", () => {
    const c = mapearCampo("Número de cuenta", "CO", maestro, glosario)
    expect(c.estado).toBe("lleno")
    expect(c.ruta_maestro).toBe("banco.numero_cuenta")
    expect(c.confianza).toBe(1)
  })

  test("campo sin fuente es faltante y nunca trae valor", () => {
    const c = mapearCampo("Referencias comerciales", "HN", maestro, glosario)
    expect(c.estado).toBe("faltante")
    expect(c.valor).toBeUndefined()
  })

  test("RN1: identificador extranjero queda por confirmar con el NIT", () => {
    for (const [etiqueta, pais] of [["RUC", "EC"], ["RTN", "HN"], ["RUC", "PA"]] as const) {
      const c = mapearCampo(etiqueta, pais, maestro, glosario)
      expect(c.estado).toBe("requiere_confirmacion")
      expect(c.valor).toBe("900123456")
      expect(c.nota).toContain("identificador extranjero")
    }
  })

  test("NIT en Colombia se llena sin confirmación", () => {
    expect(mapearCampo("NIT", "CO", maestro, glosario).estado).toBe("lleno")
  })

  test("etiqueta ambigua en Colombia pide confirmación y propone NIT", () => {
    const c = mapearCampo("Identificación tributaria", "CO", maestro, glosario)
    expect(c.estado).toBe("requiere_confirmacion")
    expect(c.nota).toContain("NIT")
  })

  test("ec-corp-andina: 13 llenos, 1 faltante, 1 por confirmar", async () => {
    const s = await leerSolicitud(dir, "ec-corp-andina")
    const etiquetas = ["Nombre de la empresa", "RUC", "Número de contribuyente especial", "Domicilio fiscal", "Ciudad", "País", "Teléfono", "Correo electrónico", "Página web", "Representante legal", "Cargo del representante legal", "Actividad económica", "Banco", "Número de cuenta", "SWIFT"]
    const g = agrupar(mapearCampos(etiquetas, s.pais, maestro, glosario))
    expect(g.llenos).toHaveLength(13)
    expect(g.faltantes.map((c) => c.etiqueta)).toEqual(["Número de contribuyente especial"])
    expect(g.requiere_confirmacion.map((c) => c.etiqueta)).toEqual(["RUC"])
  })
})

describe("soportes y firma (RN3)", () => {
  test("vencido y ausente bloquean listo_para_firma", async () => {
    const indice = await leerIndiceSoportes(dir)
    const hn = evaluarSoportes(["camara_comercio", "rut", "parafiscales"], indice, "2026-09-03")
    expect(hn.find((s) => s.tipo === "parafiscales")?.estado).toBe("vencido")
    expect(listoParaFirma(hn)).toBe(false)
    const ec = evaluarSoportes(["rut", "certificado_cumplimiento_tributario"], indice, "2026-09-03")
    expect(ec.at(-1)?.estado).toBe("ausente")
    expect(listoParaFirma(ec)).toBe(false)
  })

  test("soporte sin vigencia no vence", async () => {
    const indice = await leerIndiceSoportes(dir)
    expect(evaluarSoportes(["rut"], indice, "2030-01-01")[0]?.estado).toBe("presente")
  })
})

describe("borrador de correo (RN2)", () => {
  test("nunca incluye datos bancarios", async () => {
    const s = await leerSolicitud(dir, "co-industrias-delta")
    const indice = await leerIndiceSoportes(dir)
    const correo = generarBorradorCorreo(s, evaluarSoportes(["certificacion_bancaria"], indice, "2026-09-03"), "formulario.xlsx")
    expect(correo).not.toContain("03100012345")
    expect(correo).not.toContain("COLOCOBM")
  })
})
