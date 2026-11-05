// Política de confirmación del reto-01: cuándo se puede dejar pendiente el envío y cómo se pregunta.
import { crearSolicitarConfirmacion, type PoliticaConfirmacion } from "./core/confirm.ts"
import { leerEstado, pendientesDelPaquete } from "./domain/estado.ts"
import { ErrorFixture, leerSolicitud, validarCaso } from "./domain/fixtures.ts"

/** «envía», «enviar», «mándalo»…: el agente solo deja el envío pendiente si la analista lo pidió. */
const PIDE_ENVIO = /\b(envia|envialo|enviala|envialos|enviar|enviarlo|enviarla|enviemos|manda|mandalo|mandala|mandar)\b/

export const politicaConfirmacion: PoliticaConfirmacion = {
  requierePedido: { simular_envio: PIDE_ENVIO },
  async describir(p, ctx) {
    if (p.accion !== "simular_envio") return { error: `acción desconocida: ${p.accion}. La única acción con confirmación es 'simular_envio'` }
    try {
      await validarCaso(ctx.directory, p.referencia)
    } catch (e) {
      if (e instanceof ErrorFixture) return { error: e.message }
      throw e
    }
    const estado = await leerEstado(ctx.storage, p.referencia)
    if (estado.listo_para_firma === undefined) return { error: "primero arma el paquete con proveedor_armar_paquete" }
    const solicitud = await leerSolicitud(ctx.directory, p.referencia)
    const pregunta = `¿Confirmas el envío simulado del paquete de ${solicitud.cliente} (${p.referencia}) a ${solicitud.de}? Solo se escribirá out/${p.referencia}/ENVIO-SIMULADO.md; no se envía ningún correo real.`
    if (estado.listo_para_firma) return { pregunta }
    const pendientes = pendientesDelPaquete(estado.soportes ?? [], estado.formulario !== undefined)
    return {
      pregunta,
      advertencia: `el paquete NO está listo para firma (${pendientes.join("; ")}). Si confirmas, quedará constancia de un envío con pendientes.`,
    }
  },
}

/** Pseudo-herramienta agente_solicitar_confirmacion con la política de este reto. */
export const solicitar_confirmacion = crearSolicitarConfirmacion(politicaConfirmacion, "simular_envio", "ec-corp-andina")
