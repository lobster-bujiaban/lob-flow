from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter

from lob_flow.database import Database
from lob_flow.models import ScheduleTrigger, ScheduleTriggerCreate, ScheduleTriggerUpdate, WorkflowRun
from lob_flow.service import NotFoundError, now
from lob_flow.workflow import WorkflowValidationError
from lob_flow.workflow_service import WorkflowService


logger = logging.getLogger(__name__)


class ScheduleService:
    def __init__(self, database: Database, workflow_service: WorkflowService) -> None:
        self.database = database
        self.workflow_service = workflow_service

    def list(self, app_id: str) -> list[ScheduleTrigger]:
        self.workflow_service._get_app(app_id)
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM workflow_schedule_triggers WHERE app_id = %s ORDER BY created_at DESC",
                (app_id,),
            ).fetchall()
        return [ScheduleTrigger(**dict(row)) for row in rows]

    def create(self, app_id: str, request: ScheduleTriggerCreate) -> ScheduleTrigger:
        self.workflow_service._get_app(app_id)
        if request.enabled:
            self._require_published(app_id)
        timestamp = now()
        next_trigger_at = self._next_time(request.cron, request.timezone, timestamp) if request.enabled else None
        item = ScheduleTrigger(
            id=str(uuid4()), app_id=app_id, name=request.name, cron=request.cron,
            timezone=request.timezone, input=request.input, enabled=request.enabled, misfire_policy=request.misfire_policy,
            next_trigger_at=next_trigger_at, created_at=timestamp, updated_at=timestamp,
        )
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO workflow_schedule_triggers
                   (id, app_id, name, cron, timezone, input, enabled, misfire_policy, next_trigger_at, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (item.id, app_id, item.name, item.cron, item.timezone, item.input,
                 item.enabled, item.misfire_policy, item.next_trigger_at.isoformat() if item.next_trigger_at else None,
                 timestamp.isoformat(), timestamp.isoformat()),
            )
        return item

    def update(self, app_id: str, trigger_id: str, request: ScheduleTriggerUpdate) -> ScheduleTrigger:
        self._get(app_id, trigger_id)
        if request.enabled:
            self._require_published(app_id)
        timestamp = now()
        next_trigger_at = self._next_time(request.cron, request.timezone, timestamp) if request.enabled else None
        with self.database.connect() as connection:
            connection.execute(
                """UPDATE workflow_schedule_triggers
                   SET name = %s, cron = %s, timezone = %s, input = %s, enabled = %s, misfire_policy = %s,
                       next_trigger_at = %s, last_error = NULL, updated_at = %s
                   WHERE id = %s AND app_id = %s""",
                (request.name, request.cron, request.timezone, request.input, request.enabled, request.misfire_policy,
                 next_trigger_at.isoformat() if next_trigger_at else None, timestamp.isoformat(), trigger_id, app_id),
            )
        return self._get(app_id, trigger_id)

    def delete(self, app_id: str, trigger_id: str) -> None:
        self._get(app_id, trigger_id)
        with self.database.connect() as connection:
            connection.execute(
                "DELETE FROM workflow_schedule_triggers WHERE id = %s AND app_id = %s",
                (trigger_id, app_id),
            )

    def run_now(self, app_id: str, trigger_id: str) -> WorkflowRun:
        trigger = self._get(app_id, trigger_id)
        self._require_published(app_id)
        run_id, error = self._execute(trigger.model_dump())
        with self.database.connect() as connection:
            connection.execute(
                """UPDATE workflow_schedule_triggers
                   SET last_triggered_at = %s, last_run_id = %s, last_error = %s, updated_at = %s
                   WHERE id = %s""",
                (now().isoformat(), run_id, error, now().isoformat(), trigger_id),
            )
        if run_id is None:
            raise WorkflowValidationError([error or "定时工作流执行失败"])
        return self.workflow_service.get_run(run_id)

    def run_due(self, limit: int = 10) -> int:
        claimed: list[dict] = []
        current = now()
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT * FROM workflow_schedule_triggers
                   WHERE enabled = TRUE AND next_trigger_at IS NOT NULL AND next_trigger_at <= %s
                   ORDER BY next_trigger_at FOR UPDATE SKIP LOCKED LIMIT %s""",
                (current.isoformat(), limit),
            ).fetchall()
            for row in rows:
                values = dict(row)
                next_time = self._next_time(values["cron"], values["timezone"], current)
                scheduled_at = datetime.fromisoformat(str(values["next_trigger_at"]).replace("Z", "+00:00"))
                missed = (current - scheduled_at).total_seconds() > 60
                connection.execute(
                    """UPDATE workflow_schedule_triggers
                       SET last_triggered_at = CASE WHEN %s THEN last_triggered_at ELSE %s END,
                           next_trigger_at = %s, updated_at = %s
                       WHERE id = %s""",
                    (missed and values.get("misfire_policy", "skip") == "skip", current.isoformat(), next_time.isoformat(), current.isoformat(), values["id"]),
                )
                if not missed or values.get("misfire_policy", "skip") == "run_once":
                    claimed.append(values)
        for trigger in claimed:
            run_id, error = self._execute(trigger)
            with self.database.connect() as connection:
                connection.execute(
                    "UPDATE workflow_schedule_triggers SET last_error = %s, last_run_id = %s WHERE id = %s",
                    (error, run_id, trigger["id"]),
                )
        return len(claimed)

    def _execute(self, trigger: dict) -> tuple[str | None, str | None]:
        try:
            events = list(self.workflow_service.stream_run(
                trigger["app_id"], trigger["input"], "schedule", use_published=True,
            ))
            run_id = events[0].workflow_run_id if events else None
            if run_id is None:
                return None, "工作流未创建运行记录"
            run = self.workflow_service.get_run(run_id)
            return run_id, run.error if run.status == "failed" else None
        except Exception as exc:  # Worker must keep processing later schedules.
            logger.exception("Scheduled workflow %s failed", trigger["id"])
            return None, str(exc)[:2000]

    def _get(self, app_id: str, trigger_id: str) -> ScheduleTrigger:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM workflow_schedule_triggers WHERE id = %s AND app_id = %s",
                (trigger_id, app_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("Schedule trigger not found")
        return ScheduleTrigger(**dict(row))

    def _require_published(self, app_id: str) -> None:
        if self.workflow_service.get_latest_version(app_id) is None:
            raise WorkflowValidationError(["启用定时触发器前请先发布工作流"])

    @staticmethod
    def _next_time(expression: str, timezone_name: str, base: datetime) -> datetime:
        try:
            zone = ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as exc:
            raise WorkflowValidationError([f"无效时区：{timezone_name}"]) from exc
        if not croniter.is_valid(expression):
            raise WorkflowValidationError(["无效的 Cron 表达式"])
        local_base = base.astimezone(zone)
        return croniter(expression, local_base).get_next(datetime).astimezone(timezone.utc)


class ScheduleWorker:
    def __init__(self, service: ScheduleService, interval_seconds: float = 5) -> None:
        self.service = service
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="workflow-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=self.interval_seconds + 1)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.service.run_due()
            except Exception:
                logger.exception("Schedule worker polling failed")
            self._stop.wait(self.interval_seconds)
