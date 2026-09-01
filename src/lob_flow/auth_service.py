from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta
from uuid import uuid4

from lob_flow.database import Database
from lob_flow.models import AccountInvitation, AccountInvitationAccept, AccountInvitationCreate, AdminUserCreate, AdminUserUpdate, AuthSession, InitialAdminRegister, User, UserLogin, WorkspaceMember, WorkspaceMemberCreate, WorkspaceMemberUpdate
from lob_flow.service import NotFoundError, now


class AuthenticationError(Exception):
    pass


class PermissionDeniedError(Exception):
    pass


ROLE_RANK = {"viewer": 0, "editor": 1, "admin": 2, "owner": 3}


class AuthService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def create_user(self, request: AdminUserCreate) -> User:
        timestamp = now()
        email = self._normalize_email(request.email)
        salt = secrets.token_bytes(16)
        password_hash = self._password_hash(request.password, salt)
        with self.database.connect() as connection:
            exists = connection.execute("SELECT 1 FROM users WHERE LOWER(email) = %s", (email,)).fetchone()
            if exists:
                raise AuthenticationError("该邮箱已存在")
            user = User(id=str(uuid4()), name=request.name.strip(), email=email, is_super_admin=request.is_super_admin, status="active", created_at=timestamp, updated_at=timestamp)
            connection.execute(
                """INSERT INTO users
                   (id, name, email, password_hash, is_super_admin, status, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, 'active', %s, %s)""",
                (user.id, user.name, user.email, password_hash, user.is_super_admin, timestamp.isoformat(), timestamp.isoformat()),
            )
        return user

    def has_accounts(self) -> bool:
        with self.database.connect() as connection:
            row = connection.execute("SELECT EXISTS(SELECT 1 FROM users WHERE email IS NOT NULL) AS value").fetchone()
        return bool(row["value"])

    def initialize_first_admin(self, request: InitialAdminRegister) -> AuthSession:
        with self.database.connect() as connection:
            connection.execute("SELECT pg_advisory_xact_lock(9041986)")
            exists = connection.execute("SELECT EXISTS(SELECT 1 FROM users WHERE email IS NOT NULL) AS value").fetchone()
            if exists["value"]:
                raise PermissionDeniedError("平台已经完成初始化，请使用邀请链接注册")
            timestamp = now()
            email = self._normalize_email(request.email)
            user = User(id=str(uuid4()), name=request.name.strip(), email=email, is_super_admin=True, status="active", created_at=timestamp, updated_at=timestamp)
            password_hash = self._password_hash(request.password, secrets.token_bytes(16))
            connection.execute(
                """INSERT INTO users (id, name, email, password_hash, is_super_admin, status, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, TRUE, 'active', %s, %s)""",
                (user.id, user.name, user.email, password_hash, timestamp.isoformat(), timestamp.isoformat()),
            )
            token = f"lob-user-{secrets.token_urlsafe(32)}"
            self._insert_session(connection, user.id, token, timestamp)
        return AuthSession(user=user, token=token)

    def create_invitation(self, request: AccountInvitationCreate, invited_by: str) -> AccountInvitation:
        email = self._normalize_email(request.email)
        timestamp = now()
        expires_at = timestamp + timedelta(days=3)
        token = f"lob-invite-{secrets.token_urlsafe(32)}"
        with self.database.connect() as connection:
            if connection.execute("SELECT 1 FROM users WHERE LOWER(email) = %s", (email,)).fetchone():
                raise AuthenticationError("该邮箱已经拥有账户")
            item = AccountInvitation(id=str(uuid4()), email=email, name=request.name.strip(), is_super_admin=request.is_super_admin, expires_at=expires_at, created_at=timestamp, invite_token=token)
            connection.execute(
                """INSERT INTO account_invitations
                   (id, email, name, is_super_admin, token_hash, invited_by, expires_at, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (item.id, item.email, item.name, item.is_super_admin, self._hash(token), invited_by, expires_at.isoformat(), timestamp.isoformat()),
            )
        return item

    def get_invitation(self, token: str) -> AccountInvitation:
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT id, email, name, is_super_admin, expires_at, accepted_at, created_at
                   FROM account_invitations WHERE token_hash = %s""",
                (self._hash(token),),
            ).fetchone()
        if row is None or row["accepted_at"] or str(row["expires_at"]) <= now().isoformat():
            raise AuthenticationError("邀请链接无效或已过期")
        return AccountInvitation(**dict(row))

    def accept_invitation(self, request: AccountInvitationAccept) -> AuthSession:
        timestamp = now()
        with self.database.connect() as connection:
            connection.execute("SELECT pg_advisory_xact_lock(9041987)")
            row = connection.execute("SELECT * FROM account_invitations WHERE token_hash = %s FOR UPDATE", (self._hash(request.token),)).fetchone()
            if row is None or row["accepted_at"] or str(row["expires_at"]) <= timestamp.isoformat():
                raise AuthenticationError("邀请链接无效或已过期")
            if connection.execute("SELECT 1 FROM users WHERE LOWER(email) = %s", (str(row["email"]).lower(),)).fetchone():
                raise AuthenticationError("该邮箱已经拥有账户")
            user = User(id=str(uuid4()), name=request.name.strip(), email=str(row["email"]), is_super_admin=bool(row["is_super_admin"]), status="active", created_at=timestamp, updated_at=timestamp)
            password_hash = self._password_hash(request.password, secrets.token_bytes(16))
            connection.execute(
                """INSERT INTO users (id, name, email, password_hash, is_super_admin, status, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, 'active', %s, %s)""",
                (user.id, user.name, user.email, password_hash, user.is_super_admin, timestamp.isoformat(), timestamp.isoformat()),
            )
            connection.execute("UPDATE account_invitations SET accepted_at = %s WHERE id = %s", (timestamp.isoformat(), row["id"]))
            token = f"lob-user-{secrets.token_urlsafe(32)}"
            self._insert_session(connection, user.id, token, timestamp)
        return AuthSession(user=user, token=token)

    def ensure_super_admin(self, email: str, password: str, name: str = "平台管理员") -> User:
        normalized = self._normalize_email(email)
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM users WHERE LOWER(email) = %s", (normalized,)).fetchone()
        if row:
            user = self._user_from_row(row)
            if not user.is_super_admin:
                return self.update_user(user.id, AdminUserUpdate(is_super_admin=True), user.id)
            return user
        return self.create_user(AdminUserCreate(name=name, email=normalized, password=password, is_super_admin=True))

    def login(self, request: UserLogin) -> AuthSession:
        email = self._normalize_email(request.email)
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM users WHERE LOWER(email) = %s", (email,)).fetchone()
            if row is None or not row["password_hash"] or not self._verify_password(request.password, str(row["password_hash"])):
                raise AuthenticationError("邮箱或密码错误")
            if row["status"] != "active":
                raise PermissionDeniedError("账户已被停用")
            token = f"lob-user-{secrets.token_urlsafe(32)}"
            timestamp = now()
            self._insert_session(connection, str(row["id"]), token, timestamp)
        return AuthSession(user=self._user_from_row(row), token=token)

    def logout(self, authorization: str) -> None:
        if not authorization.startswith("Bearer "):
            return
        with self.database.connect() as connection:
            connection.execute("DELETE FROM user_sessions WHERE token_hash = %s", (self._hash(authorization[7:].strip()),))

    def authenticate(self, authorization: str) -> User:
        if not authorization.startswith("Bearer "):
            raise AuthenticationError("缺少管理端身份令牌")
        digest = self._hash(authorization[7:].strip())
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT users.* FROM user_sessions
                   JOIN users ON users.id = user_sessions.user_id
                   WHERE user_sessions.token_hash = %s AND user_sessions.expires_at > %s
                         AND users.email IS NOT NULL AND users.status = 'active'""",
                (digest, now().isoformat()),
            ).fetchone()
            if row:
                connection.execute(
                    """UPDATE user_sessions SET last_used_at = %s
                       WHERE token_hash = %s
                         AND (last_used_at IS NULL OR last_used_at < %s)""",
                    (
                        now().isoformat(),
                        digest,
                        (now() - timedelta(minutes=1)).isoformat(),
                    ),
                )
        if row is None:
            raise AuthenticationError("管理端身份令牌无效")
        return self._user_from_row(row)

    def add_owner(self, workspace_id: str, user_id: str) -> None:
        timestamp = now().isoformat()
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at)
                   VALUES (%s, %s, 'owner', %s, %s)""",
                (workspace_id, user_id, timestamp, timestamp),
            )

    def role_for(self, workspace_id: str, user_id: str) -> str | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT role FROM workspace_members WHERE workspace_id = %s AND user_id = %s",
                (workspace_id, user_id),
            ).fetchone()
        return str(row["role"]) if row else None

    def require(self, workspace_id: str, user_id: str, minimum: str) -> str:
        with self.database.connect() as connection:
            account = connection.execute("SELECT is_super_admin FROM users WHERE id = %s", (user_id,)).fetchone()
        if account and account["is_super_admin"]:
            return "owner"
        role = self.role_for(workspace_id, user_id)
        if role is None or ROLE_RANK[role] < ROLE_RANK[minimum]:
            raise PermissionDeniedError("没有访问当前 Workspace 的权限")
        return role

    def list_users(self) -> list[User]:
        with self.database.connect() as connection:
            rows = connection.execute("SELECT * FROM users WHERE email IS NOT NULL ORDER BY created_at").fetchall()
        return [self._user_from_row(row) for row in rows]

    def list_member_candidates(self, workspace_id: str) -> list[User]:
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT users.* FROM users
                   WHERE users.email IS NOT NULL AND users.status = 'active'
                   ORDER BY users.name, users.email""",
            ).fetchall()
        return [self._user_from_row(row) for row in rows]

    def update_user(self, user_id: str, request: AdminUserUpdate, actor_id: str) -> User:
        if user_id == actor_id and request.status == "disabled":
            raise PermissionDeniedError("不能停用当前超管账户")
        if user_id == actor_id and request.is_super_admin is False:
            raise PermissionDeniedError("不能取消当前账户的超级管理员权限")
        fields, params = [], []
        if request.is_super_admin is not None:
            fields.append("is_super_admin = %s"); params.append(request.is_super_admin)
        if request.status is not None:
            fields.append("status = %s"); params.append(request.status)
        if not fields:
            return self.get_user(user_id)
        params.extend([now().isoformat(), user_id])
        with self.database.connect() as connection:
            row = connection.execute(f"UPDATE users SET {', '.join(fields)}, updated_at = %s WHERE id = %s RETURNING *", tuple(params)).fetchone()
            if request.status == "disabled":
                connection.execute("DELETE FROM user_sessions WHERE user_id = %s", (user_id,))
        if row is None:
            raise NotFoundError("用户不存在")
        return self._user_from_row(row)

    def get_user(self, user_id: str) -> User:
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM users WHERE id = %s AND email IS NOT NULL", (user_id,)).fetchone()
        if row is None:
            raise NotFoundError("用户不存在")
        return self._user_from_row(row)

    def list_members(self, workspace_id: str) -> list[WorkspaceMember]:
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT member.workspace_id, member.user_id, users.name, users.email, member.role,
                          member.created_at, member.updated_at
                   FROM workspace_members member JOIN users ON users.id = member.user_id
                   WHERE member.workspace_id = %s ORDER BY member.created_at""",
                (workspace_id,),
            ).fetchall()
        return [WorkspaceMember(**dict(row)) for row in rows]

    def add_member(self, workspace_id: str, request: WorkspaceMemberCreate) -> WorkspaceMember:
        timestamp = now().isoformat()
        with self.database.connect() as connection:
            user = connection.execute("SELECT id FROM users WHERE id = %s", (request.user_id,)).fetchone()
            if user is None:
                raise NotFoundError("用户不存在，请确认用户 ID")
            connection.execute(
                """INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (workspace_id, user_id) DO UPDATE
                   SET role = EXCLUDED.role, updated_at = EXCLUDED.updated_at""",
                (workspace_id, request.user_id, request.role, timestamp, timestamp),
            )
        return next(item for item in self.list_members(workspace_id) if item.user_id == request.user_id)

    def update_member(self, workspace_id: str, user_id: str, request: WorkspaceMemberUpdate) -> WorkspaceMember:
        self._protect_last_owner(workspace_id, user_id, request.role)
        with self.database.connect() as connection:
            row = connection.execute(
                """UPDATE workspace_members SET role = %s, updated_at = %s
                   WHERE workspace_id = %s AND user_id = %s RETURNING user_id""",
                (request.role, now().isoformat(), workspace_id, user_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("Workspace 成员不存在")
        return next(item for item in self.list_members(workspace_id) if item.user_id == user_id)

    def remove_member(self, workspace_id: str, user_id: str) -> None:
        self._protect_last_owner(workspace_id, user_id, None)
        with self.database.connect() as connection:
            row = connection.execute(
                "DELETE FROM workspace_members WHERE workspace_id = %s AND user_id = %s RETURNING user_id",
                (workspace_id, user_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("Workspace 成员不存在")

    def resolve_workspace(self, path: str) -> str | None:
        parts = [part for part in path.split("/") if part]
        if len(parts) < 2 or parts[0] != "api":
            return None
        kind, resource_id = parts[1], parts[2] if len(parts) > 2 else ""
        if kind == "workspaces":
            return resource_id or None
        queries = {
            "apps": "SELECT workspace_id FROM apps WHERE id = %s",
            "runs": "SELECT apps.workspace_id FROM runs JOIN apps ON apps.id = runs.app_id WHERE runs.id = %s",
            "workflow-runs": "SELECT apps.workspace_id FROM workflow_runs JOIN apps ON apps.id = workflow_runs.app_id WHERE workflow_runs.id = %s",
            "datasets": "SELECT workspace_id FROM datasets WHERE id = %s",
            "documents": "SELECT datasets.workspace_id FROM dataset_documents JOIN datasets ON datasets.id = dataset_documents.dataset_id WHERE dataset_documents.id = %s",
            "segments": "SELECT datasets.workspace_id FROM document_segments JOIN datasets ON datasets.id = document_segments.dataset_id WHERE document_segments.id = %s",
        }
        query = queries.get(kind)
        if query is None or not resource_id:
            return None
        with self.database.connect() as connection:
            row = connection.execute(query, (resource_id,)).fetchone()
        return str(row["workspace_id"]) if row else None

    def _protect_last_owner(self, workspace_id: str, user_id: str, new_role: str | None) -> None:
        with self.database.connect() as connection:
            member = connection.execute(
                "SELECT role FROM workspace_members WHERE workspace_id = %s AND user_id = %s",
                (workspace_id, user_id),
            ).fetchone()
            owners = connection.execute(
                "SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = %s AND role = 'owner'",
                (workspace_id,),
            ).fetchone()
        if member and member["role"] == "owner" and new_role != "owner" and int(owners["count"]) <= 1:
            raise PermissionDeniedError("空间至少需要保留一名 Owner，请先将其他成员设为 Owner")

    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    @staticmethod
    def _normalize_email(email: str) -> str:
        value = email.strip().lower()
        if value.count("@") != 1 or value.startswith("@") or value.endswith("@"):
            raise AuthenticationError("邮箱格式不正确")
        return value

    @staticmethod
    def _password_hash(password: str, salt: bytes) -> str:
        digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
        return f"scrypt${salt.hex()}${digest.hex()}"

    @staticmethod
    def _verify_password(password: str, encoded: str) -> bool:
        try:
            algorithm, salt_hex, digest_hex = encoded.split("$", 2)
            if algorithm != "scrypt":
                return False
            actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=32)
            return hmac.compare_digest(actual.hex(), digest_hex)
        except (ValueError, TypeError):
            return False

    def _insert_session(self, connection, user_id: str, token: str, timestamp) -> None:
        connection.execute(
            """INSERT INTO user_sessions (id, user_id, token_hash, created_at, last_used_at, expires_at)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (str(uuid4()), user_id, self._hash(token), timestamp.isoformat(), timestamp.isoformat(), (timestamp + timedelta(days=7)).isoformat()),
        )

    @staticmethod
    def _user_from_row(row) -> User:
        values = dict(row)
        values.pop("password_hash", None)
        return User(**values)
