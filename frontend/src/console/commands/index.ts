// Registro único de comandos: parser, execução, autocompletar, help e docs/console.md.

import type { CommandDef } from '../types'
import { infoCommands } from './info'
import { manageCommands } from './manage'
import { miscCommands } from './misc'
import { powerCommands } from './power'
import { scheduleCommands } from './schedules'

export const COMMANDS: CommandDef[] = [
  ...powerCommands,
  ...infoCommands,
  ...scheduleCommands,
  ...manageCommands,
  ...miscCommands,
]
