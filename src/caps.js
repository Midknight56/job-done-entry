// @ts-check
// Every cap in the app, with the arithmetic that keeps a free user at $0.
//
// The rule: a judge is a free user and must cost nothing. Workers AI gives "10,000 Neurons per day at no charge"
// (Cloudflare pricing page, read 22 Oct 2026). On the Workers Free plan a call past that fails instead of billing.
// The allocation is one pool for every Worker on the account, so this app takes a share, counts every call in the
// shared ledger before it is made, reserves a conservative estimate, and records real usage upward.

// Prices read 22 Oct 2026 from developers.cloudflare.com/workers-ai/platform/pricing.
export const NEURONS_PER_AUDIO_MINUTE = 46.63 // @cf/openai/whisper-large-v3-turbo
export const NEURONS_PER_M_INPUT = 4625 // @cf/qwen/qwen3-30b-a3b-fp8, per million input tokens
export const NEURONS_PER_M_OUTPUT = 30475 // the same model, per million output tokens

// Measured 24 Oct 2026: 3,536 characters gave 1,168 input tokens, or 3.03 characters per token.
// Reserving at 2.5 characters per token is about 17% below the measured ratio, plus chat formatting.
// One typical step with 3,536 characters, 6 messages and 500 output tokens reserves
// (ceil(3,536 / 2.5) + 6 x 32 + 32 + 10) x 4,625 / 1,000,000 + 500 x 30,475 / 1,000,000
// = 22.864125 neurons. A 12-call demo reserves 274.3695; 550 / 274.3695 = 2.00 runs per visitor.
// At the measured settled cost, 2,000 / (7.03 x 1.10 x 12) = 21.55 runs per app day, still $0.
// Real usage is recorded upward, and the next call is refused once a cap is reached.
// The account cap of 9,500 leaves 500 under the free 10,000. At MAX_INPUT_CHARS and 6 messages,
// stepWorstCase reserves 34.81975 neurons per call; this is an estimate, not a hard token bound.
export const CHARS_PER_TOKEN_RESERVE = 2.5
export const CHAT_MESSAGE_TOKENS = 32
export const CHAT_REPLY_TOKENS = 32
// Count the appended suffix as 10 tokens: 10 x 4,625 / 1,000,000 = 0.04625 neurons.
export const REQUEST_SUFFIX = ' /no_think'

// Speech: 30 s at most. 0.5 min x 46.63 = 23.32 neurons per clip at most.
export const MAX_AUDIO_SECONDS = 30
// The page sends 16 kHz mono 16 bit WAV: 32,000 bytes a second, so 30 s is 960,044 bytes. 1 MiB leaves room for
// the header and refuses anything bigger before it is read.
export const MAX_AUDIO_BYTES = 1048576

// Limit message contents by JavaScript string length. Every reservation precedes its call.
export const MAX_INPUT_CHARS = 10000
export const MAX_OUTPUT_TOKENS = 500
// Two steps a turn (tool calls, then the proposal), and one more call only when a reply was not valid JSON:
export const MAX_STEPS = 2
export const MAX_MODEL_CALLS = 3

// This app's share of the free day: 2,000 neurons (set 24 Oct 2026). The shares of the account's 9,500 cap:
// Gift Scout 2,000 + Running Tab 1,500 + Job Done 2,000 + Circlekeeper 700 + Dispute Desk 700 = 6,900, under 9,500 and
// under the free 10,000, so it stays $0.
export const DAILY_NEURONS = 2000
// One visitor's unchanged share is 550 neurons.
// Visitor counters retain the greater of reserved and reported usage with the settlement margin.
export const PER_IP_NEURONS = 550
// The whole account stops at 9,500 of its free 10,000, as a margin for counting gaps between Workers.
export const ACCOUNT_NEURONS = 9500

// KV on the Free plan allows "1,000 writes per day" (Cloudflare KV limits page, read 22 Oct 2026).
// 250 actions x 3 writes (workspace, visitor counter, day counter) = 750, plus 60 webhooks x 2 writes = 120:
// 870 writes a day, under 1,000.
export const DAILY_ACTIONS = 250
export const PER_IP_ACTIONS = 40
// PayPal sandbox calls cost nothing. These keep KV writes and the sandbox rate limit in bounds.
export const DAILY_INVOICES = 60
export const PER_IP_INVOICES = 8
export const DAILY_WORKSPACES = 20
// The maintainer's own test demos, counted apart so they never use the visitors' demos.
export const DAILY_MAINTAINER_WORKSPACES = 60

// An invoice due on receipt that is still open this many days after it was sent is shown as late.
export const LATE_DAYS = 7

/** A conservative step reservation. @param {number} inputChars @param {number} maxTokens @param {number} [messageCount] */
export function stepWorstCase(inputChars, maxTokens, messageCount = 6) {
  const tokens = Math.ceil(inputChars / CHARS_PER_TOKEN_RESERVE) + messageCount * CHAT_MESSAGE_TOKENS + CHAT_REPLY_TOKENS + 10
  return tokens * NEURONS_PER_M_INPUT / 1e6 + Math.min(maxTokens, MAX_OUTPUT_TOKENS) * NEURONS_PER_M_OUTPUT / 1e6
}

/** The most a clip of this length can cost. @param {number} seconds */
export function audioWorstCase(seconds) {
  return seconds / 60 * NEURONS_PER_AUDIO_MINUTE
}

/** What a finished call really cost, from the token counts Workers AI returns; null when it gave none. */
export function actualNeurons(/** @type {{prompt_tokens?: number, completion_tokens?: number} | null | undefined} */ usage) {
  if (!usage || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') return null
  if (!Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens) || usage.prompt_tokens < 0 || usage.completion_tokens < 0) return null
  return usage.prompt_tokens * NEURONS_PER_M_INPUT / 1e6 + usage.completion_tokens * NEURONS_PER_M_OUTPUT / 1e6
}
