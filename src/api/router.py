from fastapi import APIRouter

from api.documents import router as documents_router
from api.chat import router as chat_router
from api.formula_jobs import router as formula_jobs_router
from api.operations import router as operations_router
from api.taskpane import router as taskpane_router
from api.operation_jobs import router as operation_jobs_router

router = APIRouter()
router.include_router(chat_router)
router.include_router(formula_jobs_router)
router.include_router(operations_router)
router.include_router(operation_jobs_router)
router.include_router(taskpane_router)

router.include_router(documents_router)
