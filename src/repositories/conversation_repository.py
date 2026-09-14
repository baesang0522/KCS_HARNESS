from dataclasses import dataclass


class ConversationNotFound(Exception):
    pass


@dataclass
class StoredTurn:
    request_id: str
    question: str
    answer: str
    reasoning: list[str]


def to_messages(turns: list[StoredTurn]) -> list[dict]:
    messages = []

    for turn in turns:
        messages.extend([
            {"role": "user", "content": turn.question},
            {"role": "assistant", "content": turn.answer}
        ])
    return messages
