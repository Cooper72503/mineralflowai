from fastapi import APIRouter, HTTPException
from app.database import supabase
from app.models.ownership_history import OwnershipHistoryCreate

router = APIRouter()


@router.get("", response_model=list)
def list_ownership_history(tract_id: str | None = None):
    q = supabase.table("ownership_history").select("*").order("effective_date", desc=True)
    if tract_id:
        q = q.eq("tract_id", tract_id)
    res = q.execute()
    return res.data


@router.get("/{record_id}")
def get_ownership_record(record_id: str):
    res = supabase.table("ownership_history").select("*").eq("id", record_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Record not found")
    return res.data


@router.post("", response_model=dict)
def create_ownership_record(payload: OwnershipHistoryCreate):
    res = supabase.table("ownership_history").insert(payload.model_dump()).execute()
    return res.data[0] if res.data else {}
