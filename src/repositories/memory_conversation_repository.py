import asyncio
from dataclasses import dataclass, field
from uuid import uuid4


@dataclass
class StoredTurn:
    request_id: str
    question: str
    answer: str
    reasoning: list[str]


@dataclass
class Conversation:
    turns: list[StoredTurn] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class MemoryConversationRepository:
    def __init__(self):
        self._conversations: dict[str, Conversation] = {}

    def create(self) -> str:
        # 외부 개발용 메모리 사용량 제한
        if len(self._conversations) >= 100:
            raise ValueError("개발용 대화 개수 제한에 도달했습니다.")

        conversation_id = str(uuid4())
        self._conversations[conversation_id] = Conversation()
        return conversation_id

    def get(self, conversation_id: str) -> Conversation:
        conversation = self._conversations.get(conversation_id)

        if conversation is None:
            raise KeyError(conversation_id)

        return conversation

    def list_messages(self, conversation_id: str) -> list[dict]:
        conversation = self.get(conversation_id)
        messages = []

        for turn in conversation.turns:
            messages.append({
                "role": "user",
                "content": turn.question,
            })
            messages.append({
                "role": "assistant",
                "content": turn.answer,
            })

        return messages


