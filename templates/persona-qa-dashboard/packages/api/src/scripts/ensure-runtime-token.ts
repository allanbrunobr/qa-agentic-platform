// Creates the local API token file if it does not exist yet. The launcher runs this before it starts
// the API and the dashboard, so both read the same token. Prints the path only, never the token.
import { defaultRuntimeTokenPath, ensureRuntimeToken } from '../security/runtime-token.js'

const tokenPath = defaultRuntimeTokenPath()
await ensureRuntimeToken(tokenPath)
console.log(`[.agentic-qa] runtime API token: ${tokenPath}`)
