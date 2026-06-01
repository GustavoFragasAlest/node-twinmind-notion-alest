import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { FileOAuthProvider } from "./oauth-provider.mjs"
import http from "node:http"
import open from "open"

const SERVER_URL = "https://api.twinmind.com/mcp"
const PORT = 8765

function waitForCode() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("code")
      if (code) {
        res.end("Login concluido. Pode fechar esta aba.")
        server.close()
        resolve(code)
      } else {
        res.end("Aguardando...")
      }
    })
    server.listen(PORT)
  })
}

const provider = new FileOAuthProvider({ redirectUrl: `http://localhost:${PORT}/callback` })
const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider })
const client = new Client({ name: "twinmind-notion-sync", version: "1.0.0" }, { capabilities: {} })

try {
  await client.connect(transport)
  console.log("Ja autenticado. tokens.json valido.")
  await client.close()
} catch (err) {
  if (!provider.lastAuthorizationUrl) throw err
  console.log("Abrindo navegador para login...")
  await open(provider.lastAuthorizationUrl)
  const code = await waitForCode()
  await transport.finishAuth(code)
  console.log("Tokens salvos em tokens.json. CONFIRME se existe a chave 'refresh_token'.")
  await client.close()
}
