import datetime
from abc import abstractmethod

from celery import Task
from sqlalchemy import (
    bindparam,
    insert,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import insert as ps_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from galaxy.model import CeleryUserRateLimit
from galaxy.model.base import transaction
from galaxy.model.scoped_session import galaxy_scoped_session


class GalaxyTaskBeforeStart:
    def __call__(self, task: Task, task_id, args, kwargs):
        pass


class GalaxyTaskBeforeStartUserRateLimit(GalaxyTaskBeforeStart):
    """
    Class used by the custom celery task, GalaxyTask, to implement
    logic to limit number of task executions per user per second.
    This superclass is used directly when no user rate limit logic
    is to be enforced based on value of config param,
    celery_user_rate_limit.
    """

    def __init__(
        self,
        tasks_per_user_per_sec: float,
        ga_scoped_session: galaxy_scoped_session,
    ):
        self.task_exec_countdown_secs = 1 / tasks_per_user_per_sec
        self.ga_scoped_session = ga_scoped_session

    def __call__(self, task: Task, task_id, args, kwargs):
        if task.request.retries > 0:
            return
        usr = kwargs.get("task_user_id")
        if not usr:
            return
        now = datetime.datetime.now()
        sa_session = self.ga_scoped_session
        with transaction(sa_session):
            next_scheduled_time = self.calculate_task_start_time(usr, sa_session, self.task_exec_countdown_secs, now)
            sa_session.commit()
        if next_scheduled_time > now:
            count_down = next_scheduled_time - now
            task.retry(countdown=count_down.total_seconds())

    @abstractmethod
    def calculate_task_start_time(
        self, user_id: int, sa_session: Session, task_interval_secs: float, now: datetime.datetime
    ) -> datetime.datetime:
        return now


class GalaxyTaskBeforeStartUserRateLimitPostgres(GalaxyTaskBeforeStartUserRateLimit):
    """
    Postgres specific implementation.
    """

    """
    Used when we wish to enforce a user rate limit based on
    celery_user_rate_limit config setting.
    The user_rate_limit constructor parameter is a class instance
    that implements logic specific to the type of database
    configured. i.e. For postgres we take advantage of efficiencies
    in its dialect.
    We limit executions by keeping track of the last scheduled
    time for the execution of a task by user. When a new task
    is to be executed we schedule it a certain time interval
    after the last scheduled execution of a task by this user
    by doing a task.retry.
    If the last scheduled execution was far enough in the past
    then we allow the task to run immediately.
    """

    _update_stmt = (
        update(CeleryUserRateLimit)
        .where(CeleryUserRateLimit.user_id == bindparam("userid"))
        .values(last_scheduled_time=text("greatest(last_scheduled_time + ':interval second', " ":now) "))
        .returning(CeleryUserRateLimit.last_scheduled_time)
    )

    _insert_stmt = (
        ps_insert(CeleryUserRateLimit)
        .values(user_id=bindparam("userid"), last_scheduled_time=bindparam("now"))
        .returning(CeleryUserRateLimit.last_scheduled_time)
    )

    _upsert_stmt = _insert_stmt.on_conflict_do_update(
        index_elements=["user_id"], set_=dict(last_scheduled_time=bindparam("sched_time"))
    )

    def calculate_task_start_time(  # type: ignore
        self, user_id: int, sa_session: Session, task_interval_secs: float, now: datetime.datetime
    ) -> datetime.datetime:
        result = sa_session.execute(self._update_stmt, {"userid": user_id, "interval": task_interval_secs, "now": now})
        print(f"rows updated: {result.rowcount}")
        if result.rowcount == 0:
            sched_time = now + datetime.timedelta(seconds=task_interval_secs)
            result = sa_session.execute(self._upsert_stmt, {"userid": user_id, "now": now, "sched_time": sched_time})
            print(f"schedtime: {sched_time}")
        for row in result:
            print(f"x: {row[0]!r}")
            return row[0]


class GalaxyTaskBeforeStartUserRateLimitStandard(GalaxyTaskBeforeStartUserRateLimit):
    """
    Generic but slower implementation supported by most databases
    """

    _select_stmt = (
        select(CeleryUserRateLimit.last_scheduled_time)
        .with_for_update(of=CeleryUserRateLimit.last_scheduled_time)
        .where(CeleryUserRateLimit.user_id == bindparam("userid"))
    )

    _update_stmt = (
        update(CeleryUserRateLimit)
        .where(CeleryUserRateLimit.user_id == bindparam("userid"))
        .values(last_scheduled_time=bindparam("sched_time"))
    )

    _insert_stmt = insert(CeleryUserRateLimit).values(
        user_id=bindparam("userid"), last_scheduled_time=bindparam("sched_time")
    )

    def calculate_task_start_time(
        self, user_id: int, sa_session: Session, task_interval_secs: float, now: datetime.datetime
    ) -> datetime.datetime:
        last_scheduled_time = sa_session.scalars(self._select_stmt, {"userid": user_id}).first()
        if last_scheduled_time:
            sched_time = last_scheduled_time + datetime.timedelta(seconds=task_interval_secs)
            if sched_time < now:
                sched_time = now
            sa_session.execute(self._update_stmt, {"userid": user_id, "sched_time": sched_time})
            print(f"schedtime: {sched_time}")
        else:
            try:
                sched_time = now
                sa_session.execute(self._insert_stmt, {"userid": user_id, "sched_time": sched_time})
            except IntegrityError:
                sched_time = now + datetime.timedelta(seconds=task_interval_secs)
                sa_session.execute(self._update_stmt, {"userid": user_id, "sched_time": sched_time})
        return sched_time
