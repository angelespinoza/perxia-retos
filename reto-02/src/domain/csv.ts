// CSV del maestro: lectura y escritura RFC 4180 sin perder columnas ni su orden.

export interface Tabla {
  columnas: string[]
  filas: Record<string, string>[]
}

function parsearLineas(texto: string): string[][] {
  const registros: string[][] = []
  let registro: string[] = []
  let campo = ""
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"'
        i++
      } else if (c === '"') comillas = false
      else campo += c
    } else if (c === '"') comillas = true
    else if (c === ",") {
      registro.push(campo)
      campo = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++
      registro.push(campo)
      registros.push(registro)
      registro = []
      campo = ""
    } else campo += c
  }
  if (campo !== "" || registro.length > 0) {
    registro.push(campo)
    registros.push(registro)
  }
  return registros.filter((r) => r.some((v) => v !== ""))
}

export function parsearCsv(texto: string): Tabla {
  const [cabecera, ...resto] = parsearLineas(texto.replace(/^﻿/, ""))
  if (!cabecera) throw new Error("CSV vacío")
  const filas = resto.map((valores) => Object.fromEntries(cabecera.map((col, i) => [col, valores[i] ?? ""])))
  return { columnas: cabecera, filas }
}

function escaparCampo(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export function serializarCsv(tabla: Tabla): string {
  const lineas = [tabla.columnas, ...tabla.filas.map((f) => tabla.columnas.map((c) => f[c] ?? ""))]
  return `${lineas.map((l) => l.map(escaparCampo).join(",")).join("\n")}\n`
}
