from __future__ import annotations

import os

from cryptography.fernet import Fernet, InvalidToken


class CredentialEncryptionError(RuntimeError):
    pass


class CredentialCipher:
    def __init__(self, key: str) -> None:
        try:
            self.fernet = Fernet(key.encode("utf-8"))
        except (TypeError, ValueError) as exc:
            raise CredentialEncryptionError("LOB_FLOW_ENCRYPTION_KEY is invalid") from exc

    @classmethod
    def from_env(cls) -> "CredentialCipher":
        key = os.getenv("LOB_FLOW_ENCRYPTION_KEY")
        if not key:
            raise CredentialEncryptionError("LOB_FLOW_ENCRYPTION_KEY is not configured")
        return cls(key)

    def encrypt(self, plaintext: str) -> str:
        return self.fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")

    def decrypt(self, ciphertext: str) -> str:
        try:
            return self.fernet.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
        except InvalidToken as exc:
            raise CredentialEncryptionError("Stored model credential cannot be decrypted") from exc
