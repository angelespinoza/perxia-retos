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

const cabeceras = () => ({ "content-type": "application/json" })

/** Sin sesión iniciada (cookie vencida o ausente) se vuelve a la pantalla de ingreso. */
function revisarIngreso(r) {
  if (r?.status === 401) { location.href = "/login"; return false }
  return true
}

/** Los archivos de cada sesión viven en out/<sessionId>/: «out/x» en el chat apunta a /out/<sessionId>/x. */
function hrefOut(ruta) {
  return sessionId ? `/out/${encodeURIComponent(sessionId)}/${encodeURI(ruta.replace(/^out\//, ""))}` : "#"
}

function actualizarEnlacesFijos() {
  for (const a of document.querySelectorAll("[data-out]")) a.href = hrefOut(a.dataset.out)
}

function escapar(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function enLinea(t) {
  return escapar(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])(out\/[\w./-]+[\w/])/g, (_m, pre, ruta) => `${pre}<a href="${hrefOut(ruta)}" target="_blank" rel="noopener">${ruta}</a>`)
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
  const advertencia = $("confirmacion-advertencia")
  if (!pendiente) {
    banner.hidden = true
    $("confirmacion-texto").textContent = ""
    advertencia.textContent = ""
    advertencia.hidden = true
    return
  }
  $("confirmacion-texto").textContent = pendiente.pregunta ?? `${pendiente.accion} · ${pendiente.referencia}`
  advertencia.textContent = pendiente.advertencia ? `⚠️ ${pendiente.advertencia}` : ""
  advertencia.hidden = !pendiente.advertencia
  banner.hidden = false
}

async function cargarArchivos() {
  if (!sessionId) return
  const r = await fetch(`/api/archivos?sessionId=${encodeURIComponent(sessionId)}`, { headers: cabeceras(), cache: "no-store" }).catch(() => null)
  if (!revisarIngreso(r) || !r?.ok) return
  const { archivos } = await r.json()
  $("archivos").innerHTML = archivos.length
    ? archivos.map((a) => `<li><a href="${hrefOut(a)}" target="_blank" rel="noopener">${escapar(a)}</a></li>`).join("")
    : "<li class=\"sub\">Aún no hay archivos.</li>"
}

/** Refresca el panel ahora y otra vez un momento después, por si el último archivo tardó en quedar visible. */
function actualizarArchivos() {
  actualizarEnlacesFijos()
  cargarArchivos()
  setTimeout(cargarArchivos, 1500)
}

async function enviar(mensaje) {
  if (!mensaje.trim()) return
  agregarMensaje("usuario", mensaje)
  mostrarConfirmacion(null)
  botonEnviar.disabled = true
  const pensando = document.createElement("div")
  pensando.className = "pensando"
  pensando.textContent = "Pensando"
  mensajes.appendChild(pensando)
  mensajes.scrollTop = mensajes.scrollHeight
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: cabeceras(), body: JSON.stringify({ sessionId: sessionId ?? undefined, message: mensaje }) })
    if (!revisarIngreso(r)) return
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
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { headers: cabeceras(), cache: "no-store" }).catch(() => null)
  if (!revisarIngreso(r)) return
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

fetch("/api/me", { cache: "no-store" }).then((r) => (revisarIngreso(r) && r.ok ? r.json() : null)).then((d) => {
  if (!d?.usuario) return
  $("usuario").textContent = d.usuario
  $("usuario").hidden = false
}).catch(() => {})

restaurarSesion()
actualizarArchivos()
