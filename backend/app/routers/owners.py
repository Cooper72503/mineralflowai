from fastapi import APIRouter, HTTPException
from app.database import supabase
from app.models.owner import Owner, OwnerCreate

router = APIRouter()


@router.get("", response_model=list)
def list_owners():
    res = supabase.table("owners").select("*").execute()
    return res.data


@router.get("/{owner_id}")
def get_owner(owner_id: str):
    res = supabase.table("owners").select("*").eq("id", owner_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Owner not found")
    return res.data


@router.post("", response_model=dict)
def create_owner(payload: OwnerCreate):
    res = supabase.table("owners").insert(payload.model_dump()).execute()
    return res.data[0] if res.data else {}
