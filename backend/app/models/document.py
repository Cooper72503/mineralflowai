from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class Document(BaseModel):
    id: str
    name: str
    file_path: str
    tract_id: Optional[str] = None
    owner_id: Optional[str] = None
    extraction_status: str = "pending"
    created_at: datetime
    updated_at: datetime


class DocumentCreate(BaseModel):
    name: str
    file_path: str
    tract_id: Optional[str] = None
    owner_id: Optional[str] = None
