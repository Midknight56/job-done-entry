import { MODEL } from '../src/ai/model.js'
import { WHISPER } from '../src/ai/whisper.js'
import { pathToFileURL } from 'node:url'

export const MODEL_IDS = [MODEL, WHISPER]

export function modelPageUrl(id) {
  return `https://developers.cloudflare.com/workers-ai/models/${id.split('/').at(-1)}/`
}

export function retirementLine(html) {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
  return text.match(/(?:Planned\s+Deprecation|Deprecated)(?:\s+\d{1,2}\/\d{1,2}\/\d{4})?/i)?.[0]?.trim() ?? null
}

export async function checkModels(fetchImpl = fetch) {
  const problems = []
  for (const id of MODEL_IDS) {
    let response
    try {
      response = await fetchImpl(modelPageUrl(id))
    } catch {
      problems.push(`${id}: could not read the model page`)
      continue
    }
    if (response.status !== 200) {
      problems.push(`${id}: could not read the model page`)
      continue
    }
    let line
    try {
      line = retirementLine(await response.text())
    } catch {
      problems.push(`${id}: could not read the model page`)
      continue
    }
    if (line) problems.push(`${id}: ${line}`)
  }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = await checkModels()
  for (const id of MODEL_IDS) {
    const problem = problems.find(entry => entry.startsWith(`${id}:`))
    console.log(problem ? `problem ${problem}` : `ok ${id}`)
  }
  if (problems.length) process.exitCode = 1
}
