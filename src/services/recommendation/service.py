import hashlib

from services.errors import ConflictError, ModelProcessingError, NotFoundError
from services.recommendation.analysis import dumps, generate_advice
from services.recommendation.schemas import AdviceRequest


def resolve_columns(
    workspace: dict | None,
    ids: list[str] | None,
) -> list[str]:
    if not workspace:
        raise ValueError("먼저 작업 시트를 준비하세요.")

    known = [str(column["column_id"]) for column in workspace["columns"]]
    selected = known if ids is None else ids

    if not selected:
        raise ValueError("분석할 열이 없습니다.")
    if len(set(selected)) != len(selected):
        raise ValueError("분석 대상 열이 중복되었습니다.")
    if not set(selected) <= set(known):
        raise ValueError("현재 작업 표에 없는 열입니다.")

    return selected


async def process_recommendation(
    *,
    runtime,
    repository,
    payload: AdviceRequest,
) -> dict:
    cid = str(payload.conversation_id)
    rid = str(payload.request_id)
    digest = hashlib.sha256(
        dumps(payload.model_dump(mode="json")).encode("utf-8")
    ).hexdigest()

    async with repository.edit(cid) as conversation:
        turn = next(
            (item for item in conversation.turns if item.request_id == rid),
            None,
        )
        if turn is None:
            raise NotFoundError("원래 조언 요청을 찾을 수 없습니다.")

        previous = conversation.recommendation_hashes.get(rid)
        if previous is not None:
            if previous != digest:
                raise ConflictError(
                    "같은 요청 ID에 다른 분석 데이터가 전달됐습니다. "
                    "새 요청을 보내세요."
                )
        else:
            action = turn.ui_action or {}
            workspace = turn.request_context

            if action.get("type") != "analyze_data" or not workspace:
                raise ConflictError("전체 데이터 분석을 요청한 대화가 아닙니다.")
            if payload.column_ids != action["column_ids"]:
                raise ConflictError("요청한 분석 대상과 전달된 열이 다릅니다.")
            if (
                payload.worksheet_id != workspace["worksheet_id"]
                or payload.table_id != str(workspace["table_id"])
            ):
                raise ConflictError(
                    "요청한 작업 표와 전달된 작업 표가 다릅니다."
                )

            try:
                answer = await generate_advice(
                    runtime,
                    turn.question,
                    workspace,
                    payload,
                )
            except ValueError as error:
                raise ModelProcessingError(str(error)) from error
            except Exception as error:
                raise ModelProcessingError(
                    "전체 데이터 조언 생성에 실패했습니다."
                ) from error

            turn.answer = answer
            turn.reasoning = []
            turn.ui_action = None
            conversation.recommendation_hashes[rid] = digest

        return {
            "conversation_id": cid,
            "request_id": rid,
            "answer": turn.answer,
            "reasoning": turn.reasoning,
            "ui_action": turn.ui_action,
        }
