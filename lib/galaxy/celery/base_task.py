import datetime

from celery import Task

from galaxy.model import CeleryUserRateLimit
from galaxy.model.scoped_session import galaxy_scoped_session


class GalaxyTaskBeforeStart:
    def __call__(self, task: Task, task_id, args, kwargs):
        pass


class GalaxyTaskUserRateLimitBeforeStart(GalaxyTaskBeforeStart):
    user_rate_limit: CeleryUserRateLimit

    def __init__(
        self,
        tasks_per_user_per_sec: float,
        user_rate_limit: CeleryUserRateLimit,
        ga_scoped_session: galaxy_scoped_session,
    ):
        self.user_rate_limit = user_rate_limit
        self.task_exec_countdown_secs = 1 / tasks_per_user_per_sec
        self.ga_scoped_session = ga_scoped_session

    def __call__(self, task: Task, task_id, args, kwargs):
        if task.request.retries > 0:
            return
        usr = kwargs.get("task_user_id")
        if not usr:
            return
        now = datetime.datetime.now()
        sa_session = None
        try:
            sa_session = self.ga_scoped_session
            next_scheduled_time = self.user_rate_limit.calculate_task_start_time(
                usr, sa_session, self.task_exec_countdown_secs, now
            )
        finally:
            if sa_session:
                sa_session.remove()
        if next_scheduled_time > now:
            count_down = next_scheduled_time - now
            task.retry(countdown=count_down.total_seconds())
