// Front del chat: historial, tarjetas de llamadas a herramientas y estado de confirmación.
const $ = (id) => document.getElementById(id)
const mensajes = $("mensajes")
const texto = $("texto")
const botonEnviar = $("enviar")
const banner = $("confirmacion")

const almacen = {
  leer(clave) {
    try { return localStorage.getItem(clave) } catch { return null }
  },
  guardar(clave, valor) {
    try { valor === null ? localStorage.removeItem(clave) : localStorage.setItem(clave, valor) } catch { /* sin almacenamiento */ }
  },
}

let sessionId = almacen.leer("sessionId")

function cabeceras() {
  const h = { "content-type": "application/json" }
  const clave = almacen.leer("accessKey")
  if (clave) h["x-access-key"] = clave
  return h
}

function escapar(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function enLinea(t) {
  return escapar(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])(out\/[\w./-]+[\w/])/g, (_m, pre, ruta) => `${pre}<a href="/${ruta}" target="_blank" rel="noopener">${ruta}</a>`)
}

// Markdown mínimo: párrafos, listas, tablas y énfasis. Todo el texto se escapa antes de dar formato.
function markdown(fuente) {
  const lineas = fuente.replace(/\r/g, "").split("\n")
  const html = []
  let i = 0
  while (i < lineas.length) {
    const linea = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(linea) && /^\s*\|[\s:|-]+\|\s*$/.test(lineas[i + 1] ?? "")) {
      const celdas = (l) => l.trim().slice(1, -1).split("|").map((c) => enLinea(c.trim()))
      const cabecera = celdas(linea)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      html.push(`<table><thead><tr>${cabecera.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(linea)) {
      const ordenada = /^\s*\d+\./.test(linea)
      const items = []
      while (i < lineas.length && /^\s*([-*]|\d+\.)\s+/.test(lineas[i])) items.push(enLinea(lineas[i++].replace(/^\s*([-*]|\d+\.)\s+/, "")))
      html.push(`<${ordenada ? "ol" : "ul"}>${items.map((t) => `<li>${t}</li>`).join("")}</${ordenada ? "ol" : "ul"}>`)
      continue
    }
    if (/^#{1,4}\s+/.test(linea)) {
      html.push(`<p><strong>${enLinea(linea.replace(/^#{1,4}\s+/, ""))}</strong></p>`)
      i++
      continue
    }
    if (linea.trim() === "") { i++; continue }
    const parrafo = []
    while (i < lineas.length && lineas[i].trim() !== "" && !/^\s*([-*]|\d+\.)\s+|^\s*\||^#{1,4}\s/.test(lineas[i])) parrafo.push(enLinea(lineas[i++]))
    html.push(`<p>${parrafo.join("<br>")}</p>`)
  }
  return html.join("")
}

function agregarMensaje(tipo, contenido, { confirmacion = false } = {}) {
  mensajes.querySelector(".bienvenida")?.remove()
  const div = document.createElement("div")
  div.className = `msg ${tipo}${confirmacion ? " pide-confirmacion" : ""}`
  if (tipo === "usuario") div.textContent = contenido
  else div.innerHTML = markdown(contenido)
  mensajes.appendChild(div)
  mensajes.scrollTop = mensajes.scrollHeight
}

function agregarHerramientas(llamadas) {
  if (!llamadas.length) return
  const grupo = document.createElement("div")
  grupo.className = "herramientas"
  for (const l of llamadas) {
    const d = document.createElement("details")
    d.className = "tool"
    d.innerHTML = `<summary><span class="estado ${l.ok ? "ok" : "fallo"}">${l.ok ? "✓" : "✗"}</span><span class="nombre">${escapar(l.herramienta)}</span><span class="resumen">${escapar(l.resumen)}</span></summary><pre>${escapar(JSON.stringify(l.args, null, 2))}\n\n→ ${escapar(l.resumen)}${l.ms !== undefined ? ` (${l.ms} ms)` : ""}</pre>`
    grupo.appendChild(d)
  }
  mensajes.appendChild(grupo)
  mensajes.scrollTop = mensajes.scrollHeight
}

function mostrarConfirmacion(pendiente) {
  if (!pendiente) { banner.hidden = true; return }
  $("confirmacion-texto").textContent = `${pendiente.accion} · ${pendiente.referencia}${pendiente.resumen ? ` — ${pendiente.resumen}` : ""}`
  banner.hidden = false
}

async function actualizarArchivos() {
  const r = await fetch("/api/archivos", { headers: cabeceras() }).catch(() => null)
  if (!r?.ok) return
  const { archivos } = await r.json()
  $("archivos").innerHTML = archivos.length
    ? archivos.map((a) => `<li><a href="/out/${encodeURI(a)}" target="_blank" rel="noopener">${escapar(a)}</a></li>`).join("")
    : "<li class=\"sub\">Aún no hay archivos.</li>"
}

async function enviar(mensaje) {
  if (!mensaje.trim()) return
  agregarMensaje("usuario", mensaje)
  banner.hidden = true
  botonEnviar.disabled = true
  const pensando = document.createElement("div")
  pensando.className = "pensando"
  pensando.textContent = "Pensando"
  mensajes.appendChild(pensando)
  mensajes.scrollTop = mensajes.scrollHeight
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: cabeceras(), body: JSON.stringify({ sessionId: sessionId ?? undefined, message: mensaje }) })
    if (r.status === 401) {
      const clave = prompt("Este agente está protegido. Ingresa la clave de acceso:")
      if (clave) { almacen.guardar("accessKey", clave); pensando.remove(); botonEnviar.disabled = false; return enviar(mensaje) }
      throw new Error("Falta la clave de acceso.")
    }
    const datos = await r.json()
    if (!r.ok) throw new Error(datos.error ?? "Error del servidor.")
    sessionId = datos.sessionId
    almacen.guardar("sessionId", sessionId)
    pensando.remove()
    agregarHerramientas(datos.toolCalls ?? [])
    agregarMensaje(datos.error ? "error" : "asistente", datos.reply, { confirmacion: datos.needsConfirmation })
    mostrarConfirmacion(datos.needsConfirmation ? datos.pendiente : null)
    actualizarArchivos()
  } catch (e) {
    pensando.remove()
    agregarMensaje("error", `No se pudo completar la solicitud: ${e.message}. La sesión sigue activa.`)
  } finally {
    botonEnviar.disabled = false
    texto.focus()
  }
}

async function restaurarSesion() {
  if (!sessionId) return
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { headers: cabeceras() }).catch(() => null)
  if (!r?.ok) { sessionId = null; almacen.guardar("sessionId", null); return }
  const { eventos, pendiente } = await r.json()
  let lote = []
  for (const e of eventos) {
    if (e.tipo === "herramienta") { lote.push(e); continue }
    if (lote.length) { agregarHerramientas(lote); lote = [] }
    if (e.tipo === "usuario") agregarMensaje("usuario", e.texto ?? "")
    else agregarMensaje(e.tipo === "error" ? "error" : "asistente", e.texto ?? "", { confirmacion: e.needsConfirmation })
  }
  if (lote.length) agregarHerramientas(lote)
  mostrarConfirmacion(pendiente)
  actualizarArchivos()
}

$("formulario").addEventListener("submit", (ev) => {
  ev.preventDefault()
  const valor = texto.value
  texto.value = ""
  enviar(valor)
})
texto.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); $("formulario").requestSubmit() }
})
mensajes.addEventListener("click", (ev) => {
  const boton = ev.target.closest("[data-texto]")
  if (boton) enviar(boton.dataset.texto)
})
$("confirmar").addEventListener("click", () => enviar("Sí, confirmo los valores propuestos."))
$("cancelar").addEventListener("click", () => enviar("No, cancela esa acción."))
$("nueva").addEventListener("click", () => { almacen.guardar("sessionId", null); location.reload() })

fetch("/api/health").then((r) => r.json()).then((s) => {
  $("modelo").textContent = s.configurado ? `${s.provider} · ${s.model}` : `${s.provider} · sin configurar`
}).catch(() => { $("modelo").textContent = "sin conexión" })

restaurarSesion()
actualizarArchivos()
