import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { URL } from 'node:url'
import {
  CONTROL_PLANE_HOST,
  ControlPlaneError,
  allowedWebOrigins,
  ensureControlPlaneToken,
  readJsonBody,
  tokenFromRequest,
  tokensMatch,
} from './control-plane-guard.ts'
import { handleAdaptersRequest, handleAdapterScenariosRequest } from './routes/adapters.ts'
import { handleAdapterPromotionRequest, handleAdapterPromotionUpdateRequest } from './routes/adapter-promotion.ts'
import { handleBootstrapRequest } from './routes/bootstrap.ts'
import { handleDiscoveryRequest } from './routes/discovery.ts'
import { handleDiscoverLocalRequest } from './routes/discover-local.ts'
import { handleExecutionDetailRequest, handleExecutionInitRequest, handleExecutionListRequest } from './routes/executions.ts'
import {
  handleGeneratedAdapterFileRequest,
  handleGeneratedAdapterFilesRequest,
  handleGeneratedAdapterFileUpdateRequest,
} from './routes/generated-files.ts'
import { handleInstallLocalRequest } from './routes/install-local.ts'
import { handleMaterializeRequest } from './routes/materialize.ts'
import { handleReviewRequest } from './routes/review.ts'
import { handleSessionDetailRequest, handleSessionListRequest } from './routes/sessions.ts'

const API_PORT = Number(process.env.AGENTIC_PLATFORM_API_PORT ?? 3101)
const WEB_PORT = Number(process.env.AGENTIC_PLATFORM_WEB_PORT ?? 4177)

type PlatformServerOptions = {
  apiPort?: number
  webPort?: number
  token?: string
}

function statusCodeOf(error: unknown): number {
  if (error instanceof ControlPlaneError) return error.statusCode
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode
  }
  const message = error instanceof Error ? error.message : String(error)
  if (
    message.startsWith('Scenario restricted by quality gate:')
    || message.startsWith('Adapter promotion blocked by scenario quality signals.')
  ) {
    return 409
  }
  return 500
}

function errorCodeOf(error: unknown, statusCode: number): string {
  if (error instanceof ControlPlaneError) return error.code
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  if (statusCode === 409) return 'conflict'
  return 'internal_error'
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  webPort: number,
  statusCode: number,
  body: unknown,
) {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : ''
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    vary: 'origin',
  }
  if (origin && allowedWebOrigins(webPort).includes(origin)) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-methods'] = 'GET,POST,OPTIONS'
    headers['access-control-allow-headers'] = 'content-type, authorization, x-agentic-token'
  }
  response.writeHead(statusCode, headers)
  response.end(JSON.stringify(body, null, 2))
}

export async function createPlatformApiServer(options: PlatformServerOptions = {}) {
  const apiPort = options.apiPort ?? API_PORT
  const webPort = options.webPort ?? WEB_PORT
  const token = options.token ?? await ensureControlPlaneToken()
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', `http://${CONTROL_PLANE_HOST}:${apiPort}`)
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : ''

    if (method === 'OPTIONS') {
      if (origin && !allowedWebOrigins(webPort).includes(origin)) {
        sendJson(request, response, webPort, 403, { error: 'origin_not_allowed' })
        return
      }
      const headers: Record<string, string> = { vary: 'origin' }
      if (origin && allowedWebOrigins(webPort).includes(origin)) {
        headers['access-control-allow-origin'] = origin
        headers['access-control-allow-methods'] = 'GET,POST,OPTIONS'
        headers['access-control-allow-headers'] = 'content-type, authorization, x-agentic-token'
      }
      response.writeHead(204, headers)
      response.end()
      return
    }

    try {
      if (method === 'GET' && url.pathname === '/health') {
        sendJson(request, response, webPort, 200, {
          ok: true,
          service: 'agentic-platform-dashboard-api',
          port: apiPort,
          webPort,
        })
        return
      }

      if (!tokensMatch(tokenFromRequest(request.headers), token)) {
        sendJson(request, response, webPort, 401, { error: 'unauthorized' })
        return
      }

      if (method === 'GET' && url.pathname === '/api/adapters') {
        sendJson(request, response, webPort, 200, await handleAdaptersRequest())
        return
      }

      const scenarioMatch = url.pathname.match(/^\/api\/adapters\/([^/]+)\/scenarios$/)
      if (method === 'GET' && scenarioMatch?.[1]) {
        sendJson(request, response, webPort, 200, await handleAdapterScenariosRequest(decodeURIComponent(scenarioMatch[1])))
        return
      }

      const promotionMatch = url.pathname.match(/^\/api\/adapters\/([^/]+)\/promotion$/)
      if (method === 'GET' && promotionMatch?.[1]) {
        sendJson(request, response, webPort, 200, await handleAdapterPromotionRequest(decodeURIComponent(promotionMatch[1])))
        return
      }

      if (method === 'POST' && promotionMatch?.[1]) {
        sendJson(
          request,
          response,
          webPort,
          200,
          await handleAdapterPromotionUpdateRequest(decodeURIComponent(promotionMatch[1]), await readJsonBody(request)),
        )
        return
      }

      const generatedFilesMatch = url.pathname.match(/^\/api\/adapters\/([^/]+)\/generated-files$/)
      if (method === 'GET' && generatedFilesMatch?.[1]) {
        sendJson(request, response, webPort, 200, await handleGeneratedAdapterFilesRequest(decodeURIComponent(generatedFilesMatch[1])))
        return
      }

      const generatedFileMatch = url.pathname.match(/^\/api\/adapters\/([^/]+)\/generated-files\/([^/]+)$/)
      if (method === 'GET' && generatedFileMatch?.[1] && generatedFileMatch[2]) {
        sendJson(
          request,
          response,
          webPort,
          200,
          await handleGeneratedAdapterFileRequest(
            decodeURIComponent(generatedFileMatch[1]),
            decodeURIComponent(generatedFileMatch[2]),
          ),
        )
        return
      }

      if (method === 'POST' && generatedFileMatch?.[1] && generatedFileMatch[2]) {
        sendJson(
          request,
          response,
          webPort,
          200,
          await handleGeneratedAdapterFileUpdateRequest(
            decodeURIComponent(generatedFileMatch[1]),
            decodeURIComponent(generatedFileMatch[2]),
            await readJsonBody(request),
          ),
        )
        return
      }

      if (method === 'GET' && url.pathname === '/api/executions') {
        sendJson(request, response, webPort, 200, await handleExecutionListRequest())
        return
      }

      if (method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(request, response, webPort, 200, await handleSessionListRequest())
        return
      }

      const executionMatch = url.pathname.match(/^\/api\/executions\/([^/]+)$/)
      if (method === 'GET' && executionMatch?.[1]) {
        sendJson(request, response, webPort, 200, await handleExecutionDetailRequest(decodeURIComponent(executionMatch[1])))
        return
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (method === 'GET' && sessionMatch?.[1]) {
        sendJson(request, response, webPort, 200, await handleSessionDetailRequest(decodeURIComponent(sessionMatch[1])))
        return
      }

      if (method === 'POST' && url.pathname === '/api/install-local') {
        sendJson(request, response, webPort, 200, await handleInstallLocalRequest(await readJsonBody(request)))
        return
      }

      if (method === 'POST' && url.pathname === '/api/discover-local') {
        sendJson(request, response, webPort, 200, await handleDiscoverLocalRequest(await readJsonBody(request)))
        return
      }

      if (method === 'POST' && url.pathname === '/api/discovery') {
        sendJson(request, response, webPort, 200, await handleDiscoveryRequest(await readJsonBody(request)))
        return
      }

      if (method === 'POST' && url.pathname === '/api/bootstrap') {
        sendJson(request, response, webPort, 200, await handleBootstrapRequest(await readJsonBody(request)))
        return
      }

      if (method === 'POST' && url.pathname === '/api/review') {
        sendJson(request, response, webPort, 200, await handleReviewRequest(await readJsonBody(request)))
        return
      }

      if (method === 'POST' && url.pathname === '/api/materialize') {
        sendJson(request, response, webPort, 200, await handleMaterializeRequest(await readJsonBody(request)))
        return
      }

      if (method === 'POST' && url.pathname === '/api/executions') {
        sendJson(request, response, webPort, 200, await handleExecutionInitRequest(await readJsonBody(request)))
        return
      }

      sendJson(request, response, webPort, 404, { error: 'not_found', path: url.pathname })
    } catch (error) {
      const statusCode = statusCodeOf(error)
      const code = errorCodeOf(error, statusCode)
      const body: Record<string, unknown> = { error: code }
      if (statusCode === 409 || statusCode === 422 || statusCode === 500) {
        body.message = error instanceof Error ? error.message : String(error)
      }
      sendJson(request, response, webPort, statusCode, body)
    }
  })

  return { server, token, apiPort, webPort }
}

async function startPlatformApi() {
  const { server, apiPort } = await createPlatformApiServer()
  server.listen(apiPort, CONTROL_PLANE_HOST, () => {
    console.log(`agentic-platform dashboard-api listening on http://${CONTROL_PLANE_HOST}:${apiPort}`)
  })
}

if (path.basename(process.argv[1] ?? '') === 'server.ts') {
  void startPlatformApi()
}
