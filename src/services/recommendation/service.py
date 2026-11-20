from services.errors import SHARED_MESSAGES
import asyncio
import hashlib
import logging

from services.errors import ConflictError, ModelProcessingError, NotFoundError
from services.recommendation.analysis import generate_advice
from models.structured import dumps
from services.recommendation.selection import MODEL_GROUP_ROLES
from services.recommendation.schemas import AdviceRequest
from services.workspace import resolve_columns


def resolve_advice_subject(workspace: dict | None, ids: list[str] | None = None, subject: str | None = None) -> str | None:
    resolve_columns(workspace, ids)
    if workspace["task_type"] != "investigation":
        return "model" if workspace["task_type"] == "model_normalization" else "company"
    if subject is not None:
        if subject not in {"model", "company"}:
            raise ValueError("분석 주제가 올바르지 않습니다.")
        return subject
    selected = ids if ids is not None else workspace.get("target_column_ids", [])
    roles = {column.get("role") for column in workspace["columns"] if str(column["column_id"]) in selected}
    model = bool(roles & set(MODEL_GROUP_ROLES))
    company = bool(roles & {"company_name", "party_code", "country_code"})
    return ("model" if model else "company") if model != company else None


def resolve_advice_columns(workspace: dict | None, ids: list[str] | None) -> list[str]:
    selected = list(resolve_columns(workspace, ids))
    if workspace["task_type"] == "model_normalization" or (workspace["task_type"] == "investigation" and workspace.get("advice_subject") == "model"):
        for role in MODEL_GROUP_ROLES:
            columns = [column for column in workspace["columns"] if column.get("role") == role]
            if len(columns) != 1:
                raise ValueError(SHARED_MESSAGES["ADVICE_GROUP_COLUMNS_REQUIRED"])
            column_id = str(columns[0]["column_id"])
            if column_id not in selected:
                selected.append(column_id)
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
                    {**workspace, "advice_subject": action.get("advice_subject") or workspace.get("advice_subject")},
                    payload,
                    progress=lambda message: setattr(turn, "recommendation_progress", message),
                )
            except asyncio.CancelledError:
                turn.recommendation_progress = "요청을 중지했습니다."
                raise
            except ValueError as error:
                turn.recommendation_progress = "정제 의견 생성에 실패했습니다."
                raise ModelProcessingError(str(error)) from error
            except Exception as error:
                turn.recommendation_progress = "정제 의견 생성에 실패했습니다."
                logging.getLogger(__name__).exception("AI 조언 생성 실패: request_id=%s", rid)
                raise ModelProcessingError(
                    "전체 데이터 조언 생성에 실패했습니다."
                ) from error

            turn.answer = answer
            turn.reasoning = []
            turn.ui_action = None
            conversation.recommendation_hashes[rid] = digest
            turn.recommendation_progress = "정제 의견 작성이 완료됐습니다."

        return {
            "conversation_id": cid,
            "request_id": rid,
            "answer": turn.answer,
            "reasoning": turn.reasoning,
            "ui_action": turn.ui_action,
        }
