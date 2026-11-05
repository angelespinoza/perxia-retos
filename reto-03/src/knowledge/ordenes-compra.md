# Conocimiento del proceso: órdenes de compra en SAP

## Contexto

Cada compra llega a administración por correo con tres piezas: el Excel de solicitud, la cotización del proveedor y el correo de aprobación del líder. La analista crea la OC en SAP y adjunta el correo de aprobación como evidencia. Muchas OC se crean después de que llega la factura (OC retroactivas); la dirección quiere medir ese desvío.

## Actores

| Actor | Papel |
| --- | --- |
| Solicitante | Envía el paquete por correo. No usa el agente. |
| Líder aprobador | Responde «Aprobado». Debe estar listado como aprobador del centro de costo, con tope suficiente. |
| Analista administrativa | Conversa con el agente y confirma excepciones. |
| Contabilidad / Auditoría | Consume `out/control.csv`. |
| SAP | Simulado: `out/sap/ordenes.jsonl`, números desde 4500000001. |

## Pasos y herramientas

| Paso | Herramienta | Resultado |
| --- | --- | --- |
| 1 | `oc_leer_paquete` | Correo, solicitud, cotización, aprobación y factura normalizados; adjuntos ausentes en `faltantes`. |
| 2 | `oc_validar` | `apta`, `bloqueos`, `confirmaciones`, `derivados`, `retroactiva`. |
| 3 | `oc_generar_evidencia` | `aprobacion.txt` y `aprobacion.pdf` con sha256. |
| 4 | `oc_construir_payload` | OC validada con zod + `trazabilidad.json`. |
| 5 | `oc_crear` | Número de OC; idempotente por `solicitud_id`. |

El orden es obligatorio: el payload lleva el sha256 de la evidencia. Si se llama un paso antes de tiempo, la herramienta responde qué falta.

## Matriz de controles

| Regla | Tipo | Qué verifica |
| --- | --- | --- |
| RC1 | Bloqueo | El proveedor existe en el maestro (por NIT; sin NIT, por nombre normalizado sin tildes ni «S.A.S.», «S.A.», «Ltda.») y está activo. |
| RC2 | Bloqueo | Hay correo de aprobación, dice «Aprobado» (sin negación) y el remitente es aprobador del centro de costo. |
| RC3 | Bloqueo | `valor_total` ≤ tope del aprobador en ese centro. |
| RC4 | Bloqueo | El centro de costo existe y la subárea le pertenece. |
| RC5 | Confirmación | La cotización difiere más de 2 % de la solicitud, o no hay cotización. Se muestran ambos valores. |
| RC6 | Confirmación + derivado | Sin indicador de IVA: se toma `indicador_iva_default` del proveedor y se confirma. |
| RC7 | Derivado | Sin condiciones de pago: se toman `condiciones_pago_default` del proveedor. Solo se informa. |
| RC8 | Confirmación | Factura con fecha anterior a la solicitud: `retroactiva = true`, se registra en control. |
| RC9 | Confirmación | Aprobación con fecha (hora de Bogotá) anterior a la solicitud. |
| RC10 | Bloqueo | `cantidad × valor_unitario` = `valor_total` (± 1). |

Un código de IVA o de condición de pago informado que no existe en el maestro también bloquea.

## Qué hacer con cada bloqueo

| Regla | Acción sugerida |
| --- | --- |
| RC1 | Alta o reactivación del proveedor en datos maestros. |
| RC2 / RC3 | Pedir la aprobación a un aprobador del centro con tope suficiente; si ninguno alcanza, escalar. |
| RC4 | Pedir al solicitante un centro de costo o subárea válidos. |
| RC10 | Pedir al solicitante corregir cantidad, valor unitario o total. |

## Payload de la OC

- `sociedad` y `organizacion_compras` fijos en «1000». Una posición (10) por solicitud.
- Precios y cantidades salen de la **solicitud**, no de la cotización. Una diferencia con la cotización queda como excepción confirmada.
- Descripción truncada a 40 caracteres en límite de palabra; el texto completo queda en la trazabilidad.
- Unidad derivada de la descripción: «horas» → H, «mensual» → MES, resto → UN.
- `excepciones`: una por confirmación; al crear se llena `confirmado_por` con «analista (sesión <id>)».
- Cada campo tiene su fuente en `trazabilidad.json`: `solicitud`, `cotizacion`, `maestro.<nombre>` o `derivado`.

## Control

Cada intento de `oc_crear` agrega una fila a `out/control.csv` con `resultado` = `creada`, `idempotente`, `bloqueada` o `pendiente` (faltaba la confirmación), y las columnas `retroactiva`, `bloqueos` y `confirmaciones`.
