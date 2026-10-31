import time
import json
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from api.schemas import ChatRequest, ChatResponse
from repositories.conversation_repository import to_messages
from services.chat import process_chat, workflow_snapshot
from services.recommendation.schemas import AdviceRequest
from services.recommendation.service import process_recommendation

router = APIRouter()


def log_chat(event: str, *, level="INFO", **fields) -> None:
    print(
        json.dumps(
            {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "level": level,
                "event": event,
                **fields,
            },
            ensure_ascii=False,
            default=str,
        ),
        flush=True,
    )

@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/conversations")
async def create_conversation(request: Request):
    try:
        conversation_id = await request.app.state.conversations.create()
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"conversation_id": conversation_id}


@router.get("/conversations/{conversation_id}")
async def read_conversation(conversation_id: UUID, request: Request):
    cid = str(conversation_id)
    async with request.app.state.conversations.edit(cid) as conversation:
        return {
            "conversation_id": cid,
            "messages": to_messages(conversation.turns),
            "workflow": workflow_snapshot(
                conversation.workflow, request.app.state.formula_jobs,
            ),
        }


@router.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, request: Request):
    ids = {
        "conversation_id": str(payload.conversation_id),
        "request_id": str(payload.request_id),
        "endpoint": "/chat",
    }
    workspace = (
        payload.workspace.model_dump(mode="json")
        if payload.workspace else None
    )
    started = time.perf_counter()

    log_chat(
        "chat.received",
        **ids,
        message=payload.message,
        task_type=workspace.get("task_type") if workspace else None,
        has_workspace=workspace is not None,
        target_column_ids=(
            workspace.get("target_column_ids", [])
            if workspace else []
        ),
    )

    try:
        async with request.app.state.conversations.request(
            ids["conversation_id"], ids["request_id"]
        ):
            result = await process_chat(
                runtime=request.app.state.runtime,
                repository=request.app.state.conversations,
                formula_jobs=request.app.state.formula_jobs,
                operation_jobs=request.app.state.operation_jobs,
                conversation_id=ids["conversation_id"],
                request_id=ids["request_id"],
                message=payload.message,
                workspace=workspace,
            )
    except Exception as error:
        log_chat(
            "chat.failed",
            level="ERROR",
            **ids,
            error_type=type(error).__name__,
            error_message=str(error),
            elapsed_ms=round((time.perf_counter() - started) * 1000),
        )
        raise

    log_chat(
        "chat.completed",
        **ids,
        ui_action=result.get("ui_action"),
        answer=result["answer"],
        elapsed_ms=round((time.perf_counter() - started) * 1000),
    )
    return result


@router.post("/chat/recommendation", response_model=ChatResponse)
async def recommendation(payload: AdviceRequest, request: Request):
    ids = {
        "conversation_id": str(payload.conversation_id),
        "request_id": str(payload.request_id),
        "endpoint": "/chat/recommendation",
    }
    started = time.perf_counter()

    log_chat(
        "recommendation.received",
        **ids,
        column_ids=payload.column_ids,
        row_count=len(payload.rows),
    )

    try:
        async with request.app.state.conversations.request(
            ids["conversation_id"], ids["request_id"]
        ):
            result = await process_recommendation(
                runtime=request.app.state.runtime,
                repository=request.app.state.conversations,
                payload=payload,
            )
    except Exception as error:
        log_chat(
            "recommendation.failed",
            level="ERROR",
            **ids,
            error_type=type(error).__name__,
            error_message=str(error),
            elapsed_ms=round((time.perf_counter() - started) * 1000),
        )
        raise

    log_chat(
        "recommendation.completed",
        **ids,
        ui_action=result.get("ui_action"),
        answer=result["answer"],
        elapsed_ms=round((time.perf_counter() - started) * 1000),
    )
    return result


@router.post("/conversations/{conversation_id}/requests/{request_id}/cancel")
async def cancel_chat(conversation_id: UUID, request_id: UUID, request: Request):
    result = request.app.state.conversations.cancel_request(
        str(conversation_id), str(request_id)
    )
    job = request.app.state.formula_jobs.get(str(request_id))
    if (
        job is not None and job.source.conversation_id == conversation_id
        and job.approved_preview_id is None
        and job.status in {"CREATED", "PLANNING", "PREVIEW_READY", "NEEDS_INPUT"}
    ):
        job.status = "FAILED"
        job.error = "사용자가 수식 계획 생성을 중지했습니다."
        job.preview = None
    return result
