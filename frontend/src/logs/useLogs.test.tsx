import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LogLine } from '../api/types'
import { mockFetch } from '../test/utils'
import { POLL_BASE_MS, useLogs } from './useLogs'

const line = (second: number, message: string): LogLine => ({
  timestamp: `2026-11-18T10:00:${String(second).padStart(2, '0')}.000Z`,
  severity: 'info',
  message,
})

const reply = (lines: LogLine[]) => ({
  deployment_id: 'd-1',
  deployment_status: 'SUCCESS',
  is_current: true,
  truncated: false,
  lines,
})

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

const logUrls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('/logs'))

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  setVisibility('visible')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useLogs', () => {
  it('traz novas linhas ao final sem duplicar as anteriores', async () => {
    let n = 0
    const calls = mockFetch({
      'GET /api/instances/i-1/logs': () => {
        n += 1
        return { json: reply(n === 1 ? [line(1, 'a'), line(2, 'b')] : [line(2, 'b'), line(3, 'c')]) }
      },
    })
    const { result } = renderHook(() => useLogs({ instanceId: 'i-1', filters: {}, live: true }))
    await waitFor(() => expect(result.current.lines).toHaveLength(2))
    await advance(POLL_BASE_MS + 10)
    await waitFor(() => expect(result.current.lines.map((l) => l.message)).toEqual(['a', 'b', 'c']))
    // A consulta incremental começa 1 s antes da última linha recebida.
    const second = new URL(logUrls(calls)[1].url, 'http://x').searchParams.get('start')
    expect(second).toBe('2026-11-18T10:00:01.000Z')
  })

  it('pausa: nenhuma consulta nova até retomar', async () => {
    const calls = mockFetch({ 'GET /api/instances/i-1/logs': reply([line(1, 'a')]) })
    const { result } = renderHook(() => useLogs({ instanceId: 'i-1', filters: {}, live: true }))
    await waitFor(() => expect(result.current.lines).toHaveLength(1))
    act(() => result.current.setPaused(true))
    const before = logUrls(calls).length
    await advance(POLL_BASE_MS * 5)
    expect(logUrls(calls)).toHaveLength(before)
    act(() => result.current.setPaused(false))
    await advance(POLL_BASE_MS + 10)
    await waitFor(() => expect(logUrls(calls).length).toBeGreaterThan(before))
  })

  it('suspende com a aba oculta e retoma ao voltar', async () => {
    const calls = mockFetch({ 'GET /api/instances/i-1/logs': reply([line(1, 'a')]) })
    const { result } = renderHook(() => useLogs({ instanceId: 'i-1', filters: {}, live: true }))
    await waitFor(() => expect(result.current.lines).toHaveLength(1))
    act(() => setVisibility('hidden'))
    const before = logUrls(calls).length
    await advance(POLL_BASE_MS * 5)
    expect(logUrls(calls)).toHaveLength(before)
    act(() => setVisibility('visible'))
    await advance(POLL_BASE_MS + 10)
    await waitFor(() => expect(logUrls(calls).length).toBeGreaterThan(before))
  })

  it('no 429 mantém as linhas, avisa e tenta de novo após o intervalo indicado', async () => {
    let n = 0
    const calls = mockFetch({
      'GET /api/instances/i-1/logs': () => {
        n += 1
        if (n === 2) return { status: 429, json: { code: 'rate_limited', message: 'limite', details: { retry_after_secs: 10 } } }
        return { json: reply([line(1, 'a')]) }
      },
    })
    const { result } = renderHook(() => useLogs({ instanceId: 'i-1', filters: {}, live: true }))
    await waitFor(() => expect(result.current.lines).toHaveLength(1))
    await advance(POLL_BASE_MS + 10)
    await waitFor(() => expect(result.current.notice).toMatch(/Limite de requisições.*10s/))
    expect(result.current.lines).toHaveLength(1)
    const failedAt = logUrls(calls).length
    await advance(9000)
    expect(logUrls(calls)).toHaveLength(failedAt)
    await advance(1500)
    await waitFor(() => expect(logUrls(calls).length).toBeGreaterThan(failedAt))
    await waitFor(() => expect(result.current.notice).toBeNull())
  })

  it('sem acompanhamento ao vivo faz só a consulta inicial', async () => {
    const calls = mockFetch({ 'GET /api/instances/i-1/logs': reply([line(1, 'a')]) })
    const { result } = renderHook(() => useLogs({ instanceId: 'i-1', filters: { type: 'build' }, live: false }))
    await waitFor(() => expect(result.current.lines).toHaveLength(1))
    await advance(POLL_BASE_MS * 5)
    expect(logUrls(calls)).toHaveLength(1)
    expect(logUrls(calls)[0].url).toContain('type=build')
  })

  it('falha na consulta inicial expõe o erro', async () => {
    mockFetch({
      'GET /api/instances/i-1/logs': () => ({ status: 409, json: { code: 'credential_invalid', message: 'token recusado' } }),
    })
    const { result } = renderHook(() => useLogs({ instanceId: 'i-1', filters: {}, live: true }))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.lines).toEqual([])
  })
})
