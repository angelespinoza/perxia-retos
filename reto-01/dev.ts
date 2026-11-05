/// <reference types="bun" />
// Arranque local: bun run dev (Bun carga .env automáticamente).
import app from "./src/server.ts"

const port = Number(process.env.PORT) || 3000
Bun.serve({ port, fetch: app.fetch, idleTimeout: 255 })
console.log(`Agente Registro como Proveedor en http://localhost:${port}`)
