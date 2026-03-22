from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class Lead(BaseModel):
    id: str
    tract_id: Optional[str] = None
    owner_id: Optional[str] = None
    score: float = 0.0
    status: str = "new"
    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class LeadCreate(BaseModel):
    tract_id: Optional[str] = None
    owner_id: Optional[str] = None
    score: float = 0.0
    status: str = "new"
    notes: Optional[str] = None


class LeadUpdate(BaseModel):
    score: Optional[float] = None
    status: Optional[str] = None
    notes: Optional[str] = None
