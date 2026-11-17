//! Cifra da credencial Railway em repouso: XChaCha20-Poly1305 com o ID da credencial
//! como dado associado (impede trocar o ciphertext de linha) e `key_version` para rotação.

use application::ports::{CipherError, CredentialCipher, SealedSecret};
use application::railway::RailwayToken;
use chacha20poly1305::aead::{Aead, Generate, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use domain::ids::CredentialId;
use zeroize::Zeroizing;

/// Versão da chave atual; incrementar ao introduzir rotação.
pub const KEY_VERSION: i64 = 1;

pub struct XChaChaCipher {
    cipher: Option<XChaCha20Poly1305>,
}

impl XChaChaCipher {
    /// `None`: sem chave mestra; cifrar falha e o token armazenado fica indecifrável.
    pub fn new(master_key: Option<&[u8; 32]>) -> Self {
        Self {
            cipher: master_key
                .map(|key| XChaCha20Poly1305::new_from_slice(key).expect("chave de 32 bytes")),
        }
    }
}

impl CredentialCipher for XChaChaCipher {
    fn seal(&self, id: CredentialId, token: &RailwayToken) -> Result<SealedSecret, CipherError> {
        let cipher = self.cipher.as_ref().ok_or(CipherError::MissingKey)?;
        let nonce = XNonce::generate();
        let aad = id.to_string();
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: token.expose().as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| CipherError::Encrypt)?;
        Ok(SealedSecret {
            ciphertext,
            nonce: nonce.to_vec(),
            key_version: KEY_VERSION,
        })
    }

    fn open(&self, id: CredentialId, sealed: &SealedSecret) -> Result<RailwayToken, CipherError> {
        let cipher = self.cipher.as_ref().ok_or(CipherError::MissingKey)?;
        if sealed.key_version != KEY_VERSION {
            return Err(CipherError::Undecipherable);
        }
        let nonce =
            XNonce::try_from(sealed.nonce.as_slice()).map_err(|_| CipherError::Undecipherable)?;
        let aad = id.to_string();
        let plain = Zeroizing::new(
            cipher
                .decrypt(
                    &nonce,
                    Payload {
                        msg: &sealed.ciphertext,
                        aad: aad.as_bytes(),
                    },
                )
                .map_err(|_| CipherError::Undecipherable)?,
        );
        let text = std::str::from_utf8(&plain).map_err(|_| CipherError::Undecipherable)?;
        Ok(RailwayToken::new(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "railway-token-de-teste-123456";

    #[test]
    fn roundtrip() {
        let cipher = XChaChaCipher::new(Some(&[7; 32]));
        let id = CredentialId::new();
        let sealed = cipher.seal(id, &RailwayToken::new(TOKEN)).unwrap();
        assert_eq!(sealed.nonce.len(), 24);
        assert_eq!(cipher.open(id, &sealed).unwrap().expose(), TOKEN);
        // Nonce aleatório: duas cifragens diferem.
        assert_ne!(
            cipher
                .seal(id, &RailwayToken::new(TOKEN))
                .unwrap()
                .ciphertext,
            sealed.ciphertext
        );
    }

    #[test]
    fn chave_errada_e_indecifravel() {
        let id = CredentialId::new();
        let sealed = XChaChaCipher::new(Some(&[7; 32]))
            .seal(id, &RailwayToken::new(TOKEN))
            .unwrap();
        let other = XChaChaCipher::new(Some(&[8; 32]));
        assert_eq!(
            other.open(id, &sealed).unwrap_err(),
            CipherError::Undecipherable
        );
    }

    #[test]
    fn aad_impede_trocar_de_credencial() {
        let cipher = XChaChaCipher::new(Some(&[7; 32]));
        let sealed = cipher
            .seal(CredentialId::new(), &RailwayToken::new(TOKEN))
            .unwrap();
        assert_eq!(
            cipher.open(CredentialId::new(), &sealed).unwrap_err(),
            CipherError::Undecipherable
        );
    }

    #[test]
    fn sem_chave() {
        let cipher = XChaChaCipher::new(None);
        let id = CredentialId::new();
        assert_eq!(
            cipher.seal(id, &RailwayToken::new(TOKEN)).unwrap_err(),
            CipherError::MissingKey
        );
        let sealed = SealedSecret {
            ciphertext: vec![1],
            nonce: vec![0; 24],
            key_version: 1,
        };
        assert_eq!(
            cipher.open(id, &sealed).unwrap_err(),
            CipherError::MissingKey
        );
    }

    #[test]
    fn versao_desconhecida_e_indecifravel() {
        let cipher = XChaChaCipher::new(Some(&[7; 32]));
        let id = CredentialId::new();
        let mut sealed = cipher.seal(id, &RailwayToken::new(TOKEN)).unwrap();
        sealed.key_version = 2;
        assert_eq!(
            cipher.open(id, &sealed).unwrap_err(),
            CipherError::Undecipherable
        );
    }
}
