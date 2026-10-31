import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from uuid import uuid4

from services.chat_state import WorkFlowState
from services.errors import ConflictError


class ConversationNotFound(Exception):
    pass


@dataclass
class StoredTurn:
    request_id: str
    question: str
    answer: str
    reasoning: list[str]
    ui_action: dict | None = None
    request_context: dict | None = None


@dataclass
class MemoryConversation:
    turns: list[StoredTurn] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    workflow: WorkFlowState = field(default_factory=WorkFlowState)
    recommendation_hashes: dict[str, str] = field(default_factory=dict)
    active_requests: dict[str, asyncio.Task] = field(default_factory=dict)
    cancelled_requests: set[str] = field(default_factory=set)

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
    async def request(self, conversation_id: str, request_id: str):
        conversation = self._conversations.get(conversation_id)
        if conversation is None:
            raise ConversationNotFound(conversation_id)
        if request_id in conversation.cancelled_requests:
            raise ConflictError("중지한 요청입니다. 새 요청으로 보내세요.")
        if request_id in conversation.active_requests:
            raise ConflictError("같은 요청이 이미 처리 중입니다.")

        task = asyncio.current_task()
        conversation.active_requests[request_id] = task
        try:
            yield
        except asyncio.CancelledError:
            if request_id in conversation.cancelled_requests:
                raise ConflictError("사용자가 요청을 중지했습니다.") from None
            raise
        finally:
            conversation.active_requests.pop(request_id, None)

    def cancel_request(self, conversation_id: str, request_id: str):
        conversation = self._conversations.get(conversation_id)
        if conversation is None:
            raise ConversationNotFound(conversation_id)
        if request_id not in conversation.cancelled_requests:
            if len(conversation.cancelled_requests) >= 100:
                raise ConflictError("개발용 중지 기록 제한입니다. 새 대화를 시작하세요.")
            conversation.cancelled_requests.add(request_id)

        # 처리 중인 요청이 대화 잠금을 잡고 있으므로 취소 경로에서는 잠금을 기다리지 않는다.
        task = conversation.active_requests.get(request_id)
        if task is not None and not task.done() and not task.cancelling():
            task.cancel()
        for turn in conversation.turns:
            if turn.request_id == request_id:
                turn.answer = "사용자가 요청을 중지했습니다."
                turn.reasoning = []
                turn.ui_action = None
        return {"status": "cancelled"}

    @asynccontextmanager
    async def edit(self, conversation_id: str):
        conversation = self._conversations.get(conversation_id)
        if conversation is None:
            raise ConversationNotFound(conversation_id)
        async with conversation.lock:
            yield conversation


def to_messages(turns: list[StoredTurn]) -> list[dict]:
    messages = []

    for turn in turns:
        messages.extend([
            {"role": "user", "content": turn.question},
            {"role": "assistant", "content": turn.answer}
        ])
    return messages
