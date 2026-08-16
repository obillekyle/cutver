import { afterEach, describe, expect, test } from 'bun:test'
import { ask, CONNECTORS_AVAILABLE, keyFor } from './connectors'
import type { SummarizerConfig } from '../config/schema'

const config = (over: Partial<SummarizerConfig> = {}): SummarizerConfig => ({
  connector: 'gemini',
  model: 'gemini-3.6-flash-lite',
  baseUrl: null,
  retry: null,
  withBody: true,
  ...over,
})

/**
 * The real `fetch`, restored after every test.
 *
 * Stubbed rather than hitting a provider: these assertions are about the
 * request cutver builds and the answer it reads back, and a test that needs a
 * key is a test nobody runs.
 */
const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
})

interface Seen {
  url: string
  headers: Record<string, string>
  body: unknown
}

function stub(reply: Response | (() => Promise<Response>)): Seen[] {
  const seen: Seen[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    })
    return typeof reply === 'function' ? reply() : reply
  }) as never
  return seen
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('keyFor', () => {
  test('prefers the connector-agnostic name', () => {
    // One variable for CI to set, so switching providers is a config change and
    // not a secrets change.
    const { value } = keyFor('gemini', {
      CUTVER_SUMMARIZE_KEY: 'shared',
      GEMINI_API_KEY: 'specific',
    })
    expect(value).toBe('shared')
  })

  test('falls back to the provider convention', () => {
    // So a laptop that already exports the provider's own variable can cut a
    // release by hand with no extra setup.
    expect(keyFor('anthropic', { ANTHROPIC_API_KEY: 'k' }).value).toBe('k')
    expect(keyFor('gemini', { GOOGLE_API_KEY: 'k' }).value).toBe('k')
  })

  test('reports every name it tried', () => {
    // The error a user sees names the variables to set. "No key" on its own is
    // true and unactionable.
    const { value, tried } = keyFor('gemini', {})
    expect(value).toBeNull()
    expect(tried).toContain('CUTVER_SUMMARIZE_KEY')
    expect(tried).toContain('GEMINI_API_KEY')
  })

  test('whitespace is not a key', () => {
    expect(keyFor('anthropic', { ANTHROPIC_API_KEY: '   ' }).value).toBeNull()
  })
})

describe('ask', () => {
  test('gemini: key in a header, never the URL', async () => {
    // A URL reaches proxy logs, CI logs and error messages; a header does not.
    const seen = stub(
      json({ candidates: [{ content: { parts: [{ text: 'summary' }] } }] }),
    )
    const { text, error } = await ask(config(), 'SECRET', 'prompt')

    expect(error).toBeNull()
    expect(text).toBe('summary')
    expect(seen[0]?.url).not.toContain('SECRET')
    expect(seen[0]?.headers['x-goog-api-key']).toBe('SECRET')
  })

  test('anthropic: messages shape, and max_tokens is required there', async () => {
    const seen = stub(json({ content: [{ type: 'text', text: 'summary' }] }))
    const { text } = await ask(
      config({ connector: 'anthropic', model: 'claude-opus-5' }),
      'K',
      'p',
    )

    expect(text).toBe('summary')
    expect(seen[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01')
    expect(
      (seen[0]?.body as { max_tokens?: number }).max_tokens,
    ).toBeGreaterThan(0)
  })

  test('openai-compatible: base_url decides the provider', async () => {
    const seen = stub(json({ choices: [{ message: { content: 'summary' } }] }))
    const { text } = await ask(
      config({
        connector: 'openai-compatible',
        model: 'x',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
      'K',
      'p',
    )

    expect(text).toBe('summary')
    expect(seen[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(seen[0]?.headers.authorization).toBe('Bearer K')
  })

  test('an HTTP error carries the body, not just the status', async () => {
    // A 400 from any of these explains itself — a bad model name, a malformed
    // request. Printing only "400" turns a two-second fix into a bisect.
    stub(json({ error: { message: 'model not found: gemini-9' } }, 400))
    const { text, error } = await ask(config(), 'K', 'p')

    expect(text).toBeNull()
    expect(error).toContain('400')
    expect(error).toContain('model not found')
  })

  test('a 200 with an unreadable shape is an error, not an empty summary', async () => {
    // "The model returned nothing" and "cutver could not find the text in this
    // response" are different bugs and only one of them is the user's.
    stub(json({ unexpected: true }))
    const { text, error } = await ask(config(), 'K', 'p')

    expect(text).toBeNull()
    expect(error).toBe('no text in the response')
  })

  test('a network failure is returned, never thrown', async () => {
    // The invariant the whole feature rests on: nothing here may fail a
    // release.
    globalThis.fetch = (() => Promise.reject(new Error('ECONNRESET'))) as never
    const { text, error } = await ask(config(), 'K', 'p')

    expect(text).toBeNull()
    expect(error).toContain('ECONNRESET')
  })

  test('only failures that waiting could fix are retryable', async () => {
    // **The distinction `summarizer.retry` rests on.** A window that refills is
    // worth a minute; a request that is wrong will be just as wrong later, and
    // sleeping on it turns a clear error into a slow one.
    stub(json({ error: { message: 'quota exceeded' } }, 429))
    expect((await ask(config(), 'K', 'p')).retryable).toBe(true)

    stub(json({ error: { message: 'backend overloaded' } }, 503))
    expect((await ask(config(), 'K', 'p')).retryable).toBe(true)

    stub(json({ error: { message: 'model not found' } }, 400))
    expect((await ask(config(), 'K', 'p')).retryable).toBe(false)

    stub(json({ error: { message: 'invalid key' } }, 401))
    expect((await ask(config(), 'K', 'p')).retryable).toBe(false)

    // A dropped connection says nothing about the request.
    globalThis.fetch = (() => Promise.reject(new Error('ECONNRESET'))) as never
    expect((await ask(config(), 'K', 'p')).retryable).toBe(true)

    // A 200 that parsed but had no text will parse the same way next time.
    stub(json({ unexpected: true }))
    expect((await ask(config(), 'K', 'p')).retryable).toBe(false)
  })

  test('an unknown connector names the ones that exist', async () => {
    const { error } = await ask(config({ connector: 'cohere' }), 'K', 'p')
    for (const name of CONNECTORS_AVAILABLE) expect(error).toContain(name)
  })

  test('the prompt reaches the provider intact', async () => {
    // Including the `<release-notes>` delimiter — the injection boundary is
    // worth nothing if a connector reformats the payload on the way out.
    const seen = stub(
      json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    )
    await ask(config(), 'K', 'RULES\n\n<release-notes>\nbody\n</release-notes>')

    const sent = JSON.stringify(seen[0]?.body)
    expect(sent).toContain('<release-notes>')
    expect(sent).toContain('RULES')
  })
})
