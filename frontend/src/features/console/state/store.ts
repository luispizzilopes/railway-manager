// Armazenamento do navegador para o console: falhas (modo privado, cota, bloqueio)
// viram "sem persistência", nunca erro.

import type { Store } from './types'

const PREFIX = 'rm:console:'

export function browserStore(storage: () => Storage = () => window.localStorage): Store {
  return {
    get<T>(key: string, fallback: T): T {
      try {
        const raw = storage().getItem(PREFIX + key)
        return raw === null ? fallback : (JSON.parse(raw) as T)
      } catch {
        return fallback
      }
    },
    set(key: string, value: unknown) {
      try {
        storage().setItem(PREFIX + key, JSON.stringify(value))
      } catch {
        // sem persistência
      }
    },
    remove(key: string) {
      try {
        storage().removeItem(PREFIX + key)
      } catch {
        // sem persistência
      }
    },
  }
}

export function memoryStore(): Store {
  const data = new Map<string, string>()
  return {
    get: <T,>(key: string, fallback: T) => (data.has(key) ? (JSON.parse(data.get(key)!) as T) : fallback),
    set: (key, value) => void data.set(key, JSON.stringify(value)),
    remove: (key) => void data.delete(key),
  }
}
