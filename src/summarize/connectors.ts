/**
 * Sending the release notes to an API instead of a local model.
 *
 * **Raw `fetch`, not a provider SDK.** cutver computes version numbers and
 * edits manifests; the summariser is optional and off by default. Adding
 * `@anthropic-ai/sdk`, `openai` and `@google/genai` to `dependencies` would
 * make every install pay — in bytes and in audit surface — for a feature most
 * repositories never switch on. Three request shapes are about ninety lines,
 * and they are stable ones.
 *
 * **Three, not one.** An OpenAI-compatible `/chat/completions` covers OpenAI,
 * OpenRouter, Groq, Together, vLLM, LM Studio, llama.cpp's server and Ollama,
 * so `base_url` does most of the work; Anthropic and Gemini get their own
 * because their request and response shapes genuinely differ, not because
 * cutver wants an opinion about providers.
 *
 * A release is one request per tag, so the whole feature has to fit inside the
 * `timeout-minutes: 15` on the generated step — which is the constraint that
 * decided an API call over anything the runner would have to host itself.
 */
import type { SummarizerConfig } from '../config/schema'

/** What every connector returns: markdown, or a reason it produced none. */
export interface Answer {
  text: string | null
  error: string | null
  /**
   * Whether waiting and asking again could plausibly work.
   *
   * **The distinction `retry` rests on.** A 429 is a window that refills, a 503
   * is a provider having a minute, a timeout is a request that took longer than
   * this one was willing to wait — all worth a second attempt. A 400 naming a
   * model that does not exist, or a 401 on a rejected key, returns exactly the
   * same answer however long you wait, and sleeping on one turns a clear error
   * into a slow one.
   */
  retryable: boolean
}

/** The shape each connector implements — one request, one string back. */
type Connector = (
  config: SummarizerConfig,
  key: string,
  prompt: string,
) => Promise<Answer>

/**
 * How long any provider gets.
 *
 * Deliberately shorter than the `timeout-minutes: 15` on the generated step, so
 * a wedged endpoint is reported by cutver — which then publishes the notes as
 * written — rather than by GitHub killing the step and taking the release body
 * with it. A summariser is never allowed to be the reason a release has no
 * notes.
 *
 * **300s, because 120s was inside the working range rather than outside it.**
 * Measured across provider tiers on a five-commit release and a ~3,100 token
 * payload: a lite model answers in seconds, a mid tier in tens of seconds, and
 * a large one that writes its reasoning out first takes one to two minutes —
 * most of it spent on text `extractRelease` discards. The spread widens as
 * requests come closer together and per-minute token limits start to bind.
 *
 * At 120s the slowest tier sat one bad minute from falling back to unsummarised
 * notes, and a third of runs did. 300s clears the measured worst case five
 * times over and still fails long before GitHub kills the job.
 */
const TIMEOUT_MS = 300_000

/** Sent so a provider's rate-limit dashboard can name what is calling it. */
const AGENT = 'cutver (+https://cutver.okyle.dev)'

/**
 * One POST, one string back.
 *
 * The timeout, headers, error formatting and empty-answer check live here so
 * the three connectors differ only in the two things that actually differ: the
 * request body, and where the text sits in the response.
 *
 * `read` is typed loosely on purpose. Each connector knows its own response
 * shape and reaches into it with optional chaining, so a provider that changes
 * a field yields `undefined` and the "no text in the response" branch below —
 * never a crash mid-release.
 */
async function request<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  read: (json: T) => string | undefined,
): Promise<Answer> {
  let json: T
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': AGENT,
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      // The body, not just the status. A 400 from any of these three explains
      // itself — a bad model name, a malformed request — and printing only
      // "400" turns a two-second fix into a bisect. Truncated, because some
      // providers answer an error with a full HTML page.
      const detail = (await res.text().catch(() => ''))
        .slice(0, 300)
        .replace(/\s+/g, ' ')
        .trim()
      // 429 is a window that refills; 5xx is the provider having a minute.
      // Every other 4xx is a request that will be just as wrong in five.
      return {
        text: null,
        error: `${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
        retryable: res.status === 429 || res.status >= 500,
      }
    }

    json = (await res.json()) as T
  } catch (e) {
    const err = e as Error
    // `AbortSignal.timeout` rejects with a TimeoutError whose message reads
    // "signal is aborted without reason" — true, and useless in a release log.
    const why =
      err.name === 'TimeoutError'
        ? `no response in ${TIMEOUT_MS / 1000}s`
        : err.message
    // A timeout or a dropped connection says nothing about the request itself.
    return { text: null, error: why, retryable: true }
  }

  const text = read(json)?.trim()
  // A 200 with nothing usable in it. Reported rather than treated as an empty
  // summary, because "the model returned nothing" and "cutver could not find
  // the text in this response" are different bugs and only one of them is the
  // user's to fix.
  // A 200 whose body has no text in it. Not retryable: the request was
  // accepted and answered, and asking again produces the same shape.
  return text
    ? { text, error: null, retryable: false }
    : { text: null, error: 'no text in the response', retryable: false }
}

const CONNECTORS: Record<string, Connector> = {
  /**
   * Anthropic's Messages API.
   *
   * `max_tokens` is required here and nowhere else. 4096 is well clear of the
   * 300-word answer the prompt asks for, and low enough that a model ignoring
   * the prompt cannot run for minutes.
   */
  anthropic: (config, key, prompt) =>
    request(
      `${config.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      {
        model: config.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      },
      (json: { content?: { type?: string; text?: string }[] }) =>
        json.content?.find(b => b.type === 'text')?.text,
    ),

  /**
   * Anything speaking OpenAI's `/chat/completions`.
   *
   * `base_url` is required rather than defaulted: this connector's whole
   * purpose is pointing somewhere other than OpenAI, and silently defaulting to
   * `api.openai.com` would send a repository's notes to a provider it never
   * named.
   */
  'openai-compatible': (config, key, prompt) =>
    request(
      `${config.baseUrl}/chat/completions`,
      { authorization: `Bearer ${key}` },
      {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
      },
      (json: { choices?: { message?: { content?: string } }[] }) =>
        json.choices?.[0]?.message?.content,
    ),

  /**
   * Google's Generative Language API.
   *
   * The key goes in a header rather than the query string it also accepts:
   * a URL ends up in proxy logs, CI logs and error messages, and a header does
   * not.
   *
   * **`generateContent` rather than the Interactions API**, and checked rather
   * than assumed: Google's docs now label this one "Legacy" and recommend
   * `v1beta2/interactions` for new work. It is not deprecated, carries no
   * retirement date, and still takes `x-goog-api-key`. What Interactions adds
   * is server-side conversation history, typed execution steps and background
   * tasks — every one of which is state, and this is one stateless request that
   * sends a prompt and reads a paragraph back. Migrating would buy a longer
   * request body and a second thing to be wrong about.
   */
  gemini: (config, key, prompt) =>
    request(
      `${config.baseUrl ?? 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
      { 'x-goog-api-key': key },
      { contents: [{ parts: [{ text: prompt }] }] },
      (json: {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
      }) =>
        json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join(''),
    ),
}

/** The connector names a config may use, for validation and for error messages. */
export const CONNECTORS_AVAILABLE = Object.keys(CONNECTORS)

/**
 * Where each connector's key comes from. **The config never names it.**
 *
 * `CUTVER_SUMMARIZE_KEY` first, so CI has one name to set whatever the
 * connector is and a repository can switch providers without touching its
 * secrets. Then the provider's own conventional variable, so a laptop that
 * already exports `ANTHROPIC_API_KEY` needs no extra setup to cut a release by
 * hand.
 *
 * Both are environment-only. The config file is tracked and published; a key
 * belongs in CI secrets, where rotating it is not a commit.
 */
const KEY_ENV: Record<string, readonly string[]> = {
  anthropic: ['CUTVER_SUMMARIZE_KEY', 'ANTHROPIC_API_KEY'],
  'openai-compatible': ['CUTVER_SUMMARIZE_KEY', 'OPENAI_API_KEY'],
  gemini: ['CUTVER_SUMMARIZE_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
}

export interface Key {
  value: string | null
  /** Every name that was tried, for an error message someone can act on. */
  tried: readonly string[]
}

/** The key for a connector, and the variables it looked in. */
export function keyFor(
  connector: string,
  env: Record<string, string | undefined>,
): Key {
  const tried = KEY_ENV[connector] ?? ['CUTVER_SUMMARIZE_KEY']
  for (const name of tried) {
    const value = env[name]?.trim()
    if (value) return { value, tried }
  }
  return { value: null, tried }
}

/**
 * Run the configured connector.
 *
 * Never throws. Every failure — a bad key, a wrong model name, a timeout, a
 * provider outage — comes back as `error`, and the caller publishes the notes
 * as written. That invariant is older than this file and is the reason the
 * feature is safe to switch on.
 */
export async function ask(
  config: SummarizerConfig,
  key: string,
  prompt: string,
): Promise<Answer> {
  const connector = CONNECTORS[config.connector]
  if (!connector) {
    return {
      text: null,
      error: `unknown connector \`${config.connector}\` — expected ${CONNECTORS_AVAILABLE.join(', ')}`,
      // A config error. Waiting will not add the connector.
      retryable: false,
    }
  }
  return connector(config, key, prompt)
}
