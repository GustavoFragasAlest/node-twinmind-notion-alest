import fs from "node:fs"

export class FileOAuthProvider {
  constructor({ redirectUrl, tokensPath = "./tokens.json", clientInfoPath = "./client.json", verifierPath = "./verifier.txt" }) {
    this._redirectUrl = redirectUrl
    this.tokensPath = tokensPath
    this.clientInfoPath = clientInfoPath
    this.verifierPath = verifierPath
    this.lastAuthorizationUrl = null
  }
  get redirectUrl() { return this._redirectUrl }
  get clientMetadata() {
    return {
      client_name: "twinmind-notion-sync",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }
  clientInformation() {
    return fs.existsSync(this.clientInfoPath) ? JSON.parse(fs.readFileSync(this.clientInfoPath, "utf8")) : undefined
  }
  saveClientInformation(info) { fs.writeFileSync(this.clientInfoPath, JSON.stringify(info, null, 2)) }
  tokens() {
    return fs.existsSync(this.tokensPath) ? JSON.parse(fs.readFileSync(this.tokensPath, "utf8")) : undefined
  }
  saveTokens(tokens) { fs.writeFileSync(this.tokensPath, JSON.stringify(tokens, null, 2)) }
  redirectToAuthorization(authUrl) { this.lastAuthorizationUrl = authUrl.toString() }
  saveCodeVerifier(v) { fs.writeFileSync(this.verifierPath, v) }
  codeVerifier() { return fs.readFileSync(this.verifierPath, "utf8") }
}
