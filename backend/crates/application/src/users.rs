//! Cadastro de usuários comuns (o master vive no ambiente, fora do banco).

use std::sync::Arc;

use domain::ids::UserId;
use domain::user::{MIN_PASSWORD_LEN, Role, User, Username, key_of};

use crate::error::{AppError, AppResult};
use crate::ports::{Clock, PasswordHasher, SessionRepository, UserRepository};

pub struct CreateUser {
    pub username: String,
    pub password: String,
    pub role: Role,
}

#[derive(Default)]
pub struct UpdateUser {
    pub role: Option<Role>,
    pub is_active: Option<bool>,
}

pub struct UserService {
    users: Arc<dyn UserRepository>,
    sessions: Arc<dyn SessionRepository>,
    hasher: Arc<dyn PasswordHasher>,
    clock: Arc<dyn Clock>,
    master_username: String,
}

impl UserService {
    pub fn new(
        users: Arc<dyn UserRepository>,
        sessions: Arc<dyn SessionRepository>,
        hasher: Arc<dyn PasswordHasher>,
        clock: Arc<dyn Clock>,
        master_username: &str,
    ) -> Self {
        Self {
            users,
            sessions,
            hasher,
            clock,
            master_username: master_username.to_owned(),
        }
    }

    pub async fn list(&self) -> AppResult<Vec<User>> {
        Ok(self.users.list().await?)
    }

    pub async fn create(&self, input: CreateUser) -> AppResult<User> {
        let username =
            Username::parse(&input.username).map_err(|e| AppError::Validation(e.to_string()))?;
        validate_password(&input.password)?;
        ensure_assignable(input.role)?;
        if username.key() == key_of(&self.master_username) {
            return Err(AppError::Conflict(
                "este nome é reservado ao usuário master".into(),
            ));
        }
        let hash = self.hash(&input.password)?;
        let now = self.clock.now();
        let user = User {
            id: UserId::new(),
            username,
            role: input.role,
            is_active: true,
            created_at: now,
            updated_at: now,
        };
        self.users.insert(&user, &hash).await.map_err(|e| match e {
            crate::ports::RepoError::Conflict(_) => {
                AppError::Conflict("já existe um usuário com este nome".into())
            }
            other => other.into(),
        })?;
        Ok(user)
    }

    pub async fn update(&self, id: UserId, changes: UpdateUser) -> AppResult<User> {
        let current = self.get(id).await?;
        let role = changes.role.unwrap_or(current.role);
        ensure_assignable(role)?;
        let is_active = changes.is_active.unwrap_or(current.is_active);
        let now = self.clock.now();
        self.users.update(id, role, is_active, now).await?;
        if !is_active {
            self.sessions.delete_for_user(id).await?;
        }
        Ok(User {
            role,
            is_active,
            updated_at: now,
            ..current
        })
    }

    pub async fn set_password(&self, id: UserId, password: &str) -> AppResult<()> {
        validate_password(password)?;
        self.get(id).await?;
        let hash = self.hash(password)?;
        self.users
            .set_password_hash(id, &hash, self.clock.now())
            .await?;
        self.sessions.delete_for_user(id).await?;
        Ok(())
    }

    pub async fn delete(&self, id: UserId) -> AppResult<()> {
        self.get(id).await?;
        self.sessions.delete_for_user(id).await?;
        self.users.delete(id).await?;
        Ok(())
    }

    /// Confere nome e senha de um usuário cadastrado. `None` para nome inexistente,
    /// usuário inativo ou senha errada, sem distinguir os casos.
    pub async fn authenticate(&self, username: &str, password: &str) -> AppResult<Option<User>> {
        let Some(found) = self.users.find_credentials(&key_of(username)).await? else {
            self.hasher.verify_dummy(password);
            return Ok(None);
        };
        let valid = self.hasher.verify(password, &found.password_hash);
        Ok((valid && found.user.is_active).then_some(found.user))
    }

    async fn get(&self, id: UserId) -> AppResult<User> {
        self.users
            .get(id)
            .await?
            .ok_or_else(|| AppError::NotFound("usuário não encontrado".into()))
    }

    fn hash(&self, password: &str) -> AppResult<String> {
        self.hasher.hash(password).map_err(AppError::Internal)
    }
}

fn validate_password(password: &str) -> AppResult<()> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::Validation(format!(
            "a senha deve ter ao menos {MIN_PASSWORD_LEN} caracteres"
        )));
    }
    Ok(())
}

fn ensure_assignable(role: Role) -> AppResult<()> {
    if !role.is_assignable() {
        return Err(AppError::Validation(
            "papel inválido: use viewer, operator ou admin".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::SystemClock;
    use crate::testkit::{FakeSessions, FakeUsers, PlainHasher};

    fn service() -> (UserService, Arc<FakeSessions>) {
        let sessions = Arc::new(FakeSessions::default());
        let service = UserService::new(
            Arc::new(FakeUsers::default()),
            sessions.clone(),
            Arc::new(PlainHasher),
            Arc::new(SystemClock),
            "Chefe",
        );
        (service, sessions)
    }

    fn input(name: &str, password: &str, role: Role) -> CreateUser {
        CreateUser {
            username: name.into(),
            password: password.into(),
            role,
        }
    }

    #[tokio::test]
    async fn cria_e_autentica() {
        let (service, _) = service();
        let user = service
            .create(input("Maria", "senha-forte", Role::Operator))
            .await
            .unwrap();
        assert_eq!(user.role, Role::Operator);
        assert_eq!(service.list().await.unwrap().len(), 1);
        let ok = service.authenticate("maria", "senha-forte").await.unwrap();
        assert_eq!(ok.unwrap().id, user.id);
        assert!(
            service
                .authenticate("maria", "errada")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            service
                .authenticate("joao", "senha-forte")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn rejeita_duplicado_nome_do_master_e_entradas_invalidas() {
        let (service, _) = service();
        service
            .create(input("maria", "senha-forte", Role::Viewer))
            .await
            .unwrap();
        for dup in ["MARIA", "Maria"] {
            let err = service
                .create(input(dup, "senha-forte", Role::Viewer))
                .await
                .unwrap_err();
            assert!(matches!(err, AppError::Conflict(_)), "{err:?}");
        }
        let err = service
            .create(input("chefe", "senha-forte", Role::Admin))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
        for bad in [
            input("ok-nome", "curta", Role::Viewer),
            input("a", "senha-forte", Role::Viewer),
            input("ok-nome", "senha-forte", Role::Master),
        ] {
            let err = service.create(bad).await.unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{err:?}");
        }
        assert_eq!(service.list().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn desativar_encerra_sessoes_e_impede_login() {
        let (service, sessions) = service();
        let user = service
            .create(input("maria", "senha-forte", Role::Admin))
            .await
            .unwrap();
        let updated = service
            .update(
                user.id,
                UpdateUser {
                    role: Some(Role::Viewer),
                    is_active: Some(false),
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.role, Role::Viewer);
        assert!(!updated.is_active);
        assert_eq!(sessions.closed_for.lock().unwrap().as_slice(), [user.id]);
        assert!(
            service
                .authenticate("maria", "senha-forte")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn nova_senha_troca_o_login_e_encerra_sessoes() {
        let (service, sessions) = service();
        let user = service
            .create(input("maria", "senha-forte", Role::Viewer))
            .await
            .unwrap();
        service
            .set_password(user.id, "outra-senha-1")
            .await
            .unwrap();
        assert!(
            service
                .authenticate("maria", "senha-forte")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            service
                .authenticate("maria", "outra-senha-1")
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(sessions.closed_for.lock().unwrap().len(), 1);
        let err = service.set_password(user.id, "curta").await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn remove_e_usuario_inexistente() {
        let (service, _) = service();
        let user = service
            .create(input("maria", "senha-forte", Role::Viewer))
            .await
            .unwrap();
        service.delete(user.id).await.unwrap();
        assert!(service.list().await.unwrap().is_empty());
        let err = service.delete(user.id).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        let err = service
            .update(user.id, UpdateUser::default())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
