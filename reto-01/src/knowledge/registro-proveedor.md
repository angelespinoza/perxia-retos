# Conocimiento del proceso: registro como proveedor

## Contexto

Periferia recibe entre 8 y 12 solicitudes al mes de clientes en Colombia, Ecuador, Perú, Panamá y Honduras que piden registrarla como proveedor. Los datos y los soportes ya existen en el repositorio interno; lo que cambia es el formato que pide cada cliente: plantilla Excel, formulario PDF o portal web con usuario y contraseña.

## Actores

| Actor | Papel |
| --- | --- |
| Recepción | Recibe el correo del cliente y deja el caso en la carpeta de entrada. |
| Analista administrativa | Conversa con el agente, revisa faltantes y aprueba el paquete. |
| Representante legal | Firma el formulario. No usa el agente. |
| Cliente | Pide el registro. Está fuera del sistema. |

## Estados de un campo

| Estado | Significado |
| --- | --- |
| `lleno` | El valor sale del maestro; se informa la ruta del dato (por ejemplo `banco.numero_cuenta`). |
| `faltante` | El maestro no tiene ese dato. No se inventa: lo completa una persona. |
| `requiere_confirmacion` | El mapeo es aproximado (confianza menor a 0.8) o aplica una regla de país. Una persona decide. |

## Reglas de negocio

| # | Regla |
| --- | --- |
| RN1 | Identificador tributario por país: Colombia NIT, Ecuador RUC, Perú RUC, Panamá RUC, Honduras RTN. Periferia solo tiene NIT colombiano: para otros países se llena con el NIT y queda en `requiere_confirmacion` como «identificador extranjero». |
| RN2 | Los datos bancarios se llenan solo si la plantilla los pide. Nunca van en el borrador de correo. |
| RN3 | Un soporte vencido o un soporte exigido ausente bloquea `listo_para_firma`. Un campo faltante no bloquea, pero aparece en el checklist. |
| RN4 | Ninguna acción externa (envío, firma, carga a portal) sin confirmación explícita de la analista en el mensaje inmediatamente anterior. |
| RN5 | Toda ejecución deja registro en `out/<caso>/log.jsonl`. |

Un soporte está vencido cuando su `vigencia_hasta` es anterior a la fecha de referencia del sistema. Un soporte sin `vigencia_hasta` (por ejemplo el RUT) no vence.

## Soportes del repositorio

| Tipo | Qué es |
| --- | --- |
| `camara_comercio` | Certificado de existencia y representación legal; los clientes suelen exigir que no tenga más de 30 días. |
| `rut` | Registro Único Tributario. |
| `certificacion_bancaria` | Certificación de la cuenta bancaria. |
| `parafiscales` | Certificación de pago de aportes parafiscales y seguridad social. |
| `estados_financieros` | Estados financieros auditados del último año. |
| `certificado_iso_9001` | Certificado ISO 9001:2015. |

Si el cliente exige un soporte que no está en el repositorio (por ejemplo `certificado_cumplimiento_tributario`), hay que conseguirlo antes de firmar.

## Formatos de salida

| Formato | Qué produce el agente |
| --- | --- |
| Excel (`xlsx`) | `out/<caso>/formulario.xlsx` con cada etiqueta y valor en la hoja y celda de la plantilla. Faltantes resaltados en amarillo; campos por confirmar en naranja. |
| PDF (`pdf`) | `out/<caso>/formulario.pdf` con todos los campos en el orden de la plantilla. |
| Portal web | No se llena automáticamente. Se produce `out/<caso>/valores-portal.md` para copiar; una persona ingresa las credenciales y pulsa «Enviar». |

## Paquete para firma

`out/<caso>/paquete/` contiene el formulario, copias de los soportes, `checklist.md` y `borrador-correo.md`. Después de la firma, «enviar» en este sistema solo escribe `out/<caso>/ENVIO-SIMULADO.md`.
