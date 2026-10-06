from fastapi import APIRouter, HTTPException

from services.operations.schemas import OperationRequest, OperationResponse, ValueRequest
from services.operations.service import execute, value_catalog

router = APIRouter(prefix="/operations", tags=["operations"])


@router.post("/values")
def read_values(payload: ValueRequest):
    return value_catalog(payload.values)


@router.post("/preview", response_model=OperationResponse)
def preview_operation(payload: OperationRequest) -> OperationResponse:
    try:
        return execute(payload)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
