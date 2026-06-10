import { createHmac } from 'crypto'
import { eventBus } from './processor.js'
import type { MaritimeEvent } from '@maritime/core'

// Read env at dispatch time so environment can be changed in tests without re-importing
function getConfig() {
  return {
    urls:   (process.env['WEBHOOK_URLS'] ?? '').split(',').filter(Boolean),
    secret: process.env['WEBHOOK_SECRET'] ?? '',
  }
}

export function sign(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex')
}

export async function dispatch(evt: MaritimeEvent): Promise<void> {
  const { urls, secret } = getConfig()
  if (!urls.length) return
  const body = JSON.stringify(evt)
  const sig  = sign(body, secret)
  await Promise.allSettled(
    urls.map(url =>
      fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':         'application/json',
          'X-Maritime-Signature': sig,
          'X-Maritime-Event':     evt.event,
        },
        body,
      }).catch(err => console.warn(`[webhook] delivery failed to ${url}:`, err.message))
    )
  )
}

export function setupWebhooks(): void {
  eventBus.on('event', (evt: MaritimeEvent) => {
    dispatch(evt).catch(err => console.error('[webhook] error', err))
  })
  const { urls } = getConfig()
  if (urls.length) console.log(`[webhooks] registered for ${urls.length} endpoint(s)`)
}
