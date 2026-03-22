from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class OwnershipHistory(BaseModel):
    id: str
    tract_id: str
    owner_id: str
    document_id: Optional[str] = None
    effective_date: Optional[datetime] = None
    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class OwnershipHistoryCreate(BaseModel):
    tract_id: str
    owner_id: str
    document_id: Optional[str] = None
    effective_date: Optional[datetime] = None
    notes: Optional[str] = None
