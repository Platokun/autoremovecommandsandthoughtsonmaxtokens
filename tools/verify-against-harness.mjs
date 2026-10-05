/**
 * Verify this plugin's tool contracts against the real harness schemas.
 *
 * The plugin imports nothing from DSH on purpose, so this script supplies the
 * validator from a local checkout instead. Run it from anywhere:
 *
 *   DSH_CHECKOUT=/home/naruzkurai/deepseek-harness \
 *     node tools/verify-against-harness.mjs
 *
 * It checks that every registered tool's `parameters` and `output.schema` are
 * inside the harness's enforced JSON-Schema subset, and that a representative
 * canonical output value validates against its declared schema.
 */

import { pathToFileURL } from 'node:url'
import path from 'node:path'

import { apply } from '../index.js'

const checkout = process.env.DSH_CHECKOUT ?? '/home/naruzkurai/deepseek-harness'
const toolsLib = path.join(checkout, 'packages/core/tools/lib/index.js')
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(toolsLib).href)

const tools = new Map()
const ctx = {
  tools: { register: definition => { tools.set(definition.name, definition); return () => {} } },
  on: () => () => {},
  inject: (_deps, callback) => callback(ctx),
  get: () => undefined,
  llm: { stream: () => ({}) },
  sessions: { get: () => undefined },
  systemPrompt: { variable: () => {}, section: () => {} },
  logger: { warn: () => {} },
}

apply(ctx, {})

/** One canonical value per tool, used to exercise the output schema. */
const samples = {
  rewrite_memory: { applied: true, summary: 'Recorded. 3 older message(s) are replaced by "rwm-note".' },
  rwm_access: {
    granted: true,
    text: '--- 3 (tool) ---\n{"command":"ls"}',
    lock: '3: only mentions 2023; rows for September.',
    chars: 40,
  },
}

let failures = 0
for (const [name, definition] of tools) {
  for (const [label, schema] of [['parameters', definition.parameters], ['output.schema', definition.output.schema]]) {
    try {
      assertSupportedJsonSchema(schema)
      console.log(`ok   ${name}.${label}`)
    } catch (error) {
      failures += 1
      console.error(`FAIL ${name}.${label}: ${error.message}`)
    }
  }
  const sample = samples[name]
  if (sample === undefined) {
    failures += 1
    console.error(`FAIL ${name}: no sample output value declared in this script`)
    continue
  }
  const violations = validateJsonSchemaValue(definition.output.schema, sample, name)
  if (Array.isArray(violations) && violations.length > 0) {
    failures += 1
    console.error(`FAIL ${name}.output value: ${JSON.stringify(violations)}`)
  } else {
    console.log(`ok   ${name}.output value`)
  }
  /* The renderer must produce model-facing text blocks for the same value. */
  const rendered = definition.output.render({}, sample)
  if (!Array.isArray(rendered) || rendered.some(block => block?.type !== 'text' || typeof block.text !== 'string')) {
    failures += 1
    console.error(`FAIL ${name}.output.render: expected text content blocks`)
  } else {
    console.log(`ok   ${name}.output.render`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} contract failure(s)`)
  process.exitCode = 1
} else {
  console.log(`\nAll ${tools.size} tool contracts verified against ${checkout}`)
}
