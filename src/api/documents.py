from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID

from fastapi import APIRouter, Query, Request

from services.documents.schemas import DocumentLink, ReferenceDocument
from services.documents.service import MAX_UPLOAD_BYTES, check_capacity, extract_in_process, find_document
from services.errors import ConflictError, DocumentError, NotFoundError

router = APIRouter(prefix="/conversations/{conversation_id}/documents", tags=["documents"])


@router.get("")
async def list_documents(conversation_id: UUID, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        return {"documents": [document.summary() for document in conversation.documents.values()]}


@router.post("/{document_id}")
async def upload_document(conversation_id: UUID, document_id: UUID, request: Request,
                          filename: str = Query(min_length=1, max_length=255)):
    repository = request.app.state.conversations
    cid, did = str(conversation_id), str(document_id)
    async with repository.request(cid, did):
        async with repository.edit(cid) as conversation:
            if did in conversation.documents:
                raise ConflictError("이미 처리한 첨부 요청입니다. 목록을 확인하세요.")
            check_capacity(conversation)
        name = filename.replace("\\", "/").rsplit("/", 1)[-1]
        if not name.lower().endswith(".pdf"):
            raise DocumentError("PDF 파일만 첨부할 수 있습니다.")
        with TemporaryDirectory(prefix="kcs-pdf-") as directory:
            source, output = Path(directory) / "source.pdf", Path(directory) / "text.json"
            size = 0
            with source.open("wb") as stream:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise DocumentError("PDF 파일은 최대 25MB까지 첨부할 수 있습니다.")
                    stream.write(chunk)
            with source.open("rb") as stream:
                if b"%PDF-" not in stream.read(1024):
                    raise DocumentError("PDF 파일의 내용을 확인할 수 없습니다.")
            pages = await extract_in_process(source, output, request.app.state.document_slots)
            document = ReferenceDocument(document_id=document_id, filename=name, pages=pages)
            async with repository.edit(cid) as conversation:
                if did in conversation.cancelled_requests:
                    raise ConflictError("사용자가 PDF 읽기를 중지했습니다.")
                if did in conversation.documents:
                    raise ConflictError("이미 처리한 첨부 요청입니다.")
                check_capacity(conversation, document)
                conversation.documents[did] = document
            return document.summary()


@router.get("/{document_id}/pages/{page_number}")
async def read_page(conversation_id: UUID, document_id: UUID, page_number: int, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        document = find_document(conversation, str(document_id))
        if not 1 <= page_number <= len(document.pages):
            raise NotFoundError("해당 PDF 페이지가 없습니다.")
        return document.pages[page_number - 1].model_dump()


@router.put("/{document_id}/link")
async def link_document(conversation_id: UUID, document_id: UUID, payload: DocumentLink, request: Request):
    async with request.app.state.conversations.edit(str(conversation_id)) as conversation:
        document = find_document(conversation, str(document_id))
        document.link = payload
        return document.summary()


@router.delete("/{document_id}")
async def delete_document(conversation_id: UUID, document_id: UUID, request: Request):
    repository = request.app.state.conversations
    # 삭제와 업로드 완료가 경합해도 뒤늦게 자료가 되살아나지 않게 같은 요청을 중지한다.
    repository.cancel_request(str(conversation_id), str(document_id))
    async with repository.edit(str(conversation_id)) as conversation:
        conversation.documents.pop(str(document_id), None)
    return {"status": "deleted"}
