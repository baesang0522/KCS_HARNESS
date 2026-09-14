from contextlib import asynccontextmanager
from uuid import uuid4

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from repositories.conversation_repository import (
    ConversationNotFound,
    StoredTurn,
    to_messages,
)


class PostgresConversation:
    def __init__(
        self,
        connection: AsyncConnection,
        conversation_id: str,
        turns: list[StoredTurn],
    ):
        self.connection = connection
        self.conversation_id = conversation_id
        self.turns = turns

    async def save_turn(self, turn: StoredTurn) -> None:
        await self.connection.execute(
            """
            INSERT INTO kcs_conversation_turns (
                conversation_id,
                request_id,
                question,
                answer,
                reasoning
            )
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                self.conversation_id,
                turn.request_id,
                turn.question,
                turn.answer,
                Jsonb(turn.reasoning),
            ),
        )

        self.turns.append(turn)


class PostgresConversationRepository:
    def __init__(self, connection_factory):
        self._connection_factory = connection_factory

    async def initialize(self) -> None:
        """최초 실행 시 필요한 테이블을 만든다."""
        async with self._connection_factory() as connection:
            await connection.execute(
                """
                CREATE TABLE IF NOT EXISTS kcs_conversations (
                    id UUID PRIMARY KEY,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )

            await connection.execute(
                """
                CREATE TABLE IF NOT EXISTS kcs_conversation_turns (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    conversation_id UUID NOT NULL
                        REFERENCES kcs_conversations(id),
                    request_id UUID NOT NULL,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    reasoning JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (conversation_id, request_id)
                )
                """
            )

            await connection.execute(
                """
                CREATE INDEX IF NOT EXISTS
                    kcs_conversation_turns_order_idx
                ON kcs_conversation_turns (conversation_id, id)
                """
            )

    async def create(self) -> str:
        conversation_id = str(uuid4())

        async with self._connection_factory() as connection:
            await connection.execute(
                """
                INSERT INTO kcs_conversations (id)
                VALUES (%s)
                """,
                (conversation_id,),
            )

        return conversation_id

    @asynccontextmanager
    async def edit(self, conversation_id: str):
        async with self._connection_factory() as connection:
            # 같은 대화의 요청은 DB에서도 순서대로 처리한다.
            cursor = await connection.execute(
                """
                SELECT id
                FROM kcs_conversations
                WHERE id = %s
                FOR UPDATE
                """,
                (conversation_id,),
            )

            if await cursor.fetchone() is None:
                raise ConversationNotFound(conversation_id)

            cursor = await connection.execute(
                """
                SELECT request_id, question, answer, reasoning
                FROM kcs_conversation_turns
                WHERE conversation_id = %s
                ORDER BY id
                """,
                (conversation_id,),
            )

            rows = await cursor.fetchall()

            turns = [
                StoredTurn(
                    request_id=str(row[0]),
                    question=row[1],
                    answer=row[2],
                    reasoning=row[3],
                )
                for row in rows
            ]

            yield PostgresConversation(
                connection=connection,
                conversation_id=conversation_id,
                turns=turns,
            )

    async def list_messages(self, conversation_id: str) -> list[dict]:
        async with self.edit(conversation_id) as conversation:
            return to_messages(conversation.turns)
