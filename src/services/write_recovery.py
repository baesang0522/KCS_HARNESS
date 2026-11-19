"""현재 서버 실행 기록과 Excel의 읽기 전용 관찰을 대조한다."""
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from services.errors import ConflictError, NotFoundError
from services.operations.schemas import StrictModel, ColumnId
from services.formula.schemas import FormulaCompletion, range_bounds

Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class WriteBlock(StrictModel):
    row_start: int = Field(ge=0, lt=1048576)
    row_count: int = Field(ge=1, le=1048576)
    column_start: int = Field(ge=0, lt=16384)
    column_id: ColumnId | None = None
    before: Digest
    expected: Digest | None = None
    identities: Digest | None = None


class WriteEvidence(StrictModel):
    worksheet_id: ColumnId
    table_id: ColumnId | None = None
    identity_column_id: ColumnId | None = None
    blocks: list[WriteBlock] = Field(min_length=1)


class WriteObservation(StrictModel):
    values: list[Digest]
    identities: list[Digest | None]
    formulas: list[bool]
    # A manual conclusion is explicitly separate from a value comparison.
    conclusion: Literal["completed", "not_applied", "partial", "unknown"] | None = None
    note: str = Field(default="", max_length=8000)

    @model_validator(mode="after")
    def check_shape(self):
        if len(self.values) != len(self.identities) or len(self.values) != len(self.formulas):
            raise ValueError("확인한 범위 수가 다릅니다.")
        if self.conclusion and not self.note.strip():
            raise ValueError("직접 확인한 범위와 판단 근거를 적어 주세요.")
        return self


def find(state, kind, job_id, conversation_id):
    jobs = state.operation_jobs if kind == "operation" else state.formula_jobs
    job = jobs.get(str(job_id))
    if job is None or job.source.conversation_id != conversation_id:
        raise NotFoundError("이 대화의 실행 기록이 없습니다.")
    return job


def ensure_resolved(state, source, exclude=None):
    for jobs in (state.operation_jobs, state.formula_jobs):
        for key, job in jobs.items():
            if key != exclude and job.status in {"APPLYING", "UNKNOWN"} and job.source.worksheet_id == source.worksheet_id and getattr(job.source, "table_id", None) == getattr(source, "table_id", None):
                raise ConflictError("이 작업표의 이전 쓰기가 미확인 상태입니다. ‘쓰기 결과 확인’에서 결과를 확인한 뒤 진행하세요.")


def validate_evidence(job, kind, evidence):
    source = job.source
    if evidence.worksheet_id != source.worksheet_id or evidence.table_id != source.table_id:
        raise ConflictError("실행한 작업표와 확인 범위가 다릅니다.")
    if bool(evidence.table_id) != bool(evidence.identity_column_id):
        raise ConflictError("작업표의 행 식별 열을 확인하세요.")
    groups = {}
    for block in evidence.blocks:
        if block.row_start < source.row_start or block.row_start + block.row_count > source.row_start + source.row_count:
            raise ConflictError("실행 범위 밖의 쓰기 증거입니다.")
        if bool(evidence.table_id) != bool(block.column_id) or bool(evidence.table_id) != bool(block.identities):
            raise ConflictError("결과 열과 행 식별값이 필요합니다.")
        groups.setdefault((block.column_start, block.column_id), []).append(block)
    for blocks in groups.values():
        ordered = sorted(blocks, key=lambda b: b.row_start)
        if any(a.row_start + a.row_count > b.row_start for a, b in zip(ordered, ordered[1:])):
            raise ConflictError("확인 범위가 중복되었습니다.")
    ids = [key[1] for key in groups if key[1] is not None]
    if len(ids) != len(set(ids)):
        raise ConflictError("결과 열 ID가 중복되었습니다.")
    if kind == "operation":
        if not job.output:
            raise ConflictError("승인된 저장 위치가 없습니다.")
        if job.output.mode == "existing":
            if ids != [job.output.column_id]:
                raise ConflictError("승인한 기존 결과 열과 다릅니다.")
        elif set(ids) & set(source.operation.input_column_ids):
            raise ConflictError("새 결과는 입력과 다른 열이어야 합니다.")
        count = job.selected_count or source.row_count
        if any(sum(b.row_count for b in blocks) != count for blocks in groups.values()):
            raise ConflictError("미리보기와 쓰기 행 수가 다릅니다.")
        scopes = {tuple((b.row_start, b.row_count, b.identities) for b in blocks) for blocks in groups.values()}
        if len(scopes) != 1:
            raise ConflictError("결과 열의 행 범위가 서로 다릅니다.")
    else:
        if not job.preview or not job.approved_preview_id:
            raise ConflictError("승인된 수식 실행이 아닙니다.")
        actual = [(min(b.row_start for b in blocks) + 1, col + 1,
                   max(b.row_start + b.row_count for b in blocks), col + 1) for (col, _), blocks in groups.items()]
        expected = [range_bounds(action.target_range) for action in job.preview.plan.actions]
        if actual != expected or any(sum(b.row_count for b in blocks) != bounds[2] - bounds[0] + 1 for blocks, bounds in zip(groups.values(), expected)):
            raise ConflictError("승인된 수식 결과 범위와 다릅니다.")
        if set(ids) & {c.column_id for c in source.input_columns}:
            raise ConflictError("수식 결과 열은 입력 열과 달라야 합니다.")


def save_evidence(job, kind, evidence):
    if job.status != "APPLYING":
        raise ConflictError("적용 중인 실행만 쓰기 전 증거를 기록할 수 있습니다.")
    validate_evidence(job, kind, evidence)
    old = job.write_evidence
    if old:
        old = WriteEvidence.model_validate(old)
        comparable = lambda e: e.model_dump(exclude={"blocks": {"__all__": {"expected"}}})
        if comparable(old) != comparable(evidence) or any(a.expected is not None and a.expected != b.expected for a, b in zip(old.blocks, evidence.blocks)):
            raise ConflictError("이미 기록한 쓰기 증거를 바꿀 수 없습니다.")
    job.write_evidence = evidence.model_dump(mode="json")


def public(job, kind):
    return {"kind": kind, "job_id": str(getattr(job.source, kind + "_job_id")), "status": job.status,
            "conversation_id": str(job.source.conversation_id), "worksheet_id": job.source.worksheet_id, "evidence": job.write_evidence, "checks": job.write_checks}


def recover(job, kind, observation):
    terminal = job.status in {"APPLIED", "NOT_APPLIED"}
    if job.status not in {"APPLYING", "UNKNOWN", "APPLIED", "NOT_APPLIED"}:
        raise ConflictError("쓰기 시작 기록이 없는 실행입니다.")
    if terminal and job.write_checks:
        last = job.write_checks[-1]
        if all(last.get(key) == getattr(observation, key) for key in ("values", "identities", "formulas", "note")) and last["method"] == ("user" if observation.conclusion else "comparison") and (not observation.conclusion or last["result"] == observation.conclusion):
            return public(job, kind)
    evidence = WriteEvidence.model_validate(job.write_evidence) if job.write_evidence else None
    result = "unknown"
    if evidence and len(observation.values) == len(evidence.blocks):
        matches, unchanged = [], []
        for index, block in enumerate(evidence.blocks):
            identity = observation.identities[index] == block.identities
            matches.append(identity and block.expected is not None and observation.values[index] == block.expected and not observation.formulas[index])
            unchanged.append(identity and observation.values[index] == block.before and not observation.formulas[index])
        if all(matches): result = "completed"
        elif all(unchanged): result = "not_applied"
        elif any(matches) or any(observation.formulas): result = "partial"
    elif observation.values:
        raise ConflictError("기록된 출력 범위와 관찰 개수가 다릅니다.")
    automatic = result
    if observation.conclusion:
        if observation.conclusion == "completed" and any(observation.formulas):
            raise ConflictError("결과 범위에 수식이 남아 있어 값 저장 완료로 기록할 수 없습니다.")
        if result in {"completed", "not_applied"} and result != observation.conclusion:
            raise ConflictError("값 대조 결과와 다른 확인은 기록할 수 없습니다. 현재 값을 다시 확인하세요.")
        result = observation.conclusion
    job.write_checks.append({"at": datetime.now(timezone.utc).isoformat(), "result": result,
                             "comparison": automatic, "method": "user" if observation.conclusion else "comparison",
                             "note": observation.note, "values": observation.values,
                             "identities": observation.identities, "formulas": observation.formulas})
    if terminal:
        return public(job, kind)
    if result == "completed":
        # Without an identifiable output, a human note cannot manufacture a successful write receipt.
        if evidence is None:
            job.status = "UNKNOWN"
        else:
            ids = list(dict.fromkeys(b.column_id for b in evidence.blocks if b.column_id is not None))
            if kind == "operation": job.result_column_ids = ids
            else:
                targets = []
                for action in job.preview.plan.actions:
                    first, col, last, _ = range_bounds(action.target_range)
                    targets.append(dict(row_start=first-1, row_count=last-first+1, column_start=col-1))
                job.result = FormulaCompletion(targets=targets, result_column_ids=ids)
            job.status = "APPLIED"
    elif result == "not_applied": job.status = "NOT_APPLIED"
    else: job.status = "UNKNOWN"
    return public(job, kind)
