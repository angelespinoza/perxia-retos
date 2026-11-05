// Política de confirmación del reto-02: el registro de un mensaje con campos en revisión.
import { crearSolicitarConfirmacion, type PoliticaConfirmacion } from "./core/confirm.ts"
import { aCsv, clasificar } from "./domain/clasificacion.ts"
import { analizar, leerMaestro, leerProcesados } from "./domain/estado.ts"
import type { Campo } from "./domain/extraccion.ts"
import { listarMensajes } from "./domain/fixtures.ts"

export const politicaConfirmacion: PoliticaConfirmacion = {
  // Procesar el buzón ya pide registrar; el agente propone el registro de lo dudoso sin que haga falta otro pedido.
  async describir(p, ctx) {
    if (p.accion !== "registrar") return { error: `acción desconocida: ${p.accion}. La única acción con confirmación es 'registrar'` }
    if (!(await listarMensajes(ctx.directory)).includes(p.referencia)) return { error: `mensaje inexistente: ${p.referencia}` }
    const previo = (await leerProcesados(ctx))[p.referencia]
    if (previo) return { error: `el mensaje ${p.referencia} ya fue procesado (${previo.accion})` }
    const maestro = (await leerMaestro(ctx)).filas
    const a = await analizar(ctx, p.referencia, maestro)
    const v = clasificar(a.extraccion, maestro, a.motivo)
    const cliente = a.extraccion?.contrato.cliente ?? "cliente sin identificar"
    const destino = `${v.id_contrato || "sin número"} · ${cliente}`
    if (v.requiere_revision.length === 0)
      return { pregunta: `¿Confirmas el registro de ${p.referencia} (${destino}) como «${v.clasificacion}» en el maestro?` }
    const campos = v.requiere_revision
      .map((c) => {
        const propuesto = a.extraccion ? aCsv(c as Campo, a.extraccion.contrato[c as Campo]) : ""
        return `${c} = ${propuesto === "" ? "(vacío)" : propuesto} (${v.motivos_revision[c] ?? "revisar"})`
      })
      .join("; ")
    return {
      pregunta: `¿Confirmas el registro de ${p.referencia} (${destino}) en el maestro con los campos en revisión? Puedes indicar los valores al confirmar (por ejemplo «confirmo el valor 0 y la fecha fin 2027-08-31»); el botón Confirmar acepta los propuestos.`,
      advertencia: `${p.referencia} tiene campos dudosos que quedarán registrados como confirmados por ti: ${campos}.`,
    }
  },
}

/** Pseudo-herramienta agente_solicitar_confirmacion con la política de este reto. */
export const solicitar_confirmacion = crearSolicitarConfirmacion(politicaConfirmacion, "registrar", "msg-006")
