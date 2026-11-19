//! Consulta do histórico de operações (auditoria).

use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::ports::{HistoryEntry, HistoryFilter, OperationRepository, Page};

pub const DEFAULT_PER_PAGE: u32 = 50;
pub const MAX_PER_PAGE: u32 = 200;

pub struct HistoryService {
    operations: Arc<dyn OperationRepository>,
}

impl HistoryService {
    pub fn new(operations: Arc<dyn OperationRepository>) -> Self {
        Self { operations }
    }

    /// Itens do mais recente para o mais antigo; período invertido é recusado.
    pub async fn query(
        &self,
        filter: &HistoryFilter,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> AppResult<Page<HistoryEntry>> {
        if let (Some(from), Some(to)) = (filter.from, filter.to)
            && from > to
        {
            return Err(AppError::Validation(
                "a data inicial é posterior à final".into(),
            ));
        }
        let page = page.unwrap_or(1);
        if page == 0 {
            return Err(AppError::Validation("a página começa em 1".into()));
        }
        let per_page = per_page.unwrap_or(DEFAULT_PER_PAGE);
        if per_page == 0 || per_page > MAX_PER_PAGE {
            return Err(AppError::Validation(format!(
                "itens por página: entre 1 e {MAX_PER_PAGE}"
            )));
        }
        Ok(self.operations.history(filter, page, per_page).await?)
    }
}
