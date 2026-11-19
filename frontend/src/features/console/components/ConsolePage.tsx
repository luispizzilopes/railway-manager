import { Trans, useTranslation } from 'react-i18next'

import { Console } from './Console'

export function ConsolePage() {
  const { t } = useTranslation('console')
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('m.ui.consoleTitle')}</h1>
          <p className="muted">
            <Trans t={t} i18nKey="m.ui.pageIntro" components={{ 1: <code /> }} />
          </p>
        </div>
      </div>
      <Console variant="page" />
    </>
  )
}
