import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from uuid import uuid4

from services.chat_state import WorkFlowState
from repositories.conversation_repository import (
    ConversationNotFound,
    StoredTurn,
    to_messages,
)


@dataclass
class MemoryConversation:
    turns: list[StoredTurn] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    workflow: WorkFlowState = field(default_factory=WorkFlowState)

    async def save_turn(self, turn: StoredTurn) -> None:
        self.turns.append(turn)


class MemoryConversationRepository:
    def __init__(self):
        self._conversations: dict[str, MemoryConversation] = {}

    async def create(self) -> str:
        if len(self._conversations) >= 100:
            raise ValueError("개발용 대화 개수 제한에 도달했습니다.")

        conversation_id = str(uuid4())
        self._conversations[conversation_id] = MemoryConversation()
        return conversation_id

    @asynccontextmanager
    async def edit(self, conversation_id: str):
        conversation = self._conversations.get(conversation_id)

        if conversation is None:
            raise ConversationNotFound(conversation_id)

        async with conversation.lock:
            yield conversation

    async def list_messages(self, conversation_id: str) -> list[dict]:
        async with self.edit(conversation_id) as conversation:
            return to_messages(conversation.turns)
