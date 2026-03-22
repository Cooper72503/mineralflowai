from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class DrillingPermit(BaseModel):
    id: str
    permit_number: str
    tract_id: Optional[str] = None
    county: Optional[str] = None
    state: Optional[str] = None
    status: str = "active"
    permit_date: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class DrillingPermitCreate(BaseModel):
    permit_number: str
    tract_id: Optional[str] = None
    county: Optional[str] = None
    state: Optional[str] = None
    status: str = "active"
    permit_date: Optional[datetime] = None
