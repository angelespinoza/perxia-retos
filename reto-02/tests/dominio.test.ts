/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { calcularAlertas } from "../src/domain/alertas.ts"
import { clasificar } from "../src/domain/clasificacion.ts"
import { parsearCsv, serializarCsv } from "../src/domain/csv.ts"
import { extraerContrato } from "../src/domain/extraccion.ts"
import { finDePlazo, jaccard, numeroEnLetras, parsearCifra, slug } from "../src/domain/texto.ts"

const leer = (ruta: string) => readFile(`fixtures/reto-02/${ruta}`, "utf8")
const maestroTexto = await leer("maestro-contratos.csv")
const maestro = parsearCsv(maestroTexto).filas
const extraer = async (id: string, archivo = "contrato.txt") => extraerContrato(await leer(`buzon/${id}/${archivo}`))

describe("utilidades de texto", () => {
  test("números en letras", () => {
    expect(numeroEnLetras("DOSCIENTOS SESENTA Y CINCO MILLONES DE PESOS M/CTE")).toBe(265_000_000)
    expect(numeroEnLetras("CIENTO VEINTE MIL DÓLARES")).toBe(120_000)
    expect(numeroEnLetras("QUINIENTOS VEINTE MIL SOLES")).toBe(520_000)
    expect(numeroEnLetras("DOS MILLONES TRESCIENTOS MIL")).toBe(2_300_000)
  })

  test("separadores según moneda", () => {
    expect(parsearCifra("$265.000.000", "COP")).toBe(265_000_000)
    expect(parsearCifra("120,000.00", "USD")).toBe(120_000)
    expect(parsearCifra("520,000.00", "PEN")).toBe(520_000)
    expect(() => parsearCifra("1.2.3", "USD")).toThrow("monto con formato inválido")
  })

  test("plazo en meses, slug y similitud", () => {
    expect(finDePlazo("2026-08-15", 12)).toBe("2027-08-14")
    expect(finDePlazo("2026-08-01", 12)).toBe("2027-07-31")
    expect(slug("Industrias Delta S.A.S.")).toBe("industrias-delta")
    expect(slug("Agroexport Sula S. de R.L.")).toBe("agroexport-sula")
    expect(jaccard("Mesa de servicio TI", "mesa de servicio TI")).toBe(1)
    expect(jaccard("Soporte SAP", "Implementación CRM")).toBe(0)
  })

  test("CSV conserva columnas, orden y comas dentro de campos", () => {
    const tabla = parsearCsv(maestroTexto)
    tabla.filas[0] = { ...tabla.filas[0], objeto: 'Soporte, "SAP" y más' }
    const vuelta = parsearCsv(serializarCsv(tabla))
    expect(vuelta.columnas).toEqual(tabla.columnas)
    expect(vuelta.filas[0]?.objeto).toBe('Soporte, "SAP" y más')
    expect(vuelta.filas).toHaveLength(8)
  })
})

describe("extracción (HU-2)", () => {
  test("msg-001: todos los campos legibles con confianza alta", async () => {
    const e = await extraer("msg-001")
    expect(e.contrato).toMatchObject({
      id_contrato: "CT-2026-015",
      cliente: "Industrias Delta S.A.S.",
      nit_cliente: "890900111",
      pais: "CO",
      valor: 265_000_000,
      moneda: "COP",
      fecha_inicio: "2026-08-01",
      fecha_fin: "2027-07-31",
      requiere_poliza: true,
      tipo_poliza: "cumplimiento",
    })
    expect(Math.min(...Object.values(e.confianza))).toBeGreaterThanOrEqual(0.8)
  })

  test("msg-002: RUC de 13 dígitos es Ecuador y USD usa coma de miles", async () => {
    const e = await extraer("msg-002")
    expect(e.contrato).toMatchObject({ pais: "EC", nit_cliente: "1790012345001", valor: 120_000, moneda: "USD", requiere_poliza: false })
  })

  test("msg-003: otrosí refiere al contrato original y solo trae lo que modifica", async () => {
    const e = await extraer("msg-003", "otrosi.txt")
    expect(e.contrato).toMatchObject({ es_otrosi: true, numero_otrosi: 1, id_contrato: "CT-2026-011", pais: "PE", valor: 520_000, fecha_fin: "2027-11-01" })
    expect(e.contrato.fecha_inicio).toBeNull()
    expect(e.contrato.objeto).toBeNull()
  })

  test("msg-006: valor por demanda y plazo desde una firma sin día quedan con baja confianza", async () => {
    const e = await extraer("msg-006")
    expect(e.contrato).toMatchObject({ id_contrato: "CM-2026-03", valor: 0, valor_indeterminado: true, fecha_fin: "2027-08-31", requiere_poliza: false })
    expect(e.confianza.valor).toBeLessThan(0.8)
    expect(e.confianza.fecha_fin).toBeLessThan(0.8)
  })

  test("errores legibles (HU-6)", () => {
    expect(() => extraerContrato("  ")).toThrow("texto vacío")
    const base = "CONTRATO No. CT-2026-090\n\nEntre EMPRESA X S.A.S., NIT 800.111.222-3, EL CONTRATANTE\n\nPRIMERA. OBJETO. Prueba.\n\n"
    expect(() => extraerContrato(`${base}SEGUNDA. VALOR. El valor es de MIL EUROS (EUR 1.000).`)).toThrow("moneda desconocida: EUR")
    expect(() => extraerContrato(`${base}TERCERA. PLAZO. Desde el uno (1) de enero de 2027 hasta el treinta (30) de febrero de 2027.`)).toThrow("fecha inválida")
  })
})

describe("clasificación (RN1–RN5)", () => {
  test("los seis mensajes del buzón", async () => {
    const casos: [string, string, string, string[]][] = [
      ["msg-001", "contrato.txt", "nuevo", []],
      ["msg-002", "contrato.txt", "nuevo", []],
      ["msg-003", "otrosi.txt", "actualizacion", []],
      ["msg-004", "contrato.txt", "duplicado", []],
      ["msg-006", "contrato.txt", "nuevo", ["valor", "fecha_fin"]],
    ]
    for (const [id, archivo, clasificacion, revision] of casos) {
      const v = clasificar(await extraer(id, archivo), maestro)
      expect([id, v.clasificacion, v.requiere_revision]).toEqual([id, clasificacion, revision])
    }
    expect(clasificar(null, maestro, "sin adjunto de contrato").clasificacion).toBe("rechazado")
  })

  test("el otrosí cambia valor y fecha_fin y propone póliza pendiente", async () => {
    const v = clasificar(await extraer("msg-003", "otrosi.txt"), maestro)
    expect(v.diferencias).toEqual({
      valor: ["350000", "520000"],
      fecha_fin: ["2027-05-01", "2027-11-01"],
      estado_poliza: ["vigente", "pendiente"],
    })
  })
})

describe("alertas (HU-5)", () => {
  test("con el maestro del fixture y hoy = 2026-09-03", () => {
    const a = calcularAlertas(maestro, "2026-09-03")
    expect(a.vencen.map((c) => c.id_contrato)).toEqual(["CT-2026-009", "CT-2026-004"])
    expect(a.polizas_pendientes.map((c) => c.id_contrato)).toEqual(["CT-2026-004"])
    expect(a.vencidos_sin_cierre.map((c) => c.id_contrato)).toEqual(["CT-2025-018", "CT-2026-002"])
    expect(a.registrados_desde_corte).toHaveLength(0)
  })
})
