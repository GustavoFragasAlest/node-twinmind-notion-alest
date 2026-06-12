import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { FileOAuthProvider } from "./oauth-provider.mjs"
import { Client as NotionClient } from "@notionhq/client"
import { execSync } from "node:child_process"
import fs from "node:fs"

const SERVER_URL = "https://api.twinmind.com/mcp"
const TOKEN_URL = "https://api.twinmind.com/oauth/token"
const REPO = "GustavoFragasAlest/node-twinmind-notion-alest"
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN })
const DATABASE_ID = process.env.NOTION_DATABASE_ID

if (process.env.TWINMIND_TOKENS) fs.writeFileSync("./tokens.json", process.env.TWINMIND_TOKENS)
if (process.env.TWINMIND_CLIENT) fs.writeFileSync("./client.json", process.env.TWINMIND_CLIENT)

// --- grava tokens.json de volta no secret; retorna true/false (NUNCA falha silenciosamente) ---
function persistTokensToSecret(label) {
  if (!process.env.GH_PAT) {
    if (process.env.GITHUB_ACTIONS) {
      console.error(`ERRO (${label}): GH_PAT ausente no GitHub Actions - impossivel persistir o token rotacionado.`)
      return false
    }
    console.log(`Execucao local (${label}): sem GH_PAT, pulando gravacao do secret.`)
    return true
  }
  try {
    execSync(`gh secret set TWINMIND_TOKENS --repo ${REPO} < tokens.json`, {
      stdio: "inherit",
      env: { ...process.env, GH_TOKEN: process.env.GH_PAT },
    })
    console.log(`OK (${label}): secret TWINMIND_TOKENS gravado.`)
    return true
  } catch (e) {
    console.error(`ERRO (${label}): falha ao gravar secret TWINMIND_TOKENS:`, e.message)
    return false
  }
}

// --- renova o token de acesso ANTES de conectar (ele dura ~1h e expira entre execucoes) ---
// Falha ALTO (exit 1) em qualquer problema: nunca seguir com token invalido.
async function ensureFreshToken() {
  if (!fs.existsSync("./tokens.json")) {
    console.error("ERRO: tokens.json nao encontrado. Rode 'npm run auth' e atualize o secret TWINMIND_TOKENS.")
    process.exit(1)
  }
  const tokens = JSON.parse(fs.readFileSync("./tokens.json", "utf8"))
  const client = fs.existsSync("./client.json") ? JSON.parse(fs.readFileSync("./client.json", "utf8")) : {}
  if (!tokens.refresh_token) {
    console.error("ERRO: tokens.json sem refresh_token. Refaca o login com 'npm run auth' e atualize o secret TWINMIND_TOKENS.")
    process.exit(1)
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client.client_id || "",
  })
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!resp.ok) {
    console.error("ERRO refresh FAIL:", resp.status, await resp.text())
    console.error("Acao necessaria: refazer o login OAuth do TwinMind ('npm run auth') e atualizar os secrets TWINMIND_TOKENS e TWINMIND_CLIENT.")
    process.exit(1)
  }
  const fresh = await resp.json()
  if (!fresh.refresh_token && tokens.refresh_token) fresh.refresh_token = tokens.refresh_token
  fs.writeFileSync("./tokens.json", JSON.stringify(fresh, null, 2))
  console.log("OK: token TwinMind renovado.")
}

// PRE-FLIGHT: prova que conseguimos gravar o secret ANTES de rotacionar o refresh token.
// Se a gravacao falhar (ex.: GH_PAT expirado/sem permissao), aborta SEM queimar o token atual.
if (!persistTokensToSecret("pre-flight")) {
  console.error("ABORTADO antes do refresh: nao e possivel persistir secrets (GH_PAT expirado ou sem permissao 'Secrets: Read and write'?).")
  console.error("O refresh token atual foi PRESERVADO - corrija o GH_PAT e rode o workflow de novo. NAO e preciso reautenticar o TwinMind.")
  process.exit(1)
}
await ensureFreshToken()
// Persiste o token rotacionado. Se falhar aqui (janela minima apos o pre-flight), falha ALTO.
if (!persistTokensToSecret("pos-refresh")) {
  console.error("ERRO CRITICO: token foi rotacionado mas NAO persistido. Refazer 'npm run auth' e atualizar TWINMIND_TOKENS antes do proximo run.")
  process.exit(1)
}

const provider = new FileOAuthProvider({ redirectUrl: "http://localhost:8765/callback" })
const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider })
const twin = new Client({ name: "twinmind-notion-sync", version: "1.0.0" }, { capabilities: {} })
await twin.connect(transport)

// --- le o texto da ferramenta ---
function toolText(result) {
  return (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("")
}
// --- extrai os objetos COMPLETOS de um array JSON que pode estar cortado no meio ---
function salvageItems(text) {
  const items = []
  let depth = 0, inStr = false, esc = false, start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === "{") { if (depth === 0) start = i; depth++ }
    else if (ch === "}") {
      depth--
      if (depth === 0 && start >= 0) {
        try { items.push(JSON.parse(text.slice(start, i + 1))) } catch (e) {}
        start = -1
      }
    }
  }
  return items
}
function parseOne(text) {
  try { return JSON.parse(text) } catch (e) { return null }
}

const toText = (v) => Array.isArray(v) ? v.join("\n") : (v || "")
const rt = (s) => (s ? [{ type: "text", text: { content: String(s).slice(0, 2000) } }] : [])
const para = (t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(t) } })
const h2 = (t) => ({ object: "block", type: "heading_2", heading_2: { rich_text: rt(t) } })
function chunk(text, size = 1900) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
function durationText(it) {
  if (!it.start_time_local || !it.end_time_local) return ""
  let sec = Math.max(0, Math.round((new Date(it.end_time_local) - new Date(it.start_time_local)) / 1000))
  const m = Math.floor(sec / 60); sec = sec % 60
  return m > 0 ? `${m} min ${sec} s` : `${sec} s`
}
async function existingIds() {
  const ids = new Set()
  let cursor
  do {
    const r = await notion.databases.query({ database_id: DATABASE_ID, start_cursor: cursor, page_size: 100 })
    for (const p of r.results) {
      const v = p.properties["ID TwinMind"]?.rich_text?.[0]?.plain_text
      if (v) ids.add(v)
    }
    cursor = r.has_more ? r.next_cursor : undefined
  } while (cursor)
  return ids
}
async function createRow(it, full) {
  const summary = it.summary || full?.summary || ""
  const transcript = full?.content || full?.transcript || ""
  const children = []
  if (summary) { children.push(h2("Resumo"), para(summary)) }
  if (transcript) {
    children.push(h2("Transcricao completa"))
    for (const c of chunk(transcript)) children.push(para(c))
  }
  const props = {
    "Conversa": { title: rt(it.meeting_title || "Conversa TwinMind") },
    "Resumo": { rich_text: rt(summary) },
    "Action Items": { rich_text: rt(toText(it.action_items || it.action)) },
    "Participantes": { rich_text: rt(toText(it.participants)) },
    "Local": { rich_text: rt(it.current_location) },
    "ID TwinMind": { rich_text: rt(it.meeting_id) },
    "Status": { status: { name: "Capturado" } },
  }
  if (it.start_time_local) props["Data"] = { date: { start: it.start_time_local } }
  if (it.end_time_local) props["Fim"] = { date: { start: it.end_time_local } }
  const dur = durationText(it)
  if (dur) props["Duração"] = { rich_text: rt(dur) }
  await notion.pages.create({ parent: { database_id: DATABASE_ID }, properties: props, children })
}

// --- fluxo principal: pagina por DATA (o limit e ignorado pela API) ---
const seen = await existingIds()
let cursor = null
let novos = 0
const processed = new Set()
for (let page = 0; page < 500; page++) {
  const args = {}
  if (cursor) args.end_time = cursor
  const batch = salvageItems(toolText(await twin.callTool({ name: "summary_search", arguments: args })))
  console.log("DEBUG pagina", page, "| itens lidos:", batch.length, "| ate:", cursor)
  if (!batch.length) break
  let oldest = null
  let novosNaPagina = 0
  for (const it of batch) {
    const id = it.meeting_id
    if (it.start_time_local && (oldest === null || it.start_time_local < oldest)) oldest = it.start_time_local
    if (!id || processed.has(id)) continue
    processed.add(id)
    novosNaPagina++
    if (seen.has(id)) continue
    const full = parseOne(toolText(await twin.callTool({ name: "fetch", arguments: { id: `summary-${id}` } })))
    await createRow(it, full)
    novos++
  }
  if (!oldest || (cursor && oldest >= cursor) || novosNaPagina === 0) break
  cursor = oldest
}
console.log(`Concluido. ${novos} conversa(s) nova(s) adicionada(s).`)
await twin.close()
