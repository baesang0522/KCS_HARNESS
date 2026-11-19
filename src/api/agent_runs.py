from uuid import UUID
from fastapi import APIRouter, Request
from services import agent_runs as service

router = APIRouter(prefix="/conversations/{conversation_id}/agent-runs", tags=["Agent"])


@router.get("")
async def current_run(conversation_id: UUID, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        run = conversation.agent_runs.get(conversation.active_agent_run_id)
        return {"run": service.public(run) if run else None}


@router.post("/{run_id}/advance")
async def advance(conversation_id: UUID, run_id: UUID, payload: service.Advance, request: Request):
    state = request.app.state
    cid = str(conversation_id)
    async with state.conversations.request(cid, str(payload.request_id)):
        async with state.conversations.edit(cid) as conversation:
            return await service.advance(conversation=conversation, conversation_id=cid, run_id=run_id,
                payload=payload, runtime=state.runtime, operation_jobs=state.operation_jobs, formula_jobs=state.formula_jobs)


@router.post("/{run_id}/bind")
async def bind(conversation_id: UUID, run_id: UUID, payload: service.BindJob, request: Request):
    state = request.app.state
    async with state.conversations.edit(str(conversation_id)) as conversation:
        return service.bind_job(conversation, run_id, payload, state.operation_jobs, state.formula_jobs, str(conversation_id))


@router.post("/{run_id}/pause")
async def pause(conversation_id: UUID, run_id: UUID, request: Request, payload: service.PauseRun | None = None):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        service.find_run(conversation, run_id)
        if conversation.active_agent_run_id == str(run_id):
            run = service.find_run(conversation, run_id)
            if run.status not in {"UNKNOWN", "CANCELLED"}:
                run.status = "PAUSED"
                run.answer = payload.message if payload and payload.message else "실행을 보류했습니다. 최신 값을 확인하고 채팅으로 이어가세요."
        return service.public(service.find_run(conversation, run_id))
