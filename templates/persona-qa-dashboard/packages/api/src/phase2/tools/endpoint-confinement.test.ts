import { describe, expect, it } from 'vitest'
import { confineEndpointUrl, confinePackageBin } from './endpoint-confinement.js'

describe('endpoint confinement', () => {
  it('keeps a normal path on the configured origin', () => {
    expect(confineEndpointUrl('/health', 'http://127.0.0.1:8080/api/')).toBe('http://127.0.0.1:8080/health')
  })

  it('refuses a protocol-relative path and a backslash host', () => {
    expect(confineEndpointUrl('//127.0.0.1:9/owned', 'http://127.0.0.1:8080/api/')).toBeNull()
    expect(confineEndpointUrl('/\\@127.0.0.1:9/', 'http://127.0.0.1:8080/api/')).toBeNull()
  })

  it('refuses an absolute URL that changes host', () => {
    expect(confineEndpointUrl('http://127.0.0.1:9/owned', 'http://127.0.0.1:8080/api/')).toBeNull()
  })

  it('refuses package bins that leave the repository', () => {
    expect(confinePackageBin('/tmp/fixture-repo', 'bin/cli.js')).toBe('/tmp/fixture-repo/bin/cli.js')
    expect(confinePackageBin('/tmp/fixture-repo', '../../outside.js')).toBeNull()
    expect(confinePackageBin('/tmp/fixture-repo', '/tmp/absolute.js')).toBeNull()
  })
})
