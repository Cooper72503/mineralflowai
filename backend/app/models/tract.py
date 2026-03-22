from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class Tract(BaseModel):
    id: str
    name: str
    county: Optional[str] = None
    state: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class TractCreate(BaseModel):
    name: str
    county: Optional[str] = None
    state: Optional[str] = None
