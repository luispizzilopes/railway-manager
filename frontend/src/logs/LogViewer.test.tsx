import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api/client'
import type { LogLine } from '../api/types'
import { renderWithProviders } from '../test/utils'
import { LogViewer } from './LogViewer'

const line = (second: number, message: string, severity: LogLine['severity'] = 'info'): LogLine => ({
  timestamp: `2026-11-18T10:00:${String(second).padStart(2, '0')}.000Z`,
  severity,
  message,
})

afterEach(() => vi.unstubAllGlobals())

describe('LogViewer', () => {
  it('exibe HTML da mensagem como texto, sem interpretá-lo', () => {
    renderWithProviders(<LogViewer lines={[line(1, '<script>alert(1)</script><b>x</b>')]} />)
    const log = screen.getByRole('log')
    expect(log).toHaveTextContent('<script>alert(1)</script><b>x</b>')
    expect(log.querySelector('script')).toBeNull()
    expect(log.querySelector('b')).toBeNull()
  })

  it('remove códigos ANSI e mostra a severidade por texto', () => {
    renderWithProviders(<LogViewer lines={[line(1, '\u001B[31mfalhou\u001B[0m', 'error')]} />)
    const log = screen.getByRole('log')
    expect(log).toHaveTextContent('falhou')
    expect(log).not.toHaveTextContent('[31m')
    expect(log).toHaveTextContent('ERRO')
  })

  it('destaca as ocorrências da busca e conta quantas são', async () => {
    renderWithProviders(<LogViewer lines={[line(1, 'Erro de rede'), line(2, 'erro de disco, erro final')]} />)
    await userEvent.type(screen.getByLabelText('Buscar nos logs exibidos'), 'ERRO')
    expect(screen.getByRole('log').querySelectorAll('mark')).toHaveLength(3)
    expect(screen.getByText(/3 ocorrências/)).toBeInTheDocument()
  })

  it('baixa o trecho exibido como texto, uma linha por registro', async () => {
    let blob: Blob | undefined
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => {
        blob = b
        return 'blob:x'
      },
      revokeObjectURL: () => undefined,
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    renderWithProviders(<LogViewer lines={[line(1, 'ok'), line(2, 'ruim', 'error')]} fileName="loja-api" />)
    await userEvent.click(screen.getByRole('button', { name: 'Baixar' }))
    expect(click).toHaveBeenCalled()
    expect(await blob?.text()).toBe('2026-11-18T10:00:01.000Z [INFO] ok\n2026-11-18T10:00:02.000Z [ERROR] ruim')
    click.mockRestore()
  })

  it('copia o trecho para a área de transferência', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderWithProviders(<LogViewer lines={[line(1, 'ok')]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copiar' }))
    expect(writeText).toHaveBeenCalledWith('2026-11-18T10:00:01.000Z [INFO] ok')
  })

  it('sem logs no período sugere ampliar o intervalo', () => {
    renderWithProviders(<LogViewer lines={[]} />)
    expect(screen.getByText('Nenhum log no período')).toBeInTheDocument()
    expect(screen.getByText(/Amplie o intervalo/)).toBeInTheDocument()
  })

  it('serviço sem deploy tem mensagem própria', () => {
    renderWithProviders(<LogViewer lines={[]} noDeployment />)
    expect(screen.getByText('Nenhum deploy ainda')).toBeInTheDocument()
  })

  it('token recusado leva à tela de Configurações', () => {
    const error = new ApiError(409, { code: 'credential_invalid', message: 'O token foi revogado.' })
    renderWithProviders(<LogViewer lines={[]} error={error} />)
    expect(screen.getByRole('alert')).toHaveTextContent('credencial do Railway foi recusada')
    expect(screen.getByRole('link', { name: 'Ir para Configurações' })).toHaveAttribute('href', '/settings')
  })

  it('Railway indisponível tem mensagem própria e permite tentar de novo', async () => {
    const retry = vi.fn()
    const error = new ApiError(503, { code: 'railway_unavailable', message: 'timeout' })
    renderWithProviders(<LogViewer lines={[]} error={error} onRetry={retry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('O Railway está indisponível')
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(retry).toHaveBeenCalled()
  })

  it('falha ao acompanhar não apaga as linhas já exibidas', () => {
    const error = new ApiError(503, { code: 'railway_unavailable', message: 'x' })
    renderWithProviders(<LogViewer lines={[line(1, 'continua aqui')]} error={error} notice="Nova tentativa em 6s." />)
    expect(screen.getByRole('log')).toHaveTextContent('continua aqui')
    expect(screen.getByText('Nova tentativa em 6s.')).toBeInTheDocument()
  })

  it('corta linhas muito longas com "ver mais"', async () => {
    renderWithProviders(<LogViewer lines={[line(1, 'x'.repeat(5000))]} />)
    expect(screen.getByRole('log').textContent).not.toContain('x'.repeat(2001))
    await userEvent.click(screen.getByRole('button', { name: /ver mais/ }))
    expect(screen.getByRole('log').textContent).toContain('x'.repeat(5000))
  })

  it('avisa quando só as linhas mais recentes foram carregadas', () => {
    renderWithProviders(<LogViewer lines={[line(1, 'a')]} truncated />)
    expect(screen.getByText(/só as mais recentes/)).toBeInTheDocument()
  })
})
