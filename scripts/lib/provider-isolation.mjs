// T-06 (docs/analise-20261109.md): the release gate installs into throwaway repositories under the
// system temp dir. The installer resolves a provider key from *_OVERRIDE, then the platform
// .env.local, then the environment, validates it over the network and writes it into the fixture.
// These variables pin both keys (a set override wins even when empty) and turn the network
// validation off, so no developer key is read, validated or copied, and the gate needs no network.
export function isolatedProviderEnv({ anthropicKey = '' } = {}) {
  return {
    ANTHROPIC_API_KEY_OVERRIDE: anthropicKey,
    OPENAI_API_KEY_OVERRIDE: '',
    ANTHROPIC_API_KEY: anthropicKey,
    ANTHROPIC_API: '',
    OPENAI_API_KEY: '',
    AGENTIC_QA_SKIP_KEY_VALIDATION: '1',
  }
}
