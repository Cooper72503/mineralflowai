from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class Owner(BaseModel):
    id: str
    name: str
    email: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class OwnerCreate(BaseModel):
    name: str
    email: Optional[str] = None
