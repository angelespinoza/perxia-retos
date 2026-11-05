// Configuración de Vercel: app Hono en Vercel Functions (Fluid Compute) con runtime Bun.
import type { VercelConfig } from "@vercel/config/v1"

export const config: VercelConfig = {
  framework: "hono",
  bunVersion: "1.x",
  functions: {
    "src/server.ts": {
      // Archivos que las herramientas leen en tiempo de ejecución (solo lectura).
      includeFiles: "{fixtures,agent,web,src/knowledge}/**",
      maxDuration: 300,
    },
  },
}
