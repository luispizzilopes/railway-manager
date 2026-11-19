//! Fakes de usuários, sessões e hash de senha.

use std::sync::Mutex;

use async_trait::async_trait;

/// Repositório de usuários em memória.
#[derive(Default)]
pub struct FakeUsers {
    rows: Mutex<Vec<(domain::user::User, String)>>,
}

#[async_trait]
impl crate::ports::UserRepository for FakeUsers {
    async fn insert(&self, user: &domain::user::User, hash: &str) -> crate::ports::RepoResult<()> {
        let mut rows = self.rows.lock().unwrap();
        if rows
            .iter()
            .any(|(u, _)| u.username.key() == user.username.key())
        {
            return Err(crate::ports::RepoError::Conflict("nome em uso".into()));
        }
        rows.push((user.clone(), hash.to_owned()));
        Ok(())
    }

    async fn list(&self) -> crate::ports::RepoResult<Vec<domain::user::User>> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .iter()
            .map(|(u, _)| u.clone())
            .collect())
    }

    async fn get(
        &self,
        id: domain::ids::UserId,
    ) -> crate::ports::RepoResult<Option<domain::user::User>> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .iter()
            .find(|(u, _)| u.id == id)
            .map(|(u, _)| u.clone()))
    }

    async fn find_credentials(
        &self,
        key: &str,
    ) -> crate::ports::RepoResult<Option<crate::ports::UserCredentials>> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .iter()
            .find(|(u, _)| u.username.key() == key)
            .map(|(u, h)| crate::ports::UserCredentials {
                user: u.clone(),
                password_hash: h.clone(),
            }))
    }

    async fn update(
        &self,
        id: domain::ids::UserId,
        role: domain::user::Role,
        is_active: bool,
        now: chrono::DateTime<chrono::Utc>,
    ) -> crate::ports::RepoResult<()> {
        let mut rows = self.rows.lock().unwrap();
        let (user, _) = rows
            .iter_mut()
            .find(|(u, _)| u.id == id)
            .ok_or(crate::ports::RepoError::NotFound)?;
        user.role = role;
        user.is_active = is_active;
        user.updated_at = now;
        Ok(())
    }

    async fn set_password_hash(
        &self,
        id: domain::ids::UserId,
        hash: &str,
        _now: chrono::DateTime<chrono::Utc>,
    ) -> crate::ports::RepoResult<()> {
        let mut rows = self.rows.lock().unwrap();
        let (_, stored) = rows
            .iter_mut()
            .find(|(u, _)| u.id == id)
            .ok_or(crate::ports::RepoError::NotFound)?;
        *stored = hash.to_owned();
        Ok(())
    }

    async fn delete(&self, id: domain::ids::UserId) -> crate::ports::RepoResult<()> {
        let mut rows = self.rows.lock().unwrap();
        let before = rows.len();
        rows.retain(|(u, _)| u.id != id);
        if rows.len() == before {
            return Err(crate::ports::RepoError::NotFound);
        }
        Ok(())
    }
}

/// Sessões em memória que registram os usuários cujas sessões foram encerradas.
#[derive(Default)]
pub struct FakeSessions {
    pub closed_for: Mutex<Vec<domain::ids::UserId>>,
}

#[async_trait]
impl crate::ports::SessionRepository for FakeSessions {
    async fn create(
        &self,
        _id_hash: &str,
        _user_id: Option<domain::ids::UserId>,
        _created_at: chrono::DateTime<chrono::Utc>,
        _expires_at: chrono::DateTime<chrono::Utc>,
    ) -> crate::ports::RepoResult<()> {
        Ok(())
    }

    async fn resolve(
        &self,
        _id_hash: &str,
        _now: chrono::DateTime<chrono::Utc>,
    ) -> crate::ports::RepoResult<Option<crate::ports::SessionOwner>> {
        Ok(None)
    }

    async fn delete(&self, _id_hash: &str) -> crate::ports::RepoResult<()> {
        Ok(())
    }

    async fn delete_for_user(&self, user_id: domain::ids::UserId) -> crate::ports::RepoResult<()> {
        self.closed_for.lock().unwrap().push(user_id);
        Ok(())
    }

    async fn purge_expired(
        &self,
        _now: chrono::DateTime<chrono::Utc>,
    ) -> crate::ports::RepoResult<u64> {
        Ok(0)
    }
}

/// "Hash" reversível, só para testes.
pub struct PlainHasher;

impl crate::ports::PasswordHasher for PlainHasher {
    fn hash(&self, password: &str) -> Result<String, String> {
        Ok(format!("hash:{password}"))
    }

    fn verify(&self, password: &str, hash: &str) -> bool {
        hash == format!("hash:{password}")
    }

    fn verify_dummy(&self, _password: &str) {}
}
