import os
from contextlib import asynccontextmanager

from settings import StorageSettings


class PostgresDatabase:
    def __init__(self, settings: StorageSettings):
        self._conninfo = os.environ.get(settings.url_env, "").strip()

        if not self._conninfo:
            raise ValueError(
                f"환경변수 {settings.url_env}에 "
                "PostgreSQL 접속 정보를 설정하세요."
            )

    @asynccontextmanager
    async def connection(self):
        from psycopg import AsyncConnection

        async with await AsyncConnection.connect(
            self._conninfo,
            connect_timeout=10,
            application_name="kcs_harness",
        ) as connection:
            yield connection