# Perxia 2.0 — Retos técnicos

Tres agentes conversacionales independientes, uno por reto, en carpetas autocontenidas. Cada carpeta se instala, prueba y despliega por separado.

| Etapa | Reto | Carpeta | Estado | Link |
| --- | --- | --- | --- | --- |
| 1 | Registro como Proveedor | [reto-01](reto-01/) | Desplegado | https://perxia-reto-01-one.vercel.app |
| 2 | Registro de Contratos Vigentes | [reto-02](reto-02/) | En curso | — |
| 3 | Órdenes de Compra SAP | [reto-03](reto-03/) | Por iniciar | — |

Cada reto tiene su `README.md` (cómo levantarlo) y su `SOLUCION.md` (planteamiento).

## Convenciones

- TypeScript estricto con Bun; validación con zod.
- LLM agnóstico: Anthropic, OpenAI o Gemini con `LLM_PROVIDER`.
- Despliegue en Vercel, un proyecto por reto (Root Directory = carpeta del reto).
- CI: typecheck, pruebas, `demo.ts` y verificación de `modulo/` en cada PR.
