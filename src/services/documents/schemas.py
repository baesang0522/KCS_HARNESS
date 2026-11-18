from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class DocumentWorkspace(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workspace_id: UUID
    worksheet_id: str = Field(min_length=1, max_length=255)
    table_id: str = Field(min_length=1, max_length=255)
    sheet_name: str = Field(min_length=1, max_length=255)
    task_type: Literal["investigation", "model_normalization", "counterparty_cleanup"]


class DocumentLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_type: Literal["investigation", "model_normalization", "counterparty_cleanup"]
    workspace: DocumentWorkspace | None = None

    @model_validator(mode="after")
    def check_task(self):
        if self.workspace and self.workspace.task_type != self.task_type:
            raise ValueError("문서에 지정한 작업과 작업표의 종류가 다릅니다.")
        return self


class DocumentTable(BaseModel):
    headers: list[str]
    rows: list[list[str]]

    @model_validator(mode="after")
    def check_columns(self):
        if not self.headers or any(len(row) != len(self.headers) for row in self.rows):
            raise ValueError("표의 헤더와 데이터 열 수가 다릅니다. 빈 열도 유지해야 합니다.")
        return self


class DocumentPage(BaseModel):
    page_number: int = Field(ge=1)
    text: str
    readable: bool
    tables: list[DocumentTable] = Field(default_factory=list)


class ReferenceDocument(BaseModel):
    document_id: UUID
    filename: str
    pages: list[DocumentPage]
    link: DocumentLink | None = None

    def summary(self):
        return {
            "document_id": str(self.document_id), "filename": self.filename,
            "page_count": len(self.pages),
            "unreadable_pages": [page.page_number for page in self.pages if not page.readable],
            "link": self.link.model_dump(mode="json") if self.link else None,
        }
