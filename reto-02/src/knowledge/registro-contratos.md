# Conocimiento del proceso: registro de contratos vigentes

## Contexto

El maestro de contratos vigentes de Periferia está congelado desde el **2026-05-30**: lo alimentaba un aprendiz que ya no está y hoy solo llegan a administración los contratos que requieren póliza. El agente es el **punto único de recepción**: todo contrato, con o sin póliza, entra por el buzón `contratos@periferia-ficticia.com`.

## Actores

- **Comercial**: cierra el contrato y lo envía al buzón. No usa el agente.
- **Analista administrativa**: dueña del maestro y del seguimiento de pólizas. Conversa con el agente y confirma los campos dudosos.
- **Gerencia**: lee el reporte de alertas.

## Esquema del maestro (una fila por contrato)

| Columna | Regla |
| --- | --- |
| `id_contrato` | Número tal como aparece en el documento; si no hay, `AUTO-<año>-<secuencia>`. En un otrosí, el número del contrato que modifica. |
| `cliente` | Razón social de la contraparte (nunca Periferia, NIT 900123456). |
| `nit_cliente` | Identificador tributario sin puntos ni dígito de verificación. |
| `pais` | `CO`, `EC`, `PE`, `PA` o `HN`, inferido del identificador: NIT → CO, RTN → HN, RUC de 13 dígitos → EC, RUC de 11 → PE; si no, por la ciudad del domicilio. |
| `objeto` | Máximo 200 caracteres. |
| `valor` | Sin separadores. `0` si el contrato es por demanda (`valor_indeterminado`). |
| `moneda` | `COP`, `USD`, `PEN`, `PAB` o `HNL`. |
| `fecha_inicio` / `fecha_fin` | `YYYY-MM-DD`; `fecha_fin` puede derivarse de un plazo en meses. |
| `requiere_poliza` / `tipo_poliza` | Tipos separados por `;` (cumplimiento, calidad, salarios_prestaciones, responsabilidad_civil…). |
| `estado_poliza` | `vigente`, `pendiente`, `vencida` o `no_aplica`. |
| `comercial` | Nombre resuelto desde `comerciales.json` por el correo del remitente. |
| `ruta_sharepoint` | Ruta relativa en `out/sharepoint/`: `Contratos/<año_inicio>/<cliente>/<id_contrato>.<ext>`. |
| `fecha_registro` / `fuente` | Fecha de hoy y `buzon`. |

## Confianza de la extracción

Cada campo trae una confianza entre 0 y 1 calculada por la herramienta:

- 0.95: dato explícito (cifra que coincide con el valor en letras, fechas con día, mes y año).
- 0.85–0.9: dato inferido con una regla fuerte (país por tipo de identificador, plazo en meses desde una fecha exacta).
- 0.6: dato aproximado (valor por demanda, fecha fin derivada de una firma sin día).
- 0: el campo no aparece en el documento (`null`).

**Umbral: confianza < 0.8 → el campo va a `requiere_revision`** y el contrato no se registra hasta que la analista lo confirme.

## Reglas de negocio

| # | Regla |
| --- | --- |
| RN1 | **Duplicado**: mismo `id_contrato` y mismos `valor`, `fecha_inicio`, `fecha_fin`. No se escribe nada; se reporta y el mensaje queda procesado. |
| RN2 | **Actualización**: mismo `id_contrato` (o mismo `nit_cliente` con objeto similar ≥ 0.9) con algún campo distinto, o un otrosí. Se actualiza la fila (solo los campos que trae el documento) y el cambio queda en `historial.jsonl`. Un otrosí que amplía el plazo de un contrato con póliza vigente deja `estado_poliza = pendiente`, porque la póliza debe ampliarse. |
| RN3 | **Nuevo**: sin coincidencia. Se inserta; con póliza → `pendiente`, sin póliza → `no_aplica`. |
| RN4 | **Rechazado**: sin adjunto de contrato (por ejemplo una cotización) o sin partes ni objeto identificables. Se reporta con motivo y el mensaje queda procesado. |
| RN5 | Campos con confianza < 0.8 o en conflicto con el maestro → `requiere_revision`; `contratos_registrar` sin `confirmado = true` los rechaza. |
| RN6 | El fixture del maestro es de solo lectura; la primera escritura lo copia a `out/sharepoint/maestro-contratos.csv`. |
| RN7 | Toda llamada a herramienta queda en `out/log.jsonl`. |

Un remitente que no está en `comerciales.json` se reporta (`remitente_no_registrado`) pero no bloquea el registro. Una póliza condicionada a cada orden de servicio (contrato marco) no se marca como requerida en el contrato: se gestiona en cada orden.

## Alertas (`out/alertas.md`)

1. Contratos que vencen en 60 días o menos desde `hoy`.
2. Pólizas pendientes: `requiere_poliza = true` y `estado_poliza ≠ vigente`.
3. Contratos registrados desde el corte del 2026-05-30 (gap cubierto) y actualizaciones desde el corte.
4. Vencidos sin cierre: fecha fin anterior a hoy y siguen en el maestro.
