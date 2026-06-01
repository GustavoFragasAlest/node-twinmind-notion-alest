import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { FileOAuthProvider } from "./oauth-provider.mjs"
import { Client as NotionClient } from "@notionhq/client"
import fs from "node:fs"

const SERVER_URL = "https://api.twinmind.com/mcp"
const TOKEN_URL = "https://api.twinmind.com/oauth/token"
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN })
const DATABASE_ID = process.env.NOTION_DATABASE_ID

// No GitHub Actions, recria os arquivos a partir dos secrets
if (process.env.TWINMIND_TOKENS) fs.writeFileSync("./tokens.json", process.env.TWINMIND_TOKENS)
if (process.env.TWINMIND_CLIENT) fs.writeFileSync("./client.json", process.env.TWINMIND_CLIENT)

// --- renova o token de acesso ANTES de conectar (o de acesso dura ~1h e expira entre as execucoes) ---
async function ensureFreshToken() {
  if (!fs.existsSync("./tokens.json")) { console.log("DEBUG: sem tokens.json"); return }
  const tokens = JSON.parse(fs.readFileSync("./tokens.json", "utf8"))
  const client = fs.existsSync("./client.json") ? JSON.parse(fs.readFileSync("./client.json", "utf8")) : {}
  if (!tokens.refresh_token) { console.log("DEBUG: sem refresh_token, pulando refresh"); return }
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
    console.log("DEBUG refresh FAIL:", resp.status, await resp.text())
    return
  }
  const fresh = await resp.json()
  // se o servidor nao devolver um novo refresh_token, mantem o atual
  if (!fresh.refresh_token && tokens.refresh_token) fresh.refresh_token = tokens.refresh_token
  fs.writeFileSync("./tokens.json", JSON.stringify(fresh, null, 2))
  console.log("DEBUG token renovado OK")
}
await ensureFreshToken()

const provider = new FileOAuthProvider({ redirectUrl: "http://localhost:8765/callback" })
const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider })
const twin = new Client({ name: "twinmind-notion-sync", version: "1.0.0" }, { capabilities: {} })
await twin.connect(transport)

// --- helpers ---
function parseToolJson(result) {
  const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("")
  const safe = text.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
  try {
    return JSON.parse(safe)
  } catch (e) {
    const pos = Number((/position (\d+)/.exec(e.message) || [])[1]) || 0
    console.log("DEBUG parse FAIL:", e.message, "| around:", JSON.stringify(text.slice(Math.max(0, pos - 120), pos + 120)))
    return text
  }
}
function asList(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.results)) return parsed.results
  if (parsed && Array.isArray(parsed.items)) return parsed.items
  return []
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
  const transcript = full?.transcript || full?.content || ""
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

// --- fluxo principal (paginado por data, lotes pequenos para nao estourar o limite de ~100KB) ---
const seen = await existingIds()
let cursor = null
let novos = 0
const processed = new Set()
for (let page = 0; page < 200; page++) {
  const args = { limit: 10 }
  if (cursor) args.end_time = cursor
  const batch = asList(parseToolJson(await twin.callTool({ name: "summary_search", arguments: args })))
  console.log("DEBUG pagina", page, "| itens:", batch.length, "| ate:", cursor)
  if (!batch.length) break
  let novosNaPagina = 0
  let oldest = null
  for (const it of batch) {
    const id = it.meeting_id
    if (it.start_time_local && (oldest === null || it.start_time_local < oldest)) oldest = it.start_time_local
    if (!id || processed.has(id)) continue
    processed.add(id)
    novosNaPagina++
    if (seen.has(id)) continue
    const full = parseToolJson(await twin.callTool({ name: "fetch", arguments: { id: `summary-${id}` } }))
    await createRow(it, full)
    novos++
  }
  if (!oldest || (cursor && oldest >= cursor) || novosNaPagina === 0) break
  cursor = oldest
}
console.log(`Concluido. ${novos} conversa(s) nova(s) adicionada(s).`)
await twin.close()
