// Catálogos de tradução. O `pt-BR` é a fonte da verdade dos tipos das chaves.
// Ao criar um namespace novo, registre-o nos dois idiomas.

import enAuth from './locales/en/auth.json'
import enSettings from './locales/en/settings.json'
import enDashboard from './locales/en/dashboard.json'
import enProjects from './locales/en/projects.json'
import enSchedules from './locales/en/schedules.json'
import enHistory from './locales/en/history.json'
import enLogs from './locales/en/logs.json'
import enUsers from './locales/en/users.json'
import enConsole from './locales/en/console.json'
import enCommon from './locales/en/common.json'
import enErrors from './locales/en/errors.json'
import ptAuth from './locales/pt-BR/auth.json'
import ptSettings from './locales/pt-BR/settings.json'
import ptDashboard from './locales/pt-BR/dashboard.json'
import ptProjects from './locales/pt-BR/projects.json'
import ptSchedules from './locales/pt-BR/schedules.json'
import ptHistory from './locales/pt-BR/history.json'
import ptLogs from './locales/pt-BR/logs.json'
import ptUsers from './locales/pt-BR/users.json'
import ptConsole from './locales/pt-BR/console.json'
import ptCommon from './locales/pt-BR/common.json'
import ptErrors from './locales/pt-BR/errors.json'

export const resources = {
  'pt-BR': { auth: ptAuth, console: ptConsole, users: ptUsers, logs: ptLogs, history: ptHistory, schedules: ptSchedules, projects: ptProjects, dashboard: ptDashboard, settings: ptSettings, common: ptCommon, errors: ptErrors },
  en: { auth: enAuth, console: enConsole, users: enUsers, logs: enLogs, history: enHistory, schedules: enSchedules, projects: enProjects, dashboard: enDashboard, settings: enSettings, common: enCommon, errors: enErrors },
} as const
