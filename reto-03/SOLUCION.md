# SOLUCIÓN — Reto 03: Agente "Órdenes de Compra SAP"

## 1. Problema en una frase

La analista administrativa digita a mano en SAP cada orden de compra (proveedor, centro de costo, valor, IVA, aprobador, condiciones de pago) y valida de memoria que quien aprueba puede aprobar ese monto; le duele a ella (retrabajo y errores que se corrigen en el cierre contable), a contabilidad (controles no sistemáticos) y a la dirección (no sabe cuántas OC son retroactivas).

## 2. Arquitectura

```
┌──────────────┐  HTTP   ┌──────────── Backend Hono (Vercel Functions) ─────────────┐
│ web/  chat   │ ──────▶ │ src/server.ts    /api/chat · /api/sessions · /api/health  │
│ - historial  │ ◀────── │ src/core/loop.ts ciclo: modelo ↔ herramientas, topes      │
│ - tool calls │         │ src/core/confirm.ts  puerta de confirmación                │
│ - confirmar  │         │ src/llm/*        LlmAdapter: Anthropic · OpenAI · Gemini   │
└──────────────┘         │ src/core/registry.ts + src/tools/oc.ts (zod)              │
                         │   ├─ src/domain/  paquete · reglas RC1–RC10 · orden · control │
                         │   └─ src/sap/     SapAdapter → MockSap                     │
                         └───────────────┬──────────────────────┬───────────────────┘
                                         │                      │
                              fixtures/ (solo lectura)   Storage: out/ en disco (local)
                                                         o Vercel Blob privado (producción)
```

| Capa | Dónde vive | Qué contiene |
| --- | --- | --- |
| Comportamiento | `agent/prompt.md` | Orden de pasos, cuándo pedir confirmación, formato de respuesta, reglas que no se rompen. |
| Conocimiento | `src/knowledge/ordenes-compra.md` | Actores, pasos, matriz RC1–RC10, acciones por bloqueo, reglas del payload y del control. |
| Ejecución | `src/tools/oc.ts` → `src/domain/`, `src/sap/` | Herramientas tipadas con zod, reglas como funciones puras y el adaptador SAP. |

El núcleo (`src/core/`, `src/llm/`, `src/server.ts`, `web/`) es el mismo del Reto 01 y no sabe nada de órdenes de compra. Un cambio de reglas toca `src/domain/reglas.ts` y `src/knowledge/`, nunca el servidor.

## 3. Ciclo del agente

1. `POST /api/chat` carga la sesión desde el `Storage` (`sessions/<id>.json`), porque en Vercel cada request puede caer en otra instancia.
2. Si la sesión tenía una confirmación pendiente y el mensaje es afirmativo («confirmo», «sí», «créala»), esa confirmación vale **solo para este turno**. Cualquier otro mensaje la descarta.
3. El ciclo llama al modelo con el historial y las herramientas. El registro valida los argumentos con zod (un error vuelve al modelo como resultado), ejecuta la herramienta dentro de `safe()` (nunca lanza) y registra la llamada en `out/log.jsonl` y `out/<caso>/log.jsonl` (CA4).
4. **Orden obligatorio** leer → validar → generar_evidencia → construir_payload → crear, porque el payload lleva el sha256 de la evidencia. Cada herramienta revisa el estado del caso (`out/<caso>/estado.json`) y, si se la llama antes de tiempo, responde qué paso falta.
5. **Confirmación humana (CA3):** con confirmaciones pendientes, `oc_crear` sin `confirmado: true` no crea (deja una fila `pendiente` en el control). El modelo pide confirmación con la pseudo-herramienta `agente_solicitar_confirmacion`; el ciclo termina el turno con `needsConfirmation: true` y el front muestra un banner con Confirmar / Cancelar. Un `confirmado: true` sin un «sí» de la analista para ese caso en el turno anterior se rechaza en el registro, aunque el modelo se equivoque.
6. **Topes (CA1):** `MAX_ITERACIONES` (25) por turno, `MAX_TOKENS_SESION` por sesión, `LLM_TIMEOUT_MS` por llamada y 270 s por turno (la función de Vercel tiene 300 s). Al llegar a un tope, el agente responde con lo hecho y lo que falta.
7. **Errores (CA5):** un error del proveedor del modelo se traduce a un mensaje claro en el chat; la sesión sigue viva.

## 4. Elección del modelo

El agente es **agnóstico de proveedor**: `LLM_PROVIDER` elige Anthropic, OpenAI o Gemini y `LLM_MODEL` el modelo. Los tres adaptadores implementan `enviar(mensajes, herramientas)`; `tests/llm-contrato.test.ts` verifica que traducen el mismo historial sin perder llamadas ni resultados.

- **En el despliegue:** OpenAI `gpt-5.5`. Siguió el orden de pasos, mostró los dos valores de RC5, cerró con la pregunta y, en el caso bloqueado, no intentó rodear el bloqueo.
- **Por defecto en código:** Anthropic `claude-opus-5-5` con esfuerzo `medium`.
- **Por qué alcanza un modelo que solo orquesta:** toda la lógica (parsers, RC1–RC10, payload, hash, numeración) es determinista y vive en las herramientas.

**Medición real** con `gpt-5.5` del prompt de la sección 11: el primer turno (5 herramientas y la tabla de la OC) consumió 22 276 tokens de entrada y 1 324 de salida; el turno «confirmo», 10 096 y 217. Un caso completo con confirmación ronda **32 000 tokens de entrada y 1 500 de salida**; un caso sin confirmación (sol-001) usa uno de esos dos turnos. El costo en dólares es `entrada × tarifa_entrada + salida × tarifa_salida` con la tarifa vigente del modelo; con las tarifas usadas en el Reto 01 para Claude Opus 5.5 ($4 y $20 por millón) serían unos **US$0,16 por caso**, menos con caché del prefijo. El campo `uso` de `/api/chat` da el consumo de cada sesión.

## 5. Matriz de controles

Cada regla es una función pura en `src/domain/reglas.ts` (`rc1` … `rc10`) con al menos una prueba en `tests/dominio.test.ts`. `oc_validar` recalcula siempre desde los fixtures y nunca usa el paquete que manda el modelo.

| Regla | Tipo | Implementación |
| --- | --- | --- |
| RC1 | Bloqueo | Por NIT; sin NIT, por nombre normalizado (sin tildes, puntuación ni «S.A.S.», «S.A.», «Ltda.»). Debe estar `activo`. Al crear, se vuelve a consultar con `SapAdapter.consultarProveedor`. Acción: alta o reactivación del proveedor. |
| RC2 | Bloqueo | Hay aprobación, contiene «aprobado/aprobada» sin negación previa («no aprobado») y el remitente está en `aprobadores` del centro. Acción: a quién pedir la aprobación, o escalar si ningún tope alcanza. |
| RC3 | Bloqueo | `valor_total ≤ tope` del aprobador en ese centro (solo si RC2 identificó al aprobador). |
| RC4 | Bloqueo | El centro existe y la subárea le pertenece (comparación sin tildes ni mayúsculas). |
| RC5 | Confirmación | `abs(cotización − solicitud) / solicitud > 2 %`, o no hay cotización. Devuelve ambos valores y el porcentaje. |
| RC6 | Confirmación + derivado | Sin IVA: `indicador_iva_default` del proveedor. Un código informado que no existe en el maestro bloquea. |
| RC7 | Derivado | Sin condiciones de pago: `condiciones_pago_default` del proveedor. Un código inexistente bloquea. |
| RC8 | Confirmación | Factura con fecha anterior a la solicitud: `retroactiva = true`, también en las filas `pendiente` del control. |
| RC9 | Confirmación | Fecha de aprobación anterior a la solicitud, con la fecha convertida a America/Bogota. |
| RC10 | Bloqueo | `abs(cantidad × valor_unitario − valor_total) > 1`. |

**La más difícil fue RC2**, por tres motivos: decidir qué cuenta como aprobación en texto libre (sol-004 dice «Aprobado por 25 millones», que no es lo mismo que aprobar 25 millones de la cotización), separar «no es aprobador» de «no le alcanza el tope» para no reportar dos veces el mismo problema, y dar una acción útil: en sol-003 no basta decir «pedir a rtorres», porque su tope de 30M no cubre 74M y hay que escalar.

## 6. Diseño del adaptador SAP real

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV`** (S/4HANA) detrás de `SapAdapter`, con **carga por archivo como plan B**. OData es la API estándar y liberada para crear OC, funciona por HTTPS sin librerías nativas (el backend es TypeScript) y su contrato es estable entre versiones. `BAPI_PO_CREATE1` por RFC exige el conector nativo (node-rfc / SAP NW RFC SDK) y acceso de red al servidor de aplicación, lo más difícil de obtener con una viabilidad no confirmada. Integration Suite es la opción correcta si la empresa ya la tiene; si no, añade licencia y otro equipo al camino crítico.

**Mapeo del payload (7.4 → OData)**

| Payload | `A_PurchaseOrder` / `A_PurchaseOrderItem` |
| --- | --- |
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` desde configuración) |
| `proveedor.codigo_sap` | `Supplier` |
| `moneda` | `DocumentCurrency` |
| `condiciones_pago` | `PaymentTerms` |
| `referencia.solicitud_id` | `CorrespncExternalReference` (referencia externa, base de la idempotencia) |
| `posiciones[].numero` | `PurchaseOrderItem` |
| `descripcion` | `PurchaseOrderItemText` (40 caracteres) |
| `cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` (UN → EA, H → H, MES → MON, según la tabla de unidades del cliente) |
| `precio_unitario` | `NetPriceAmount` |
| `indicador_iva` | `TaxCode` |
| `centro_costo` | `to_AccountAssignment.CostCenter` con `AccountAssignmentCategory = K` |
| `subarea` | Campo de imputación acordado con contabilidad (por ejemplo, orden interna o un campo Z) |
| `aprobador`, `excepciones` | Texto de cabecera (`to_PurchaseOrderNote`) |
| Evidencia PDF | Adjunto con `API_CV_ATTACHMENT_SRV` (`LinkedSAPObjectKey` = número de OC) |

**Autenticación y credenciales.** Un usuario técnico de comunicación (Communication Arrangement) con rol limitado a crear y leer OC, autenticado con OAuth 2.0 client credentials o certificado X.509. Las credenciales viven en el gestor de secretos del backend (variables cifradas de Vercel o un vault), nunca en el agente, el prompt, el front ni los logs. El modelo no ve ni elige endpoints: solo llama `oc_crear`.

**Idempotencia y errores parciales.** Antes de crear, `buscarOrdenPorReferencia` filtra por `CorrespncExternalReference = solicitud_id`; si existe, se devuelve ese número (igual que el mock). Ante un timeout no se reintenta a ciegas: se vuelve a buscar por referencia y solo si no aparece se reintenta, con backoff y tope. Si SAP crea la OC pero falla un paso posterior (adjunto o nota), la OC queda creada, el control registra `creada_parcial` con el paso pendiente y un reintento solo repite ese paso. Los errores de negocio (proveedor bloqueado, centro de costo cerrado) se traducen a lenguaje claro y no se reintentan.

**Plan B si la conexión no es viable.** El agente hace todo hasta `oc_construir_payload` y, en vez de crear, genera (1) la OC en una tabla lista para digitar en ME21N, en el orden de los campos de la transacción, y (2) un archivo de carga masiva (CSV para LSMW o el Migration Cockpit) que acumula las OC aprobadas del día. La analista hace una carga por lote; luego registra el número de OC en el agente, que completa el control. Se pierde la creación automática pero se conservan las validaciones, la evidencia, la trazabilidad y la medición de retroactivas, que es la mayor parte del tiempo ahorrado.

## 7. Lectura del proceso: OC retroactivas

Una OC retroactiva significa que la compra se comprometió antes de que existiera el control: el proveedor ya entregó y facturó cuando la solicitud llegó a compras. En ese punto la OC deja de ser un control previo y se vuelve un trámite para poder pagar la factura. La aprobación del líder se vuelve una formalidad («ya llegó la factura, por favor crear la OC», dice el correo de sol-005) y la comparación de cotizaciones no ocurre.

A la dirección le diría tres cosas. Primero, que ahora se puede medir: `control.csv` marca `retroactiva = true` en cada intento, también en los que quedan pendientes, y con un mes de datos se sabe el porcentaje real por centro de costo y por proveedor. Segundo, que el número importa menos que su concentración: si la mayoría viene de pocos centros o de compras recurrentes (papelería, licencias, servicios mensuales), el problema no es disciplina sino que el proceso es lento para compras pequeñas y repetitivas. Tercero, que la decisión de tolerarlas o rechazarlas es de la dirección; el agente las deja pasar solo con confirmación explícita y deja constancia.

Cambio de proceso que propondría: **OC abiertas (contratos marco o pedidos abiertos) para compras recurrentes**, con monto anual aprobado una vez y consumos contra ese pedido; **regla de «sin OC no se recibe factura»** comunicada a proveedores para el resto, con la OC creada por el agente en minutos y no en días; y un **reporte mensual de retroactivas por centro** para el comité, que convierte el desvío en un indicador con responsable.

## 8. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
| --- | --- | --- |
| Reglas RC1–RC10 como funciones puras y deterministas | Pedirle al modelo que evalúe las reglas | Un modelo podría «arreglar» un monto o aceptar un aprobador parecido (riesgo del PRD). Las funciones son testeables una a una y la demo corre sin clave. |
| `oc_validar`, `oc_construir_payload` y `oc_crear` releen todo desde los fixtures; el paquete y los derivados que envía el modelo se ignoran | Confiar en los argumentos del modelo | CA2 por diseño: el modelo no puede alterar un valor entre validar y crear. |
| `oc_crear` exige que el payload (si se envía) tenga el mismo hash canónico que el guardado | Crear con lo que mande el modelo | Si el modelo cambia un campo, la OC no se crea. El hash es sobre JSON con claves ordenadas, para que reordenar claves no lo rompa. |
| La OC se crea con los precios de la solicitud, no de la cotización | Usar la cotización cuando difiere | La solicitud es lo que el líder aprobó («Aprobado por 25 millones según la solicitud»); la diferencia queda como excepción confirmada. |
| Idempotencia en dos capas: `oc_crear` busca por `solicitud_id` antes de todo, y el mock vuelve a verificar al escribir | Solo en la herramienta | Si mañana otro cliente llama al adaptador directamente, sigue sin duplicar OC; es lo mismo que haría el adaptador real con la referencia externa. |
| Núcleo copiado del Reto 01 sin cambios de comportamiento | Reescribirlo para este reto | Los tres retos comparten ciclo, confirmación, storage y adaptadores; una sola implementación probada reduce riesgo. |

## 9. Supuestos

- La OC se crea con los precios de la solicitud y la diferencia con la cotización queda como excepción confirmada.
- El SAP simulado lee los proveedores del mismo maestro de fixtures; en producción se consultaría SAP en tiempo real.
- «Aprobado» se busca sin distinguir tildes ni mayúsculas, como palabra completa (también «aprobada»), y se descarta si va precedido de «no», «sin» o «rechazado».
- Si RC2 falla, RC3 no se evalúa: no tiene sentido medir el tope de quien no es aprobador.
- Un código de IVA o de condición de pago informado que no existe en el maestro se trata como bloqueo, aunque el PRD solo describe el caso ausente.
- La unidad se deriva de la descripción («horas» → H, «mensual» → MES, resto → UN). «Vigencia 12 meses» (sol-001) se deja en UN porque se compran licencias, no meses.
- Cada intento de `oc_crear` agrega una fila al control, incluidos los `pendiente` (falta confirmación) y los `idempotente`.
- La confirmación se reconoce por palabras clave en español; un mensaje ambiguo no cuenta.

## 10. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
| --- | --- | --- | --- |
| HU-1 Leer el paquete | Hecho | `oc_leer_paquete`; adjuntos ausentes en `null` y `faltantes` | Leer el correo real y los adjuntos binarios (`.xlsx`, PDF). `oc_leer_excel` (P1) no se implementó. |
| HU-2 Validar | Hecho | RC1–RC10 con prueba cada una; acción sugerida por bloqueo | Maestros consultados en SAP en tiempo real. |
| HU-3 Payload | Hecho | Esquema zod de 7.4; `trazabilidad.json` por campo | Mapeo de unidades y de subárea acordado con contabilidad. |
| HU-4 Evidencia | Hecho (P0 txt, P1 pdf) | `aprobacion.txt` y `aprobacion.pdf` con sha256 | Exportar el `.eml` original; firma digital si auditoría la exige. |
| HU-5 Crear OC | Hecho | Numeración desde 4500000001, idempotencia, puerta de confirmación, `control.csv` | Adaptador OData real (sección 6). |
| HU-6 Errores | Hecho | Caso inexistente, pasos fuera de orden, JSON malformado, monto no numérico, adjuntos ausentes en `demo.ts` | Alertas operativas ante errores repetidos. |
| Despliegue (link) | Hecho | https://perxia-reto-03-xi.vercel.app con OpenAI `gpt-5.5` y Vercel Blob privado; prompt de la sección 11 probado en producción | Dominio propio y monitoreo. |
| Bonus `modulo/` | Hecho | Generado desde las mismas fuentes; `bun run build:modulo --check` en CI | — |

## 11. Uso de IA

- **Claude Code con Claude Opus 5.5:** SDD por etapas, copia y adaptación del núcleo del Reto 01, parsers, reglas RC1–RC10, payload y trazabilidad, SAP simulado, herramientas, prompt y conocimiento, pruebas, `demo.ts` y esta documentación. Todo se revisó y se probó con `demo.ts` (dos veces seguidas, mismo resultado), `bun test`, TypeScript estricto y el chat real con `gpt-5.5`.
- **Propuestas descartadas:** dejar que el modelo arme el payload (podría alterar montos); crear la OC con los valores de la cotización cuando difiere (contradice la aprobación); derivar la unidad MES de cualquier mención de «meses» (habría marcado mal las licencias de sol-001); exigir que el modelo reenvíe el payload completo a `oc_crear` (frágil: basta un campo reformateado para fallar; se dejó opcional y verificado por hash).

## 12. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
| --- | --- |
| El modelo «arregla» un monto para que cuadre con la cotización | Los montos salen de la solicitud en la herramienta; el payload enviado se compara por hash y se rechaza si cambia. |
| Aprobaciones en texto libre ambiguas («aprobado pero revisar el valor») | RC2 solo acepta «aprobado» sin negación; en producción, aprobación en un flujo con botón o firma y no en texto libre. |
| La conexión a SAP no es viable a corto plazo | Plan B de la sección 6: OC lista para ME21N y archivo de carga masiva. |
| Doble creación por reintentos o concurrencia | Idempotencia por referencia externa en SAP, búsqueda antes de reintentar y bloqueo por `solicitud_id` en el backend. |
| Concurrencia en Vercel Blob: añadir una línea es leer y reescribir el archivo | Aceptable para una analista; en producción, control y órdenes en una base de datos con escritura atómica. |
| Maestros desactualizados (aprobador que cambió de rol, tope nuevo) | Consultar SAP o RR. HH. en tiempo real; dueño del dato por maestro. |
| Gasto descontrolado de la clave del modelo | Topes de iteraciones, tokens por sesión y tiempo por turno; `ACCESS_KEY` para el link público. |
