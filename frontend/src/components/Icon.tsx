// Ícones da interface (Phosphor, peso "regular"): traço humanista, bem diferente do conjunto genérico de contornos.

import {
  Article,
  CalendarDots,
  CaretRight,
  Check,
  ClockCounterClockwise,
  Funnel,
  MagnifyingGlass,
  Moon,
  type Icon as PhosphorIcon,
  SignOut,
  SlidersHorizontal,
  Square,
  SquaresFour,
  Stack,
  Sun,
  TerminalWindow,
  X,
} from '@phosphor-icons/react'

const ICONS = {
  overview: SquaresFour,
  projects: Stack,
  schedules: CalendarDots,
  history: ClockCounterClockwise,
  logs: Article,
  settings: SlidersHorizontal,
  console: TerminalWindow,
  logout: SignOut,
  search: MagnifyingGlass,
  sun: Sun,
  moon: Moon,
  check: Check,
  filter: Funnel,
  chevron: CaretRight,
  close: X,
  stop: Square,
} satisfies Record<string, PhosphorIcon>

export type IconName = keyof typeof ICONS

export function Icon({ name }: { name: IconName }) {
  const Glyph = ICONS[name]
  return <Glyph className="icon" aria-hidden="true" />
}
